import { BudgetExceededError, runAgent, type AgentDefinition } from '@lance/agents';
import { ScriptedRunner, textMessage } from '@lance/agents/testing';
import {
  SEED_PRINCIPAL_ID,
  agentRuns,
  alerts,
  createDb,
  cursors,
  principalState,
  principals,
  runMigrations,
  scopedDb,
  type Db,
} from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { JobControl, SystemControl } from '@lance/ledger';
import { loadConfig, newUlid, type Config } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBoss, startBoss } from '../scheduler/boss.js';
import type { Watcher } from '../watchers/types.js';
import { bootWorker, type BootedWorker } from './boot.js';
import { runOrganisationBudgetGuard } from './organisationBudget.js';
import { principalScheduleKey } from './reconcile.js';
import { EXPIRY_QUEUE, SYSTEM_JOBS } from './registry.js';

/**
 * The worker's boot path against a real pg-boss with two principals
 * (ADR 0025, docs/plans/multi-user.md section 7). Connectors are fakes: a
 * watcher per principal that remembers who polled it and advances its own
 * cursor, and no connector bundle for anyone, as a principal who is not Dom
 * has today.
 */

const OTHER_ID = '01K5S9V6QW3SWCCPVB0N0E3Q7H';
const UNKNOWN_ID = '01K5S9V6QW3SWCCPVB0N0E3ZZZ';
const APP_ROLE = 'lance_test_app';

let container: StartedPostgreSqlContainer;
let fixture: Db;
let root: Db;
let seeded: Db;
let boss: PgBoss;
let worker: BootedWorker;
let config: Config;
const polls: string[] = [];

const fakeWatcher = (principalId: string): Watcher => {
  let n = 0;
  return {
    name: 'jamie',
    sourceSystem: 'jamie',
    schedules: ['*/15 * * * *'],
    triage: false,
    partitions: () => Promise.resolve(['main']),
    poll: () => {
      polls.push(principalId);
      n += 1;
      return Promise.resolve({
        records: [
          { id: `${principalId}-${String(n)}`, observedAt: new Date().toISOString(), raw: { n } },
        ],
        nextCursor: `${principalId}:${String(n)}`,
      });
    },
    normalise: (record) =>
      Promise.resolve({
        sourceSystem: 'jamie',
        recordId: record.id,
        observedAt: record.observedAt,
        record: { id: record.id },
        correlationKey: record.id,
      }),
  };
};

const scoped = (principalId: string): Db => scopedDb(root, { principalId });

const waitFor = async (
  check: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the condition.');
};

const pollsBy = (principalId: string): number => polls.filter((id) => id === principalId).length;

const scheduleKeys = async (): Promise<Set<string>> =>
  new Set((await boss.getSchedules()).map((schedule) => `${schedule.name}|${schedule.key}`));

const runJamie = (principalId: string): Promise<string | null> =>
  boss.send('watcher-jamie', { principalId });

const definition: AgentDefinition<{ ok: boolean }> = {
  name: 'budget-probe',
  version: '0.1.0',
  model: { id: 'claude-sonnet-5', effort: 'low' },
  system: 'Reply with {"ok":true}.',
  tools: [],
  outputSchema: z.object({ ok: z.boolean() }),
};

const spend = async (principalId: string, usd: number): Promise<void> => {
  await scoped(principalId)
    .insert(agentRuns)
    .values({
      id: newUlid(),
      agent: 'triage',
      version: '0.1.0',
      model: 'claude-sonnet-5',
      status: 'succeeded',
      startedAt: new Date(),
      estimatedCostUsd: usd.toFixed(6),
    });
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  seeded = await openSeededTestDb(url);
  fixture = createDb({ connectionString: url, password: 'postgres' });
  await fixture.$client.query(
    "INSERT INTO principals (id, upn, time_zone) VALUES ($1, 'second.principal@example.test', 'Europe/London')",
    [OTHER_ID],
  );
  await scopedDb(fixture, { principalId: OTHER_ID }).insert(principalState).values({});

  const appUrl = new URL(url);
  appUrl.username = APP_ROLE;
  appUrl.password = APP_ROLE;
  root = createDb({ connectionString: appUrl.toString(), password: APP_ROLE });

  // What the single-principal worker left behind: unkeyed schedules.
  const legacy = createBoss(root);
  await startBoss(legacy);
  await legacy.createQueue('brief-morning');
  await legacy.createQueue('watcher-graph-mail');
  await legacy.schedule('brief-morning', '30 6 * * 1-5', {}, { key: 'brief-morning' });
  await legacy.schedule(
    'watcher-graph-mail',
    '0 * * * 0,6',
    { schedule: 2 },
    { key: 'watcher-graph-mail-2' },
  );
  await legacy.stop({ graceful: false });

  config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    DOM_EMAIL: 'dom@valliance.ai',
  });
  const [admin] = await fixture
    .select()
    .from(principals)
    .where(eq(principals.id, SEED_PRINCIPAL_ID));
  if (admin === undefined) throw new Error('The seed did not create the first principal.');
  boss = createBoss(root);
  worker = await bootWorker({
    config,
    root,
    boss,
    admin,
    modelRunner: new ScriptedRunner(Array.from({ length: 20 }, () => [textMessage('{"ok":true}')])),
    connectorsFor: () => Promise.resolve(null),
    buildWatchers: ({ principal }) => [fakeWatcher(principal.id)],
    webUrl: null,
    organisationBudgetTtlMs: 0,
  });
}, 180_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await root?.$client.end();
  await seeded?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

describe('the reconciler at boot', () => {
  it('schedules every per-principal job for both principals and each organisation job once', async () => {
    const keys = await scheduleKeys();
    for (const job of SYSTEM_JOBS) {
      if (job.scope === 'organisation') {
        expect(keys.has(`${job.slug}|${job.slug}`)).toBe(true);
        continue;
      }
      for (const principalId of [SEED_PRINCIPAL_ID, OTHER_ID]) {
        job.schedules.forEach((_cron, index) => {
          const key = principalScheduleKey(job.slug, principalId, index, job.schedules.length);
          expect({ key, present: keys.has(`${job.slug}|${key}`) }).toEqual({ key, present: true });
        });
      }
    }
    const schedules = await boss.getSchedules();
    for (const schedule of schedules) {
      const principalId = (schedule.data as { principalId?: string } | undefined)?.principalId;
      if (principalId !== undefined) expect(schedule.key).toContain(principalId);
    }
  });

  it('removes the unkeyed schedules the single-principal worker wrote, so nothing runs twice', async () => {
    const keys = await scheduleKeys();
    expect(keys.has('brief-morning|brief-morning')).toBe(false);
    expect(keys.has('watcher-graph-mail|watcher-graph-mail-2')).toBe(false);
  });

  it('creates each principal their own job rows with the declared defaults', async () => {
    for (const principalId of [SEED_PRINCIPAL_ID, OTHER_ID]) {
      const rows = await new JobControl(scoped(principalId)).list();
      expect(rows.filter((row) => row.principalId !== principalId)).toEqual([]);
      expect(rows.find((row) => row.slug === 'alerts-deliver')?.locked).toBe(true);
      expect(rows.find((row) => row.slug === 'brief-morning')).toMatchObject({
        enabled: true,
        locked: false,
      });
    }
  });
});

describe('per-principal jobs', () => {
  it("runs two principals' watchers with their own cursors", async () => {
    await runJamie(SEED_PRINCIPAL_ID);
    await runJamie(OTHER_ID);
    await waitFor(async () => {
      const [a, b] = await Promise.all([
        scoped(SEED_PRINCIPAL_ID).select().from(cursors).where(eq(cursors.key, 'main')),
        scoped(OTHER_ID).select().from(cursors).where(eq(cursors.key, 'main')),
      ]);
      return a.length === 1 && b.length === 1;
    });
    const a = await scoped(SEED_PRINCIPAL_ID).select().from(cursors).where(eq(cursors.key, 'main'));
    const b = await scoped(OTHER_ID).select().from(cursors).where(eq(cursors.key, 'main'));
    expect(a[0]?.value.startsWith(`${SEED_PRINCIPAL_ID}:`)).toBe(true);
    expect(b[0]?.value.startsWith(`${OTHER_ID}:`)).toBe(true);
    expect(a[0]?.principalId).toBe(SEED_PRINCIPAL_ID);
    expect(b[0]?.principalId).toBe(OTHER_ID);
  }, 30_000);

  it("pausing one principal leaves the other's jobs running", async () => {
    const control = new SystemControl(scoped(OTHER_ID));
    await control.pause({ reason: 'drill', actor: 'user:dom' });
    try {
      const before = { a: pollsBy(SEED_PRINCIPAL_ID), b: pollsBy(OTHER_ID) };
      await runJamie(OTHER_ID);
      await runJamie(SEED_PRINCIPAL_ID);
      await waitFor(() => pollsBy(SEED_PRINCIPAL_ID) > before.a);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(pollsBy(OTHER_ID)).toBe(before.b);
    } finally {
      await control.resume({ actor: 'user:dom' });
    }
  }, 30_000);

  it('the global pause stops both principals', async () => {
    const control = new SystemControl(scoped(SEED_PRINCIPAL_ID));
    await control.pauseAll({ reason: 'drill', actor: 'user:dom' });
    try {
      const before = polls.length;
      await runJamie(SEED_PRINCIPAL_ID);
      await runJamie(OTHER_ID);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(polls.length).toBe(before);
    } finally {
      await control.resumeAll({ actor: 'user:dom' });
    }
    const resumed = polls.length;
    await runJamie(OTHER_ID);
    await waitFor(() => polls.length > resumed);
  }, 30_000);

  it('skips, with a log line, a watcher the principal has no connectors for', async () => {
    const info = vi.spyOn(console, 'info');
    try {
      await boss.send('watcher-notion', { principalId: OTHER_ID });
      await waitFor(() =>
        info.mock.calls.some((call) => String(call[1]).includes('watcher run skipped')),
      );
    } finally {
      info.mockRestore();
    }
  }, 30_000);

  it('fails loudly on a job whose payload names an unknown principal', async () => {
    const error = vi.spyOn(console, 'error');
    try {
      const id = await boss.send(EXPIRY_QUEUE, { principalId: UNKNOWN_ID }, { retryLimit: 0 });
      await waitFor(async () => (await boss.getJobById(EXPIRY_QUEUE, id!))?.state === 'failed');
      const logged = error.mock.calls.find((call) => call[1] === 'job failed');
      expect(JSON.stringify(logged?.[0])).toContain('not in the principals table');
    } finally {
      error.mockRestore();
    }
  }, 30_000);

  it('fails loudly on a job whose payload names no principal', async () => {
    const id = await boss.send(EXPIRY_QUEUE, {}, { retryLimit: 0 });
    await waitFor(async () => (await boss.getJobById(EXPIRY_QUEUE, id!))?.state === 'failed');
  }, 30_000);
});

describe('job settings', () => {
  const morning = (principalId: string): string => `brief-morning|brief-morning/${principalId}`;

  it('takes the schedule away from a disabled job and gives it back when re-enabled', async () => {
    const jobs = new JobControl(scoped(OTHER_ID));
    await jobs.setEnabled('brief-morning', false, { actor: 'user:dom' });
    await worker.reconcile();
    let keys = await scheduleKeys();
    expect(keys.has(morning(OTHER_ID))).toBe(false);
    expect(keys.has(morning(SEED_PRINCIPAL_ID))).toBe(true);

    await jobs.setEnabled('brief-morning', true, { actor: 'user:dom' });
    await worker.reconcile();
    keys = await scheduleKeys();
    expect(keys.has(morning(OTHER_ID))).toBe(true);
  });

  it('keeps a locked job scheduled whatever its row says', async () => {
    await scopedDb(fixture, { principalId: OTHER_ID }).$client.query(
      "UPDATE jobs SET enabled = false WHERE slug = 'alerts-deliver'",
    );
    await worker.reconcile();
    expect((await scheduleKeys()).has(`alerts-deliver|alerts-deliver/${OTHER_ID}`)).toBe(true);
  });

  it("removes a paused principal's schedules and completes their queued jobs as no-ops", async () => {
    await fixture.$client.query("UPDATE principals SET status = 'paused' WHERE id = $1", [
      OTHER_ID,
    ]);
    try {
      await worker.reconcile();
      const keys = [...(await scheduleKeys())];
      expect(keys.filter((key) => key.includes(OTHER_ID))).toEqual([]);
      expect(keys.some((key) => key.includes(SEED_PRINCIPAL_ID))).toBe(true);

      const before = pollsBy(OTHER_ID);
      const id = await runJamie(OTHER_ID);
      await waitFor(
        async () => (await boss.getJobById('watcher-jamie', id!))?.state === 'completed',
      );
      expect(pollsBy(OTHER_ID)).toBe(before);
    } finally {
      await fixture.$client.query("UPDATE principals SET status = 'active' WHERE id = $1", [
        OTHER_ID,
      ]);
      await worker.reconcile();
    }
    expect((await scheduleKeys()).has(morning(OTHER_ID))).toBe(true);
  }, 30_000);
});

describe('budgets', () => {
  const input = { correlationId: newUlid(), prompt: 'probe' };

  const agentFor = async (principalId: string) => {
    const resolution = await worker.contexts.resolve(principalId);
    if (resolution.status !== 'active' || resolution.context.agent === null)
      throw new Error(`No agent for ${principalId}`);
    return resolution.context.agent;
  };

  const setOrganisationCeiling = (gbp: number) =>
    fixture.$client.query('UPDATE system_state SET cost_ceiling_gbp = $1 WHERE id = 1', [gbp]);

  it('pauses only the model agents of a principal who crosses their own ceiling', async () => {
    await setOrganisationCeiling(1000);
    // GBP 15.60 at the default rate, past the default GBP 15 ceiling.
    await spend(OTHER_ID, 20);
    const refused = runAgent(await agentFor(OTHER_ID), definition, input);
    await expect(refused).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(refused).rejects.toThrow(/Daily model spend/);
    const result = await runAgent(await agentFor(SEED_PRINCIPAL_ID), definition, input);
    expect(result.output).toEqual({ ok: true });
  });

  it('pauses every principal at the organisation ceiling and tells the admin', async () => {
    await setOrganisationCeiling(10);
    try {
      const refused = runAgent(await agentFor(SEED_PRINCIPAL_ID), definition, input);
      await expect(refused).rejects.toBeInstanceOf(BudgetExceededError);
      await expect(refused).rejects.toThrow(/paused for everyone/);

      await runOrganisationBudgetGuard({
        root,
        config,
        adminDb: scoped(SEED_PRINCIPAL_ID),
      });
      const raised = await scoped(SEED_PRINCIPAL_ID)
        .select()
        .from(alerts)
        .where(eq(alerts.severity, 'P0'));
      expect(raised.some((alert) => alert.dedupeKey.startsWith('budget:organisation:100:'))).toBe(
        true,
      );
      const other = await scoped(OTHER_ID).select().from(alerts);
      expect(other.some((alert) => alert.dedupeKey.startsWith('budget:organisation'))).toBe(false);
    } finally {
      await setOrganisationCeiling(1000);
    }
  });
});
