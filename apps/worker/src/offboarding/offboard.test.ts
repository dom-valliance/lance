import {
  createPrincipalSecretPurger,
  InMemorySecrets,
  type ChannelArchiveOutcome,
  type SlackChannelArchiver,
} from '@lance/connectors';
import {
  principalState,
  proposals,
  runMigrations,
  scopedDb,
  SEED_PRINCIPAL_ID,
  type Db,
} from '@lance/db';
import { openFixtureDb, openWorkerTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import { loadConfig, newUlid, type Config } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { offboardPrincipal, UnknownPrincipalError, type OffboardDeps } from './offboard.js';

/**
 * Offboarding a synthetic principal over a real database, logged in as the
 * worker's identity would be (a lance_app member that may SET ROLE
 * lance_retention), with fixture connectors: an in-memory vault and an
 * archiver that records what it was asked. No Azure or Slack call is made.
 */

const SYNTHETIC = '01K5S9V6QW3SWCCPVB0N0E3S01';
const SYNTHETIC_UPN = 'synthetic.offboard@valliance.ai';
const SYNTHETIC_CHANNEL = 'G0SYNTHETIC';
const DOM_CHANNEL = 'C0BU7P278N5';

let container: StartedPostgreSqlContainer;
let root: Db;
let fixture: Db;
let config: Config;

class RecordingArchiver implements SlackChannelArchiver {
  readonly asked: string[] = [];
  private readonly archived = new Set<string>();
  archive(channelId: string): Promise<ChannelArchiveOutcome> {
    this.asked.push(channelId);
    if (this.archived.has(channelId)) return Promise.resolve('already_archived');
    this.archived.add(channelId);
    return Promise.resolve('archived');
  }
}

const synthetic = (): Db => scopedDb(root, { principalId: SYNTHETIC });

/** Raw SQL as the fixture superuser, typed by the caller. */
const rowsOf = async <T>(text: string, values: unknown[] = []): Promise<T[]> =>
  (await fixture.$client.query(text, values)).rows as T[];

const payloadOf = (event: { payload: unknown }): Record<string, unknown> =>
  (event.payload ?? {}) as Record<string, unknown>;

const statusOf = async (id: string): Promise<string> => {
  const rows = await rowsOf<{ status: string }>('SELECT status FROM principals WHERE id = $1', [id]);
  return rows[0]?.status ?? 'missing';
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  root = await openWorkerTestDb(url);
  fixture = openFixtureDb(url);
  config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, DOM_EMAIL: 'dom@valliance.ai' });

  await fixture.$client.query(
    `INSERT INTO principals (id, entra_oid, upn, status, slack_channel_id)
     VALUES ($1, 'oid-synthetic', $2, 'active', $3)`,
    [SYNTHETIC, SYNTHETIC_UPN, SYNTHETIC_CHANNEL],
  );
  await fixture.$client.query(
    "INSERT INTO slack_links (slack_user_id, slack_team_id, principal_id) VALUES ('U0SYNTH', 'T0VALLIANCE', $1)",
    [SYNTHETIC],
  );
  await synthetic().insert(principalState).values({ mode: 'live' });

  const writer = new LedgerWriter(synthetic());
  const mail = await writer.append({
    ts: new Date().toISOString(),
    actor: 'agent:watcher-graph-mail@0.1.0',
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: 'AAMk-synthetic',
    sourceRecordHash: 'sha256:mail',
    idempotencyKey: 'graph:AAMk-synthetic:sha256:mail',
    correlationId: newUlid(),
    payload: { watcher: 'graph-mail', subject: 'Private', bodyText: 'A body that must go' },
  });
  await writer.append({
    ts: new Date().toISOString(),
    actor: 'agent:watcher-jamie@0.1.0',
    kind: 'observed',
    sourceSystem: 'jamie',
    sourceRecordId: 'jamie-synthetic',
    sourceRecordHash: 'sha256:jamie',
    idempotencyKey: 'jamie:jamie-synthetic:sha256:jamie',
    correlationId: newUlid(),
    payload: { watcher: 'jamie', transcript: 'Everything said in the meeting' },
  });
  await writer.append({
    ts: new Date().toISOString(),
    actor: 'agent:triage@1.0.0',
    kind: 'resolved',
    sourceSystem: 'lance',
    correlationId: newUlid(),
    payload: {
      kind: 'triage',
      commitments: [{ evidenceQuote: 'I will send it' }],
      observationEventIds: [mail.id],
    },
  });
  await synthetic()
    .insert(proposals)
    .values({
      id: newUlid(),
      correlationId: newUlid(),
      actionClass: 'draft_email',
      counterpartyClass: 'client',
      targetSystem: 'graph',
      targetRecordId: 'AAMk-synthetic',
      reversibility: 'compensatable',
      payload: {},
      preview: 'A reply',
      rationale: 'Asked for it',
      provenance: [],
      policyDecision: 'propose',
      status: 'approved',
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
});

afterAll(async () => {
  await root?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

const deps = (
  vault: InMemorySecrets | null,
  archiver: RecordingArchiver | null,
): OffboardDeps => ({
  root,
  config,
  secrets: vault === null ? null : createPrincipalSecretPurger(vault),
  channels: archiver,
});

describe('offboardPrincipal', () => {
  const vault = new InMemorySecrets({
    [`graph-refresh-token--${SYNTHETIC}`]: 'rt-synthetic',
    [`jamie-api-key--${SYNTHETIC}`]: 'jk-synthetic',
    [`graph-refresh-token--${SEED_PRINCIPAL_ID}`]: 'rt-dom',
  });
  const archiver = new RecordingArchiver();
  const request = { principalId: SYNTHETIC, actor: 'user:dom', reason: 'left Valliance' };

  it('runs every step in order and leaves no secret, link, channel or cached content', async () => {
    const ledgerBefore = await rowsOf<{ n: number }>('SELECT count(*)::int AS n FROM ledger_events WHERE principal_id = $1', [SYNTHETIC]);

    const result = await offboardPrincipal(deps(vault, archiver), request);

    expect(result.steps.map((step) => [step.step, step.outcome])).toEqual([
      ['status', 'done'],
      ['pause', 'done'],
      ['secrets', 'done'],
      ['slack_link', 'done'],
      ['slack_channel', 'done'],
      ['retention', 'done'],
    ]);
    expect(await statusOf(SYNTHETIC)).toBe('offboarded');
    const state = await synthetic().select().from(principalState);
    expect(state[0]?.paused).toBe(true);
    const held = await synthetic().select({ status: proposals.status }).from(proposals);
    expect(held.map((row) => row.status)).toEqual(['held']);

    expect(vault.has(`graph-refresh-token--${SYNTHETIC}`)).toBe(false);
    expect(vault.has(`jamie-api-key--${SYNTHETIC}`)).toBe(false);
    expect(vault.has(`graph-refresh-token--${SEED_PRINCIPAL_ID}`)).toBe(true);
    const links = await rowsOf<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM slack_links WHERE principal_id = $1', [SYNTHETIC]);
    expect(links).toEqual([{ revoked: true }]);
    expect(archiver.asked).toEqual([SYNTHETIC_CHANNEL]);

    const content = await rowsOf<{ kind: string; nulled: boolean }>(`SELECT kind::text, payload IS NULL AS nulled FROM ledger_events
        WHERE principal_id = $1
          AND (kind = 'observed' OR (kind = 'resolved' AND actor LIKE 'agent:triage@%'))
        ORDER BY id`, [SYNTHETIC]);
    expect(content.every((row) => row.nulled)).toBe(true);
    expect(content).toHaveLength(3);
    const observations = await rowsOf<{ nulled: boolean }>('SELECT payload IS NULL AS nulled FROM observations WHERE principal_id = $1', [SYNTHETIC]);
    expect(observations).toEqual([{ nulled: true }, { nulled: true }]);

    // Nothing was deleted from the ledger: every row is still there, plus the new events.
    const ledgerAfter = await rowsOf<{ n: number }>('SELECT count(*)::int AS n FROM ledger_events WHERE principal_id = $1', [SYNTHETIC]);
    expect(ledgerAfter[0]!.n).toBeGreaterThan(ledgerBefore[0]!.n);
  });

  it('records each step in the principal ledger, naming secrets and never their values', async () => {
    const events = await new LedgerReader(
      scopedDb(root, { principalId: SYNTHETIC, admin: true }),
    ).query({ kind: 'state_changed' });
    // The reader returns newest first.
    const steps = events
      .filter((event) => payloadOf(event)['change'] === 'offboarding_step')
      .reverse();
    expect(steps.map((event) => payloadOf(event)['step'])).toEqual([
      'status',
      'pause',
      'secrets',
      'slack_link',
      'slack_channel',
      'retention',
    ]);
    expect(steps.every((event) => event.actor === 'user:dom')).toBe(true);
    const serialised = JSON.stringify(steps);
    expect(serialised).toContain(`jamie-api-key--${SYNTHETIC}`);
    expect(serialised).not.toContain('jk-synthetic');
    expect(serialised).not.toContain('rt-synthetic');
    const retention = await new LedgerReader(synthetic()).query({ kind: 'retention_applied' });
    expect(retention.at(-1)?.payload).toMatchObject({
      trigger: 'offboarding',
      windows: { mailBodiesDays: 0, transcriptsDays: 0, modelLogsDays: 0 },
    });
  });

  it('finds every step already done when run again', async () => {
    const again = await offboardPrincipal(deps(vault, archiver), request);
    expect(again.steps.map((step) => [step.step, step.outcome])).toEqual([
      ['status', 'already_done'],
      ['pause', 'already_done'],
      ['secrets', 'already_done'],
      ['slack_link', 'already_done'],
      ['slack_channel', 'already_done'],
      ['retention', 'already_done'],
    ]);
  });

  it('never archives dom-claude-agent, and skips what the process cannot reach', async () => {
    const other = '01K5S9V6QW3SWCCPVB0N0E3S02';
    await fixture.$client.query(
      `INSERT INTO principals (id, upn, status, slack_channel_id) VALUES ($1, 'shared@valliance.ai', 'active', $2)`,
      [other, DOM_CHANNEL],
    );
    const watching = new RecordingArchiver();
    const result = await offboardPrincipal(
      { ...deps(null, watching) },
      { principalId: other, actor: 'user:dom', reason: 'test' },
    );
    expect(result.steps.find((step) => step.step === 'slack_channel')?.outcome).toBe('skipped');
    expect(result.steps.find((step) => step.step === 'secrets')?.outcome).toBe('skipped');
    expect(watching.asked).toEqual([]);
  });

  it('refuses a principal id nobody has', async () => {
    await expect(
      offboardPrincipal(deps(vault, archiver), {
        principalId: '01K5S9V6QW3SWCCPVB0N0E3ZZZ',
        actor: 'user:dom',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(UnknownPrincipalError);
  });
});
