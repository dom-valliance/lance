import {
  ledgerEvents,
  principalState,
  principals,
  runMigrations,
  scopedDb,
  slackLinks,
  type Db,
} from '@lance/db';
import { openAppTestDb, openFixtureDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter, ONBOARDING_ACTOR } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '../deps.js';
import { fakePrincipal } from '../test-fakes.js';
import {
  createOnboardingService,
  OnboardingRefusedError,
  type OnboardingServiceLike,
} from './service.js';

/**
 * The onboarding checklist against a real database, connected as a member
 * of lance_app as the api is, so every read and write here passes the same
 * row-level security and guard triggers the deployed api does. The
 * superuser handle only creates the principal and reads results back.
 */

const NOTICE = 'a'.repeat(64);
const CHANGED_NOTICE = 'b'.repeat(64);
const NOW = '2026-09-28T09:00:00.000Z';
const ACTOR = 'user:newcomer';

let container: StartedPostgreSqlContainer;
let root: Db;
let fixture: Db;
let service: OnboardingServiceLike;
let reconciled: string[];
let newcomer: PrincipalRef;

const own = (): Db => scopedDb(root, { principalId: newcomer.id });

const recordConnected = async (change: 'graph_connected' | 'jamie_connected'): Promise<void> => {
  // What the consent callback and POST /credentials/jamie write once the
  // secret is stored.
  await new LedgerWriter(own()).append({
    ts: NOW,
    actor: ACTOR,
    kind: 'state_changed',
    sourceSystem: change === 'graph_connected' ? 'graph' : 'jamie',
    correlationId: newUlid(),
    payload: { change },
  });
};

const linkSlack = async (): Promise<void> => {
  // lance_app may name only these columns (migration 0014), as the link route does.
  await own().execute(
    sql`INSERT INTO slack_links (slack_user_id, slack_team_id, principal_id) VALUES (${`U0${newcomer.id}`}, 'T0VALLIANCE', ${newcomer.id})`,
  );
};

const confirm = (): Promise<void> =>
  service.confirmPreferences(
    newcomer,
    { timeZone: 'Europe/London', quietHoursStart: '18:30', quietHoursEnd: '08:00' },
    ACTOR,
  );

const doEverything = async (): Promise<void> => {
  await service.acceptNotice(newcomer, NOTICE, ACTOR);
  await recordConnected('graph_connected');
  await recordConnected('jamie_connected');
  await linkSlack();
  await confirm();
};

const principalRow = async (): Promise<{ status: string; activatedAt: Date | null }> => {
  const rows = await fixture
    .select({ status: principals.status, activatedAt: principals.activatedAt })
    .from(principals)
    .where(eq(principals.id, newcomer.id));
  const row = rows[0];
  if (row === undefined) throw new Error('The newcomer is missing.');
  return row;
};

const eventsOf = async (change: string): Promise<{ actor: string; payload: unknown }[]> =>
  fixture
    .select({ actor: ledgerEvents.actor, payload: ledgerEvents.payload })
    .from(ledgerEvents)
    .where(
      sql`${ledgerEvents.principalId} = ${newcomer.id} AND ${ledgerEvents.payload}->>'change' = ${change}`,
    );

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
  const id = newUlid();
  await fixture.insert(principals).values({
    id,
    entraOid: `oid-${id}`,
    upn: `newcomer.${id.toLowerCase()}@valliance.ai`,
    status: 'onboarding',
  });
  newcomer = fakePrincipal({
    id,
    upn: `newcomer.${id.toLowerCase()}@valliance.ai`,
    status: 'onboarding',
    slackUserId: null,
    slackChannelId: null,
    lanceRoles: ['Lance.User'],
  });
  reconciled = [];
  service = createOnboardingService({
    root,
    now: () => NOW,
    afterActivation: (principalId) => {
      reconciled.push(principalId);
      return Promise.resolve();
    },
  });
});

describe("each step's state, from the server", () => {
  it('starts with every required step missing and Foundry arriving later', async () => {
    const state = await service.state(newcomer, NOTICE);
    expect(state.status).toBe('onboarding');
    expect(state.missing).toEqual(['notice', 'graph', 'jamie', 'slack', 'preferences']);
    expect(state.foundry).toEqual({ required: false, arrivesLater: true });
    expect(state.preferences).toMatchObject({
      done: false,
      timeZone: 'Europe/London',
      quietHoursStart: '19:00',
      quietHoursEnd: '07:00',
      source: 'defaults',
    });
  });

  it('shows Microsoft 365 connected once the consent callback has recorded it', async () => {
    await recordConnected('graph_connected');
    const state = await service.state(newcomer, NOTICE);
    expect(state.graph).toEqual({ done: true, connectedAt: NOW });
    expect(state.preferences.source).toBe('waiting_for_mailbox');
  });

  it('shows Jamie connected once the key route has recorded it', async () => {
    await recordConnected('jamie_connected');
    expect((await service.state(newcomer, NOTICE)).jamie.done).toBe(true);
  });

  it("shows Slack linked while slack_links holds the principal's active link", async () => {
    await linkSlack();
    expect((await service.state(newcomer, NOTICE)).slack.done).toBe(true);
    await own()
      .update(slackLinks)
      .set({ revokedAt: new Date() })
      .where(eq(slackLinks.principalId, newcomer.id));
    expect((await service.state(newcomer, NOTICE)).slack.done).toBe(false);
  });

  it('prefills the quiet hours and time zone the worker read from the mailbox', async () => {
    await recordConnected('graph_connected');
    await own().insert(principalState).values({ quietHoursStart: '17:30', quietHoursEnd: '08:30' });
    await own()
      .update(principals)
      .set({ timeZone: 'America/New_York' })
      .where(eq(principals.id, newcomer.id));
    await new LedgerWriter(own()).append({
      ts: NOW,
      actor: 'agent:worker@0.1.0',
      kind: 'state_changed',
      sourceSystem: 'graph',
      correlationId: newUlid(),
      payload: { change: 'mailbox_settings_read', timeZone: 'America/New_York' },
    });

    const state = await service.state(newcomer, NOTICE);
    expect(state.preferences).toMatchObject({
      done: false,
      timeZone: 'America/New_York',
      quietHoursStart: '17:30',
      quietHoursEnd: '08:30',
      source: 'mailbox',
    });
  });
});

describe('the data-processing notice', () => {
  it("records the notice's SHA-256 and the time it was accepted", async () => {
    await service.acceptNotice(newcomer, NOTICE, ACTOR);

    const state = await service.state(newcomer, NOTICE);
    expect(state.notice).toEqual({ done: true, acceptedAt: NOW, changedSinceAcceptance: false });
    expect(await eventsOf('notice_accepted')).toEqual([
      { actor: ACTOR, payload: { change: 'notice_accepted', noticeSha256: NOTICE } },
    ]);
  });

  it('records one acceptance however often the same notice is accepted', async () => {
    await service.acceptNotice(newcomer, NOTICE, ACTOR);
    await service.acceptNotice(newcomer, NOTICE, ACTOR);
    expect(await eventsOf('notice_accepted')).toHaveLength(1);
  });

  it('asks again when the notice has changed since it was accepted', async () => {
    await service.acceptNotice(newcomer, NOTICE, ACTOR);

    const state = await service.state(newcomer, CHANGED_NOTICE);
    expect(state.notice).toEqual({ done: false, acceptedAt: null, changedSinceAcceptance: true });
    expect(state.missing).toContain('notice');

    await service.acceptNotice(newcomer, CHANGED_NOTICE, ACTOR);
    expect((await service.state(newcomer, CHANGED_NOTICE)).notice.done).toBe(true);
    expect(await eventsOf('notice_accepted')).toHaveLength(2);
  });
});

describe('confirming quiet hours and time zone', () => {
  it("stores them on the principal's run state and row, and records the change", async () => {
    await service.confirmPreferences(
      newcomer,
      { timeZone: 'Asia/Tokyo', quietHoursStart: '20:00', quietHoursEnd: '06:00' },
      ACTOR,
    );

    const state = await service.state(newcomer, NOTICE);
    expect(state.preferences).toMatchObject({
      done: true,
      confirmedAt: NOW,
      timeZone: 'Asia/Tokyo',
      quietHoursStart: '20:00',
      quietHoursEnd: '06:00',
      source: 'confirmed',
    });
    expect(await eventsOf('preferences_confirmed')).toHaveLength(1);
  });

  it('records nothing new when the same values are confirmed again', async () => {
    await confirm();
    await confirm();
    expect(await eventsOf('preferences_confirmed')).toHaveLength(1);
  });
});

describe('completing onboarding', () => {
  it('refuses with the missing steps named and changes nothing', async () => {
    await service.acceptNotice(newcomer, NOTICE, ACTOR);
    await recordConnected('graph_connected');

    const refusal = await service.complete(newcomer, NOTICE).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(OnboardingRefusedError);
    expect((refusal as Error).message).toBe(
      'Onboarding is not finished: add your Jamie API key, link Slack with /lance login, confirm your quiet hours and time zone. Nothing was changed.',
    );
    expect(await principalRow()).toEqual({ status: 'onboarding', activatedAt: null });
    expect(await eventsOf('onboarding_completed')).toEqual([]);
    expect(reconciled).toEqual([]);
  });

  it('refuses while the accepted notice is not the current one', async () => {
    await doEverything();
    await expect(service.complete(newcomer, CHANGED_NOTICE)).rejects.toThrow(
      'accept the data-processing notice',
    );
    expect((await principalRow()).status).toBe('onboarding');
  });

  it('activates in dry run with the default ceiling once every required step is done', async () => {
    await doEverything();

    const result = await service.complete(newcomer, NOTICE);

    expect(result).toMatchObject({ status: 'activated', activatedAt: NOW });
    expect(await principalRow()).toEqual({ status: 'active', activatedAt: new Date(NOW) });
    const runState = await fixture
      .select({ mode: principalState.mode, costCeilingGbp: principalState.costCeilingGbp })
      .from(principalState)
      .where(eq(principalState.principalId, newcomer.id));
    expect(runState).toEqual([{ mode: 'dry_run', costCeilingGbp: 15 }]);
    expect(await eventsOf('onboarding_completed')).toEqual([
      {
        actor: ONBOARDING_ACTOR,
        payload: {
          change: 'onboarding_completed',
          from: 'onboarding',
          to: 'active',
          mode: 'dry_run',
          noticeSha256: NOTICE,
        },
      },
    ]);
    expect(reconciled).toEqual([newcomer.id]);
  });

  it('creates the run state in dry run when no earlier step created it', async () => {
    await service.acceptNotice(newcomer, NOTICE, ACTOR);
    await recordConnected('graph_connected');
    await recordConnected('jamie_connected');
    await linkSlack();
    // Confirmed preferences but with the row removed, as if the worker had never run.
    await confirm();
    await fixture.delete(principalState).where(eq(principalState.principalId, newcomer.id));

    await service.complete(newcomer, NOTICE);

    const rows = await fixture
      .select({ mode: principalState.mode })
      .from(principalState)
      .where(eq(principalState.principalId, newcomer.id));
    expect(rows).toEqual([{ mode: 'dry_run' }]);
  });

  it('is idempotent: a second completion changes nothing', async () => {
    await doEverything();
    await service.complete(newcomer, NOTICE);
    const second = await service.complete({ ...newcomer, status: 'onboarding' }, NOTICE);
    expect(second).toEqual({ status: 'already_active' });
    expect(await eventsOf('onboarding_completed')).toHaveLength(1);
  });

  it('refuses every step once the principal is active', async () => {
    await expect(
      service.acceptNotice({ ...newcomer, status: 'active' }, NOTICE, ACTOR),
    ).rejects.toThrow('Onboarding is already complete');
    await expect(
      service.confirmPreferences(
        { ...newcomer, status: 'paused' },
        { timeZone: 'Europe/London', quietHoursStart: '19:00', quietHoursEnd: '07:00' },
        ACTOR,
      ),
    ).rejects.toThrow('This account is paused');
  });
});

describe('a principal marking themselves active by a direct write, as lance_app', () => {
  const refusal = async (work: () => Promise<unknown>): Promise<string> => {
    try {
      await work();
    } catch (error) {
      // Drizzle wraps the driver's error; the SQLSTATE is on the cause.
      let current: unknown = error;
      for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string') return code;
        current = (current as { cause?: unknown }).cause;
      }
      throw error;
    }
    return 'succeeded';
  };

  it('is refused by the database with every step missing', async () => {
    const code = await refusal(() =>
      own()
        .update(principals)
        .set({ status: 'active', activatedAt: new Date(NOW) })
        .where(eq(principals.id, newcomer.id)),
    );
    expect(code).toBe('P0001');
    expect(await principalRow()).toEqual({ status: 'onboarding', activatedAt: null });
  });

  it('is refused by the database even with every step done', async () => {
    await doEverything();
    const code = await refusal(() =>
      own().update(principals).set({ status: 'active' }).where(eq(principals.id, newcomer.id)),
    );
    expect(code).toBe('P0001');
    expect((await principalRow()).status).toBe('onboarding');
  });
});
