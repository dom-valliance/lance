import type { GraphReads, MailboxSettings } from '@lance/connectors';
import {
  ledgerEvents,
  principalState,
  principals,
  runMigrations,
  scopedDb,
  type Db,
  type Principal,
} from '@lance/db';
import { openAppTestDb, openFixtureDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectorBundle, ConnectorLookup, GraphBundle } from '../jobs/connectors.js';
import { preferencesFromMailbox, runOnboardingPrefill } from './prefill.js';

/**
 * Onboarding step 6's prefill (docs/plans/multi-user.md M3). The sweep
 * runs against a real database as a member of lance_app, as the worker
 * does, with a fake Graph read in place of the principal's mailbox.
 */

const NEW_YORK_HOURS: MailboxSettings = {
  timeZone: 'Eastern Standard Time',
  workingHours: {
    daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    startTime: '08:30:00.0000000',
    endTime: '17:30:00.0000000',
    timeZone: { name: 'Eastern Standard Time' },
  },
};

describe('preferencesFromMailbox', () => {
  it('turns the working day into quiet hours and a Windows zone into an IANA one', () => {
    expect(preferencesFromMailbox(NEW_YORK_HOURS)).toEqual({
      timeZone: 'America/New_York',
      mailboxTimeZone: 'Eastern Standard Time',
      quietHoursStart: '17:30',
      quietHoursEnd: '08:30',
      fromWorkingHours: true,
    });
  });

  it('keeps the default quiet hours when the mailbox names no working hours', () => {
    expect(preferencesFromMailbox({ timeZone: 'Europe/London' })).toEqual({
      timeZone: 'Europe/London',
      mailboxTimeZone: 'Europe/London',
      quietHoursStart: '19:00',
      quietHoursEnd: '07:00',
      fromWorkingHours: false,
    });
  });

  it('leaves the time zone unset when Graph names one Lance cannot place', () => {
    expect(preferencesFromMailbox({ timeZone: 'Customized Time Zone' }).timeZone).toBeNull();
  });
});

let container: StartedPostgreSqlContainer;
let root: Db;
let fixture: Db;
let reads: MailboxSettings | Error;
let calls: string[];

const connectorsFor: ConnectorLookup = (principal) => {
  calls.push(principal.id);
  const graph = {
    reads: {
      getMailboxSettings: () =>
        reads instanceof Error ? Promise.reject(reads) : Promise.resolve(reads),
    } as unknown as GraphReads,
    writers: {} as GraphBundle['writers'],
  };
  const bundle: ConnectorBundle = {
    graph,
    notion: null,
    jamie: null,
    slack: null,
    agentLogs: null,
    notConnected: [],
  };
  return Promise.resolve(bundle);
};

const sweep = () =>
  runOnboardingPrefill({
    root,
    connectorsFor,
    now: () => '2026-09-28T09:00:00.000Z',
    log: () => {},
  });

const createPrincipal = async (status: Principal['status']): Promise<string> => {
  const id = newUlid();
  await fixture
    .insert(principals)
    .values({ id, entraOid: `oid-${id}`, upn: `p.${id.toLowerCase()}@valliance.ai`, status });
  return id;
};

const record = async (principalId: string, payload: Record<string, unknown>): Promise<void> => {
  await new LedgerWriter(scopedDb(root, { principalId })).append({
    ts: '2026-09-28T08:00:00.000Z',
    actor: 'user:newcomer',
    kind: 'state_changed',
    sourceSystem: 'graph',
    correlationId: newUlid(),
    payload,
  });
};

const readEvents = async (principalId: string) =>
  fixture
    .select({ actor: ledgerEvents.actor, payload: ledgerEvents.payload })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.principalId, principalId),
        sql`${ledgerEvents.payload}->>'change' = 'mailbox_settings_read'`,
      ),
    );

const stored = async (principalId: string) => {
  const zone = await fixture
    .select({ timeZone: principals.timeZone })
    .from(principals)
    .where(eq(principals.id, principalId));
  const state = await fixture
    .select({ start: principalState.quietHoursStart, end: principalState.quietHoursEnd })
    .from(principalState)
    .where(eq(principalState.principalId, principalId));
  return { timeZone: zone[0]?.timeZone, quietHours: state[0] ?? null };
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  root = await openAppTestDb(url);
  fixture = openFixtureDb(url);
});

afterAll(async () => {
  await root?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

beforeEach(async () => {
  // Each case sees only the principals it creates.
  await fixture.execute(sql`UPDATE principals SET status = 'paused' WHERE status = 'onboarding'`);
  reads = NEW_YORK_HOURS;
  calls = [];
});

describe('runOnboardingPrefill', () => {
  it("stores the time zone and quiet hours from a connected principal's mailbox, once", async () => {
    const id = await createPrincipal('onboarding');
    await record(id, { change: 'graph_connected' });

    const first = await sweep();
    const second = await sweep();

    expect(first).toEqual({ read: [id], failed: [] });
    expect(second).toEqual({ read: [], failed: [] });
    expect(calls).toEqual([id]);
    expect(await stored(id)).toEqual({
      timeZone: 'America/New_York',
      quietHours: { start: '17:30', end: '08:30' },
    });
    expect(await readEvents(id)).toEqual([
      {
        actor: 'system:onboarding-prefill',
        payload: expect.objectContaining({
          change: 'mailbox_settings_read',
          timeZone: 'America/New_York',
          applied: true,
        }) as unknown,
      },
    ]);
  });

  it('leaves a principal who has not connected Microsoft 365 alone', async () => {
    await createPrincipal('onboarding');
    expect(await sweep()).toEqual({ read: [], failed: [] });
    expect(calls).toEqual([]);
  });

  it('never reads an active principal, whose onboarding is over', async () => {
    const id = await createPrincipal('active');
    await record(id, { change: 'graph_connected' });
    await sweep();
    expect(calls).toEqual([]);
  });

  it('records the read but keeps what the principal already confirmed', async () => {
    const id = await createPrincipal('onboarding');
    await record(id, { change: 'graph_connected' });
    const own = scopedDb(root, { principalId: id });
    await own.insert(principalState).values({ quietHoursStart: '21:00', quietHoursEnd: '06:00' });
    await record(id, {
      change: 'preferences_confirmed',
      timeZone: 'Europe/London',
      quietHoursStart: '21:00',
      quietHoursEnd: '06:00',
    });

    await sweep();

    expect(await stored(id)).toEqual({
      timeZone: 'Europe/London',
      quietHours: { start: '21:00', end: '06:00' },
    });
    expect((await readEvents(id))[0]?.payload).toMatchObject({ applied: false });
  });

  it('tries again on the next run when the read fails', async () => {
    const id = await createPrincipal('onboarding');
    await record(id, { change: 'graph_connected' });
    reads = new Error('graph getMailboxSettings: HTTP 503');

    expect(await sweep()).toEqual({ read: [], failed: [id] });
    expect(await readEvents(id)).toEqual([]);

    reads = NEW_YORK_HOURS;
    expect(await sweep()).toEqual({ read: [id], failed: [] });
  });

  it('reads again after the principal connects Microsoft 365 a second time', async () => {
    const id = await createPrincipal('onboarding');
    await record(id, { change: 'graph_connected' });
    await sweep();
    await record(id, { change: 'graph_connected' });

    expect(await sweep()).toEqual({ read: [id], failed: [] });
    expect(await readEvents(id)).toHaveLength(2);
  });
});
