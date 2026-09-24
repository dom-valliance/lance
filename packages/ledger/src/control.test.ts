import { startPostgresContainer } from '@lance/db/testing';
import {
  SEED_PRINCIPAL_ID,
  createDb,
  principalState,
  principals,
  proposals,
  runMigrations,
  scopedDb,
  seed,
  systemState,
  type Db,
  type NewProposal,
} from '@lance/db';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ModeChangeRefusedError,
  SystemControl,
  liveModeOpensAt,
  type PauseResult,
  type ResumeResult,
} from './control.js';

/**
 * The kill switch against a real container (spec 4.3, non-negotiable 7).
 * Same setup as the ledger suite: a throwaway LOGIN role holding lance_app
 * and nothing else, because the api and the worker run the kill switch under
 * exactly that grant. The migrator seeds the global row and the seed
 * principal's run state; a second principal shows the scope (ADR 0015).
 */

const APP_ROLE = 'test_control_app';
const APP_PASSWORD = 'test';

const DOM = 'user:dom';
const OTHER_PRINCIPAL_ID = '01K5S9V6QW3SWCCPVB0N0E3Q7H';

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
let appRoot: Db;
let appDb: Db;
let otherControl: SystemControl;
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

  await app.query("SELECT set_config('app.principal', $1, false)", [SEED_PRINCIPAL_ID]);

  appRoot = createDb({ connectionString: appUri, password: APP_PASSWORD });
  migratorDb = createDb({
    connectionString: container.getConnectionUri(),
    password: container.getPassword(),
  });

  await seed(migratorDb);
  await migratorDb
    .insert(principals)
    .values({ id: OTHER_PRINCIPAL_ID, upn: 'second.principal@example.test' });
  await scopedDb(migratorDb, { principalId: OTHER_PRINCIPAL_ID }).insert(principalState).values({});

  appDb = scopedDb(appRoot, { principalId: SEED_PRINCIPAL_ID });
  control = new SystemControl(appDb);
  otherControl = new SystemControl(scopedDb(appRoot, { principalId: OTHER_PRINCIPAL_ID }));
});

afterAll(async () => {
  await appRoot?.$client.end();
  await migratorDb?.$client.end();
  await app?.end();
  await superuser?.end();
  await container?.stop();
});

describe('SystemControl.read', () => {
  it("returns the seeded principal's run state", async () => {
    const state = await control.read();

    expect(state.principalId).toBe(SEED_PRINCIPAL_ID);
    expect(state.pausedGlobally).toBe(false);
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

describe('SystemControl.setMode for a newly onboarded principal (multi-user M3)', () => {
  const NEWCOMER_ID = '01K5S9V6QW3SWCCPVB0N0E3N09';
  const ONBOARDING_ID = '01K5S9V6QW3SWCCPVB0N0E3N0A';
  // Monday 28 September 2026, 10:00 in London.
  const ACTIVATED_AT = new Date('2026-09-28T09:00:00.000Z');

  const controlAt = (principalId: string, now: string): SystemControl =>
    new SystemControl(scopedDb(appRoot, { principalId }), { now: () => new Date(now) });

  const modeOf = async (principalId: string): Promise<string> => {
    const rows = await migratorDb
      .select({ mode: principalState.mode })
      .from(principalState)
      .where(eq(principalState.principalId, principalId));
    return rows[0]?.mode ?? 'missing';
  };

  beforeAll(async () => {
    await migratorDb.insert(principals).values([
      {
        id: NEWCOMER_ID,
        upn: 'newcomer@example.test',
        status: 'active',
        activatedAt: ACTIVATED_AT,
      },
      { id: ONBOARDING_ID, upn: 'still.onboarding@example.test', status: 'onboarding' },
    ]);
    for (const principalId of [NEWCOMER_ID, ONBOARDING_ID]) {
      await scopedDb(migratorDb, { principalId }).insert(principalState).values({});
    }
  });

  it('opens live at London midnight five working days after activation', () => {
    expect(liveModeOpensAt(ACTIVATED_AT).toISOString()).toBe('2026-10-04T23:00:00.000Z');
  });

  it('refuses live inside the five working days and names the date it opens', async () => {
    const early = controlAt(NEWCOMER_ID, '2026-10-02T16:00:00.000Z');

    const refusal = await early
      .setMode('live', { actor: 'user:newcomer' })
      .catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(ModeChangeRefusedError);
    expect((refusal as Error).message).toContain('Live mode opens on Monday 5 October 2026');
    expect((refusal as Error).message).toContain('Monday 28 September 2026');
    expect(await modeOf(NEWCOMER_ID)).toBe('dry_run');
  });

  it('allows live once the five working days have passed', async () => {
    const later = controlAt(NEWCOMER_ID, '2026-10-05T07:00:00.000Z');

    const result = await later.setMode('live', { actor: 'user:newcomer' });

    expect(result.changed).toBe(true);
    expect(await modeOf(NEWCOMER_ID)).toBe('live');
  });

  it('always allows a switch back to dry run', async () => {
    const early = controlAt(NEWCOMER_ID, '2026-09-29T09:00:00.000Z');
    await early.setMode('dry_run', { actor: 'user:newcomer' });
    expect(await modeOf(NEWCOMER_ID)).toBe('dry_run');
  });

  it('refuses live to a principal who is still onboarding', async () => {
    const onboarding = controlAt(ONBOARDING_ID, '2027-01-04T09:00:00.000Z');

    await expect(onboarding.setMode('live', { actor: 'user:onboarding' })).rejects.toThrow(
      'Finish the onboarding checklist first',
    );
    expect(await modeOf(ONBOARDING_ID)).toBe('dry_run');
  });

  it('exempts the seed principal, who was never onboarded and has no activation time', async () => {
    const dom = controlAt(SEED_PRINCIPAL_ID, '2026-09-28T09:00:00.000Z');
    await dom.setMode('dry_run', { actor: DOM });
    const result = await dom.setMode('live', { actor: DOM });
    expect(await dom.read()).toMatchObject({ mode: 'live' });
    expect(result.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('SystemControl.setInterruptionBudget', () => {
  const budget = { quietHoursStart: '20:00', quietHoursEnd: '06:30', pushBudgetPerHour: 5 };

  it('stores the quiet hours and the push budget', async () => {
    const result = await control.setInterruptionBudget(budget, { actor: DOM });
    const state = await control.read();

    expect(result.changed).toBe(true);
    expect(state.quietHoursStart).toBe('20:00');
    expect(state.quietHoursEnd).toBe('06:30');
    expect(state.pushBudgetPerHour).toBe(5);
  });

  it('writes a state_changed event carrying the new budget', async () => {
    const result = await control.setInterruptionBudget(
      { ...budget, pushBudgetPerHour: 2 },
      { actor: DOM },
    );
    const event = await eventById(result.eventId);

    expect(event.kind).toBe('state_changed');
    expect(event.actor).toBe(DOM);
    expect(event.source_system).toBe('lance');
    expect(event.payload?.['change']).toBe('interruption_budget');
    expect(event.payload?.['quietHoursStart']).toBe('20:00');
    expect(event.payload?.['quietHoursEnd']).toBe('06:30');
    expect(event.payload?.['pushBudgetPerHour']).toBe(2);
  });

  it('reports no change when the budget is already the one asked for', async () => {
    const already = { ...budget, pushBudgetPerHour: 2 };
    const result = await control.setInterruptionBudget(already, { actor: DOM });

    expect(result.changed).toBe(false);
    const event = await eventById(result.eventId);
    expect(event.payload?.['change']).toBe('interruption_budget');
  });
});

describe('the kill switch across principals', () => {
  it("pauses one principal and leaves the other's run state alone", async () => {
    await control.pause({ reason: 'one principal', actor: DOM });
    try {
      expect(await control.isPaused()).toBe(true);
      expect(await otherControl.isPaused()).toBe(false);
    } finally {
      await control.resume({ actor: DOM });
    }
  });

  it('pauses every principal from the global row, and a principal resume does not lift it', async () => {
    const paused = await control.pauseAll({ reason: 'global drill', actor: DOM });
    try {
      expect(paused.changed).toBe(true);
      const [own, other] = [await control.read(), await otherControl.read()];
      expect([own.paused, own.pausedGlobally, own.pausedReason]).toEqual([
        true,
        true,
        'global drill',
      ]);
      expect([other.paused, other.pausedGlobally]).toEqual([true, true]);

      const underGlobal = await otherControl.resume({ actor: DOM });
      expect(underGlobal.releasedProposalIds).toEqual([]);
      expect(await otherControl.isPaused()).toBe(true);
    } finally {
      await control.resumeAll({ actor: DOM });
    }
    expect(await control.isPaused()).toBe(false);
    expect(await otherControl.isPaused()).toBe(false);
  });

  it('runs a principal live only when the global ceiling is live as well', async () => {
    await control.setMode('live', { actor: DOM });
    try {
      expect((await control.read()).mode).toBe('live');
      expect((await otherControl.read()).mode).toBe('dry_run');
      await migratorDb.update(systemState).set({ mode: 'dry_run' });
      expect((await control.read()).mode).toBe('dry_run');
    } finally {
      await migratorDb.update(systemState).set({ mode: 'live' });
      await control.setMode('dry_run', { actor: DOM });
    }
  });

  it("holds the caller's approved proposals on a global pause and releases them on their resume", async () => {
    const approvedId = await insertProposal('approved');
    await control.pauseAll({ reason: 'global hold', actor: DOM });
    expect(await statusOf(approvedId)).toBe('held');
    const early = await control.resume({ actor: DOM });
    expect(early.releasedProposalIds).toEqual([]);
    expect(await statusOf(approvedId)).toBe('held');
    await control.resumeAll({ actor: DOM });
    const resumed = await control.resume({ actor: DOM });
    expect(resumed.releasedProposalIds).toContain(approvedId);
    expect(await statusOf(approvedId)).toBe('approved');
  });
});

describe("the executor's hold against a racing resume", () => {
  it('never leaves a proposal held once the principal is running again', async () => {
    const liveOrNot = (state: { paused: boolean }): boolean => !state.paused;
    for (let round = 0; round < 15; round += 1) {
      const id = await insertProposal('approved');
      await control.pause({ reason: `race ${String(round)}`, actor: DOM });
      // The pause already held it; put it back as the executor would find a
      // proposal approved a moment after the pause.
      await appDb.update(proposals).set({ status: 'approved' }).where(eq(proposals.id, id));
      const [, hold] = await Promise.all([
        control.resume({ actor: DOM }),
        control.holdUnlessRunnable(
          { id, from: 'approved', current: ['approved', 'edited'] },
          { actor: 'agent:executor@0.1.0', reason: 'paused', runnable: liveOrNot },
        ),
      ]);
      const state = await control.read();
      expect(state.paused).toBe(false);
      // Either the hold committed before the resume read the ledger and the
      // resume released it, or the resume came first and nothing was held.
      expect({ round, held: hold.held, status: await statusOf(id) }).toMatchObject({
        round,
        status: 'approved',
      });
    }
  }, 60000);

  it('holds nothing once a resume has landed, so the executor goes on to the write', async () => {
    const id = await insertProposal('approved');
    const hold = await control.holdUnlessRunnable(
      { id, from: 'approved', current: ['approved', 'edited'] },
      { actor: 'agent:executor@0.1.0', reason: 'paused', runnable: () => true },
    );
    expect(hold).toEqual({ held: false, eventId: null });
    expect(await statusOf(id)).toBe('approved');
  });
});
