import { startPostgresContainer } from '@lance/db/testing';
import {
  SYSTEM_STATE_ID,
  createDb,
  proposals,
  runMigrations,
  seed,
  type Db,
  type NewProposal,
} from '@lance/db';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemControl, type PauseResult, type ResumeResult } from './control.js';

/**
 * The kill switch against a real container (spec 4.3, non-negotiable 7).
 * Same setup as the ledger suite: a throwaway LOGIN role holding lance_app
 * and nothing else, because the api and the worker run the kill switch under
 * exactly that grant. The migrator seeds the single system_state row.
 */

const APP_ROLE = 'test_control_app';
const APP_PASSWORD = 'test';

const DOM = 'user:dom';

interface LedgerEventShape {
  actor: string;
  kind: string;
  source_system: string | null;
  correlation_id: string;
  parent_event_id: string | null;
  payload: Record<string, unknown> | null;
}

let container: StartedPostgreSqlContainer;
let superuser: pg.Client;
let app: pg.Client;
let appDb: Db;
let migratorDb: Db;
let control: SystemControl;

const query = async <Row extends pg.QueryResultRow>(
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row[]> => {
  const result = await app.query<Row>(sql, [...values]);
  return result.rows;
};

const oneRow = async <Row extends pg.QueryResultRow>(
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row> => {
  const rows = await query<Row>(sql, values);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected exactly one row from: ${sql}`);
  }
  return row;
};

const eventById = async (id: string): Promise<LedgerEventShape> =>
  oneRow<LedgerEventShape>(
    `SELECT actor, kind, source_system, correlation_id, parent_event_id, payload
     FROM ledger_events WHERE id = $1`,
    [id],
  );

const statusOf = async (id: string): Promise<string> => {
  const row = await oneRow<{ status: string }>('SELECT status FROM proposals WHERE id = $1', [id]);
  return row.status;
};

/** The ids a payload carries, sorted, so an UPDATE's row order cannot matter. */
const sortedIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').sort()
    : [];

const insertProposal = async (status: NewProposal['status']): Promise<string> => {
  const id = newUlid();
  await appDb.insert(proposals).values({
    id,
    correlationId: newUlid(),
    actionClass: 'create_task',
    counterpartyClass: 'internal',
    targetSystem: 'notion',
    reversibility: 'compensatable',
    payload: { title: 'Write the follow-up note' },
    preview: 'Create a Notion task titled "Write the follow-up note"',
    rationale: 'Dom committed to a follow-up in the meeting',
    provenance: [
      {
        system: 'notion',
        recordId: 'page-1',
        hash: 'sha256:page-1',
        observedAt: '2026-09-20T09:00:00.000Z',
      },
    ],
    policyDecision: 'propose',
    status,
    expiresAt: new Date('2026-09-21T09:00:00.000Z'),
  });
  return id;
};

beforeAll(async () => {
  container = await startPostgresContainer();

  await runMigrations({ connectionString: container.getConnectionUri() });

  superuser = new pg.Client({ connectionString: container.getConnectionUri() });
  await superuser.connect();
  await superuser.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`);
  await superuser.query(`GRANT lance_app TO ${APP_ROLE}`);

  const appUri = `postgresql://${APP_ROLE}:${APP_PASSWORD}@${container.getHost()}:${String(
    container.getPort(),
  )}/${container.getDatabase()}`;

  app = new pg.Client({ connectionString: appUri });
  await app.connect();

  appDb = createDb({ connectionString: appUri, password: APP_PASSWORD });
  migratorDb = createDb({
    connectionString: container.getConnectionUri(),
    password: container.getPassword(),
  });

  await seed(migratorDb);

  control = new SystemControl(appDb);
});

afterAll(async () => {
  await appDb?.$client.end();
  await migratorDb?.$client.end();
  await app?.end();
  await superuser?.end();
  await container?.stop();
});

describe('SystemControl.read', () => {
  it('returns the seeded system_state row', async () => {
    const state = await control.read();

    expect(state.id).toBe(SYSTEM_STATE_ID);
    expect(state.paused).toBe(false);
    expect(state.pausedReason).toBeNull();
    expect(state.pausedBy).toBeNull();
    expect(state.pausedAt).toBeNull();
    expect(state.mode).toBe('dry_run');
    expect(state.quietHoursStart).toBe('19:00');
    expect(state.quietHoursEnd).toBe('07:00');
    expect(state.pushBudgetPerHour).toBe(3);
    expect(await control.isPaused()).toBe(false);
  });
});

describe('SystemControl.pause', () => {
  let pendingId: string;
  let approvedId: string;
  let editedId: string;
  let executedId: string;
  let result: PauseResult;

  beforeAll(async () => {
    pendingId = await insertProposal('pending');
    approvedId = await insertProposal('approved');
    editedId = await insertProposal('edited');
    executedId = await insertProposal('executed');

    result = await control.pause({ actor: DOM, reason: 'Graph token refresh is failing' });
  });

  it('reports the change and returns the ids it held', () => {
    expect(result.changed).toBe(true);
    expect([...result.heldProposalIds].sort()).toEqual([approvedId, editedId].sort());
  });

  it('moves every approved and edited proposal to held', async () => {
    expect(await statusOf(approvedId)).toBe('held');
    expect(await statusOf(editedId)).toBe('held');
  });

  it('leaves pending and executed proposals alone', async () => {
    expect(await statusOf(pendingId)).toBe('pending');
    expect(await statusOf(executedId)).toBe('executed');
  });

  it('records the pause, its reason, who paused and when', async () => {
    const state = await control.read();

    expect(state.paused).toBe(true);
    expect(state.pausedReason).toBe('Graph token refresh is failing');
    expect(state.pausedBy).toBe(DOM);
    expect(state.pausedAt).toBeInstanceOf(Date);
  });

  it('writes a state_changed event carrying the pause and the held ids', async () => {
    const event = await eventById(result.eventId);

    expect(event.kind).toBe('state_changed');
    expect(event.actor).toBe(DOM);
    expect(event.source_system).toBe('lance');
    expect(event.payload?.['change']).toBe('pause');
    expect(event.payload?.['paused']).toBe(true);
    expect(event.payload?.['reason']).toBe('Graph token refresh is failing');
    expect(sortedIds(event.payload?.['heldProposalIds'])).toEqual([approvedId, editedId].sort());
  });
});

describe('pausing an already paused system', () => {
  let result: PauseResult;

  beforeAll(async () => {
    result = await control.pause({ actor: 'system:cost-guard', reason: 'Cost spike' });
  });

  it('reports no change', () => {
    expect(result.changed).toBe(false);
  });

  it('leaves the first pause reason in place', async () => {
    const state = await control.read();

    expect(state.paused).toBe(true);
    expect(state.pausedReason).toBe('Graph token refresh is failing');
  });

  it('still writes a state_changed event', async () => {
    const event = await eventById(result.eventId);

    expect(event.kind).toBe('state_changed');
    expect(event.payload?.['change']).toBe('pause');
    expect(event.payload?.['alreadyPaused']).toBe(true);
  });
});

describe('SystemControl.resume', () => {
  let heldBeforeId: string;
  let approvedId: string;
  let editedId: string;
  let pauseEventId: string;
  let pauseCorrelationId: string;
  let result: ResumeResult;

  beforeAll(async () => {
    heldBeforeId = await insertProposal('held');
    approvedId = await insertProposal('approved');
    editedId = await insertProposal('edited');

    const pause = await control.pause({ actor: DOM, reason: 'Notion outage' });
    pauseEventId = pause.eventId;
    pauseCorrelationId = (await eventById(pauseEventId)).correlation_id;

    result = await control.resume({ actor: DOM });
  });

  it('clears the paused flag and everything recorded with it', async () => {
    const state = await control.read();

    expect(result.changed).toBe(true);
    expect(state.paused).toBe(false);
    expect(state.pausedReason).toBeNull();
    expect(state.pausedBy).toBeNull();
    expect(state.pausedAt).toBeNull();
  });

  it('releases the proposals the pause held and restores the status each had', async () => {
    expect(result.releasedProposalIds).toEqual(expect.arrayContaining([approvedId, editedId]));
    expect(await statusOf(approvedId)).toBe('approved');
    expect(await statusOf(editedId)).toBe('edited');
  });

  it('leaves a proposal that was already held before that pause held', async () => {
    expect(result.releasedProposalIds).not.toContain(heldBeforeId);
    expect(await statusOf(heldBeforeId)).toBe('held');
  });

  it('writes a state_changed event under the pause correlation id, pointing at the pause', async () => {
    const event = await eventById(result.eventId);

    expect(event.kind).toBe('state_changed');
    expect(event.correlation_id).toBe(pauseCorrelationId);
    expect(event.parent_event_id).toBe(pauseEventId);
    expect(event.payload?.['change']).toBe('resume');
    expect(event.payload?.['paused']).toBe(false);
    expect(sortedIds(event.payload?.['releasedProposalIds'])).toEqual(
      expect.arrayContaining([approvedId, editedId]),
    );
  });
});

describe('pausing twice before resuming', () => {
  let firstHeldId: string;
  let secondHeldId: string;
  let result: ResumeResult;

  beforeAll(async () => {
    firstHeldId = await insertProposal('approved');
    await control.pause({ actor: DOM, reason: 'first' });
    secondHeldId = await insertProposal('edited');
    await control.pause({ actor: DOM, reason: 'second' });
    result = await control.resume({ actor: DOM });
  });

  it('releases what both pauses held, so nothing is stranded', async () => {
    expect(result.releasedProposalIds).toEqual(expect.arrayContaining([firstHeldId, secondHeldId]));
    expect(await statusOf(firstHeldId)).toBe('approved');
    expect(await statusOf(secondHeldId)).toBe('edited');
  });
});

describe('resuming a system that is not paused', () => {
  it('reports no change and releases nothing', async () => {
    const result = await control.resume({ actor: DOM });

    expect(result.changed).toBe(false);
    expect(result.releasedProposalIds).toEqual([]);
    const event = await eventById(result.eventId);
    expect(event.payload?.['change']).toBe('resume');
    expect(event.payload?.['wasPaused']).toBe(false);
  });
});

describe('SystemControl.setMode', () => {
  it('flips the mode and records where it moved from and to', async () => {
    const result = await control.setMode('live', { actor: DOM });

    expect(result.changed).toBe(true);
    expect((await control.read()).mode).toBe('live');
    const event = await eventById(result.eventId);
    expect(event.kind).toBe('state_changed');
    expect(event.payload?.['change']).toBe('mode');
    expect(event.payload?.['from']).toBe('dry_run');
    expect(event.payload?.['to']).toBe('live');
  });

  it('reports no change when the mode is already the one asked for', async () => {
    const result = await control.setMode('live', { actor: DOM });

    expect(result.changed).toBe(false);
    const event = await eventById(result.eventId);
    expect(event.payload?.['from']).toBe('live');
    expect(event.payload?.['to']).toBe('live');
  });
});
