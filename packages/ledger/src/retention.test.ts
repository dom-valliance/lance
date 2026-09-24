import { startPostgresContainer } from '@lance/db/testing';
import {
  createDb,
  grantRetentionMember,
  runMigrations,
  scopedDb,
  SEED_PRINCIPAL_ID,
  seed,
  type Db,
} from '@lance/db';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyRetention, RetentionRoleError, type RetentionWindows } from './retention.js';

/**
 * Retention as the worker runs it: a login role that is a member of
 * lance_app and, for SET ROLE only, of lance_retention, whose sessions act
 * as lance_app from the first statement (PG_ROLE). A second login role
 * holds lance_app alone, as the api and the web identities do. Fixture
 * rows are written by the superuser so their created_at can be set.
 */

const OTHER = '01K5S9V6QW3SWCCPVB0N0E3A01';
const NOW = '2026-09-24T02:30:00.000Z';
const DAY = 24 * 3600 * 1000;
const daysAgo = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString();

const WINDOWS: RetentionWindows = {
  mailBodiesDays: 90,
  transcriptsDays: 180,
  modelLogsDays: 30,
  ledgerDays: 730,
};
const MAIL_WATCHER = 'graph-mail';

let container: StartedPostgreSqlContainer;
let superuser: pg.Client;
let worker: Db;
let appOnly: Db;

const loginAs = (user: string): string => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = 'test';
  return url.toString();
};

/** A pool whose sessions start as lance_app, as the apps' do. */
const asLanceApp = (user: string): Db => {
  const previous = process.env['PG_ROLE'];
  process.env['PG_ROLE'] = 'lance_app';
  try {
    return createDb({ connectionString: loginAs(user), password: 'test' });
  } finally {
    if (previous === undefined) delete process.env['PG_ROLE'];
    else process.env['PG_ROLE'] = previous;
  }
};

interface Fixture {
  principal?: string;
  kind: string;
  actor?: string;
  sourceSystem?: string | null;
  payload: Record<string, unknown>;
  ageDays: number;
}

const insertEvent = async (fixture: Fixture): Promise<string> => {
  const id = newUlid();
  await superuser.query(
    `INSERT INTO ledger_events
       (id, principal_id, ts, actor, kind, source_system, correlation_id, payload, payload_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $1, $7, 'sha256:fixture', $3)`,
    [
      id,
      fixture.principal ?? SEED_PRINCIPAL_ID,
      daysAgo(fixture.ageDays),
      fixture.actor ?? 'watcher:test@0.1.0',
      fixture.kind,
      fixture.sourceSystem ?? null,
      JSON.stringify(fixture.payload),
    ],
  );
  if (fixture.kind === 'observed') {
    await superuser.query(
      `INSERT INTO observations
         (id, principal_id, ts, source_system, source_record_id, source_record_hash, idempotency_key, correlation_id, payload, created_at)
       VALUES ($1, $2, $3, $4, $6, 'h', $6, $1, $5, $3)`,
      [
        id,
        fixture.principal ?? SEED_PRINCIPAL_ID,
        daysAgo(fixture.ageDays),
        fixture.sourceSystem,
        JSON.stringify(fixture.payload),
        `record-${id}`,
      ],
    );
  }
  return id;
};

const payloadOf = async (id: string): Promise<unknown> =>
  (await superuser.query('SELECT payload FROM ledger_events WHERE id = $1', [id])).rows[0]?.payload;

const observationPayloadOf = async (id: string): Promise<unknown> =>
  (await superuser.query('SELECT payload FROM observations WHERE id = $1', [id])).rows[0]?.payload;

const mail = (ageDays: number, principal?: string): Fixture => ({
  kind: 'observed',
  sourceSystem: 'graph',
  payload: { watcher: MAIL_WATCHER, subject: 'Quarterly', bodyText: 'The raw body' },
  ageDays,
  ...(principal === undefined ? {} : { principal }),
});

beforeAll(async () => {
  container = await startPostgresContainer();
  await runMigrations({ connectionString: container.getConnectionUri() });
  superuser = new pg.Client({ connectionString: container.getConnectionUri() });
  await superuser.connect();
  const root = createDb({ connectionString: container.getConnectionUri(), password: 'postgres' });
  try {
    await seed(root);
    await superuser.query("CREATE ROLE retention_worker LOGIN PASSWORD 'test'");
    await superuser.query('GRANT lance_app TO retention_worker');
    await grantRetentionMember(root, 'retention_worker');
    await superuser.query("CREATE ROLE app_only LOGIN PASSWORD 'test'");
    await superuser.query('GRANT lance_app TO app_only');
  } finally {
    await root.$client.end();
  }
  await superuser.query(
    "INSERT INTO principals (id, upn, status) VALUES ($1, 'ann@valliance.ai', 'active')",
    [OTHER],
  );
  worker = asLanceApp('retention_worker');
  appOnly = asLanceApp('app_only');
});

afterAll(async () => {
  await worker?.$client.end();
  await appOnly?.$client.end();
  await superuser?.end();
  await container?.stop();
});

const run = (windows: RetentionWindows = WINDOWS, principal = SEED_PRINCIPAL_ID) =>
  applyRetention(scopedDb(worker, { principalId: principal }), {
    windows,
    trigger: 'nightly',
    mailWatcher: MAIL_WATCHER,
    now: () => NOW,
  });

describe('applyRetention as the worker identity', () => {
  beforeEach(async () => {
    // Earlier cases' events stay; each case asserts on the rows it made.
    await run();
  });

  it('nulls a mail body past 90 days and its observations row, and keeps the hash', async () => {
    const old = await insertEvent(mail(91));
    const recent = await insertEvent(mail(89));
    const calendar = await insertEvent({
      kind: 'observed',
      sourceSystem: 'graph',
      payload: { watcher: 'graph-calendar', subject: 'Standup' },
      ageDays: 200,
    });

    const result = await run();

    expect(result.counts.mailBodies).toBe(1);
    expect(await payloadOf(old)).toBeNull();
    expect(await observationPayloadOf(old)).toBeNull();
    expect(await payloadOf(recent)).not.toBeNull();
    expect(await payloadOf(calendar)).not.toBeNull();
    const hash = await superuser.query('SELECT payload_hash FROM ledger_events WHERE id = $1', [
      old,
    ]);
    expect(hash.rows[0]?.payload_hash).toBe('sha256:fixture');
  });

  it('nulls transcripts at 180 days and the triage quotes derived from each source at its window', async () => {
    const transcript = await insertEvent({
      kind: 'observed',
      sourceSystem: 'jamie',
      payload: { transcript: 'Everything said' },
      ageDays: 181,
    });
    const youngTranscript = await insertEvent({
      kind: 'observed',
      sourceSystem: 'jamie',
      payload: { transcript: 'Still inside the window' },
      ageDays: 100,
    });
    const mailSource = await insertEvent(mail(95));
    const triage = (sources: string[], ageDays: number): Fixture => ({
      kind: 'resolved',
      actor: 'agent:triage@1.0.0',
      sourceSystem: 'lance',
      payload: {
        kind: 'triage',
        commitments: [{ evidenceQuote: 'I will send it Friday' }],
        observationEventIds: sources,
      },
      ageDays,
    });
    const fromTranscript = await insertEvent(triage([transcript], 181));
    const fromYoungTranscript = await insertEvent(triage([youngTranscript], 100));
    const fromMail = await insertEvent(triage([mailSource], 95));

    const result = await run();

    expect(result.counts).toMatchObject({
      transcripts: 1,
      derivedFromTranscripts: 1,
      derivedFromMail: 1,
    });
    expect(await payloadOf(transcript)).toBeNull();
    expect(await payloadOf(fromTranscript)).toBeNull();
    expect(await payloadOf(fromMail)).toBeNull();
    // A quote from a transcript Lance still holds stays as long as the transcript.
    expect(await payloadOf(youngTranscript)).not.toBeNull();
    expect(await payloadOf(fromYoungTranscript)).not.toBeNull();
  });

  it("nulls model logs at 30 days: an agent's rejected output and a run's error text", async () => {
    const rejected = await insertEvent({
      kind: 'failed',
      actor: 'agent:triage@1.0.0',
      sourceSystem: 'lance',
      payload: { reason: 'schema_validation', issue: 'expected string' },
      ageDays: 31,
    });
    const executorFailure = await insertEvent({
      kind: 'failed',
      actor: 'agent:executor@0.1.0',
      sourceSystem: 'lance',
      payload: { reason: 'target_changed' },
      ageDays: 31,
    });
    const runId = newUlid();
    await superuser.query(
      `INSERT INTO agent_runs (id, principal_id, agent, version, model, started_at, status, error)
       VALUES ($1, $2, 'triage', '1.0.0', 'claude-sonnet-5', $3, 'failed', 'output did not match')`,
      [runId, SEED_PRINCIPAL_ID, daysAgo(31)],
    );

    const result = await run();

    expect(result.counts).toMatchObject({ modelLogs: 1, agentRunErrors: 1 });
    expect(await payloadOf(rejected)).toBeNull();
    expect(await payloadOf(executorFailure)).not.toBeNull();
    const errors = await superuser.query('SELECT error FROM agent_runs WHERE id = $1', [runId]);
    expect(errors.rows[0]?.error).toBeNull();
  });

  it("nulls every payload at the ledger window except the ontology's recorded mutations", async () => {
    const state = await insertEvent({
      kind: 'state_changed',
      sourceSystem: 'lance',
      payload: { change: 'pause', reason: 'holiday' },
      ageDays: 731,
    });
    const mutation = await insertEvent({
      kind: 'resolved',
      sourceSystem: 'lance',
      payload: { kind: 'ontology_mutation', cypher: 'MERGE (n:Person {id: $id})', params: {} },
      ageDays: 800,
    });

    const result = await run();

    expect(result.counts.ledgerPayloads).toBe(1);
    expect(await payloadOf(state)).toBeNull();
    expect(await payloadOf(mutation)).not.toBeNull();
  });

  it('records a retention_applied event with the counts, and a repeat finds nothing', async () => {
    await insertEvent(mail(120));
    const first = await run();
    const second = await run();

    expect(first.counts.mailBodies).toBe(1);
    expect(Object.values(second.counts).every((count) => count === 0)).toBe(true);
    const events = await superuser.query(
      `SELECT actor, principal_id, payload FROM ledger_events WHERE id = ANY($1::text[])`,
      [[first.eventId, second.eventId]],
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]).toMatchObject({
      actor: 'system:retention',
      principal_id: SEED_PRINCIPAL_ID,
      payload: { trigger: 'nightly', windows: WINDOWS },
    });
  });

  it("leaves another principal's rows alone", async () => {
    const annsMail = await insertEvent(mail(200, OTHER));
    await run();
    expect(await payloadOf(annsMail)).not.toBeNull();

    await run(WINDOWS, OTHER);
    expect(await payloadOf(annsMail)).toBeNull();
  });

  it('nulls everything in the three classes with zero-day windows, as offboarding runs it', async () => {
    const today = await insertEvent(mail(0.01));
    const result = await run({ ...WINDOWS, mailBodiesDays: 0, transcriptsDays: 0, modelLogsDays: 0 });
    expect(result.counts.mailBodies).toBeGreaterThanOrEqual(1);
    expect(await payloadOf(today)).toBeNull();
  });

  it('refuses a session whose identity is not a member of lance_retention, and changes nothing', async () => {
    const old = await insertEvent(mail(300));
    await expect(
      applyRetention(scopedDb(appOnly, { principalId: SEED_PRINCIPAL_ID }), {
        windows: WINDOWS,
        trigger: 'nightly',
        mailWatcher: MAIL_WATCHER,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(RetentionRoleError);
    expect(await payloadOf(old)).not.toBeNull();
  });
});

describe('an ordinary worker session', () => {
  it('still cannot null a payload without the retention transaction', async () => {
    const old = await insertEvent(mail(300));
    const failure = await scopedDb(worker, { principalId: SEED_PRINCIPAL_ID })
      .$client.query('UPDATE ledger_events SET payload = NULL WHERE id = $1', [old])
      .then(() => null)
      .catch((error: unknown) => (error as { code?: string }).code);
    expect(failure).toBe('42501');
  });
});
