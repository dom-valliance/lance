import { BudgetExceededError, runAgent, type AgentDefinition } from '@lance/agents';
import { ScriptedRunner, textMessage } from '@lance/agents/testing';
import {
  SEED_PRINCIPAL_ID,
  agentRuns,
  alerts,
  createDb,
  cursors,
  grantRetentionMember,
  principalState,
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

  // The worker identity's grant from the migration job (packages/db/src/grants.ts).
  await grantRetentionMember(fixture, APP_ROLE);

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
  boss = createBoss(root);
  worker = await bootWorker({
    config,
    root,
    boss,
    modelRunner: new ScriptedRunner(Array.from({ length: 20 }, () => [textMessage('{"ok":true}')])),
    connectorsFor: () => Promise.resolve(null),
    buildWatchers: ({ principal }) => [fakeWatcher(principal.id)],
    webUrl: null,
    roleCheckCredentials: null,
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

describe("each principal's context", () => {
  it('names its own principal to triage, the detectors and the briefs, never Dom for anyone else', async () => {
    const resolved = await worker.contexts.resolve(OTHER_ID);
    if (resolved.status !== 'active') throw new Error('The second principal should be active.');
    const other = resolved.context;
    const expected = {
      name: 'Second Principal',
      email: 'second.principal@example.test',
      notionUserId: null,
    };
    expect(other.triage?.principal).toEqual(expected);
    expect(other.detectors.principal).toEqual(expected);
    expect(other.briefs.principal).toEqual(expected);
    const owner = await worker.contexts.resolve(SEED_PRINCIPAL_ID);
    if (owner.status !== 'active') throw new Error('The first principal should be active.');
    expect(owner.context.triage?.principal).toMatchObject({
      name: config.dom.name,
      email: 'dom@valliance.ai',
    });
  });
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

  it("puts every per-principal schedule's jobs in that principal's group", async () => {
    for (const schedule of await boss.getSchedules()) {
      const principalId = (schedule.data as { principalId?: string } | undefined)?.principalId;
      expect({ key: schedule.key, group: schedule.options?.group?.id ?? null }).toEqual({
        key: schedule.key,
        group: principalId ?? null,
      });
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

  it('puts a bulk-mail job back while its principal is paused, as it puts back triage', async () => {
    const control = new SystemControl(scoped(OTHER_ID));
    await control.pause({ reason: 'drill', actor: 'user:dom' });
    const correlationId = newUlid();
    const waiting = async (): Promise<number> => {
      const result: { rows: Array<{ n: string }> } = await fixture.$client.query(
        "SELECT count(*) AS n FROM pgboss.job WHERE name = 'bulk-mail' AND state = 'created' AND data->>'correlationId' = $1 AND start_after > now()",
        [correlationId],
      );
      return Number(result.rows[0]?.n ?? '0');
    };
    try {
      await boss.send(
        'bulk-mail',
        { principalId: OTHER_ID, watcher: 'graph-mail', correlationId, observationEventIds: [] },
        { group: { id: OTHER_ID } },
      );
      await waitFor(async () => (await waiting()) === 1);
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

  it('skips the role check with a log line when the Entra credentials are absent', async () => {
    const info = vi.spyOn(console, 'info');
    try {
      await boss.send('role-check', {});
      await waitFor(() =>
        info.mock.calls.some((call) => String(call[1]).includes('role check skipped')),
      );
    } finally {
      info.mockRestore();
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
      // Retention runs for every principal whatever their status (spec 4.4).
      expect(keys.filter((key) => key.includes(OTHER_ID))).toEqual([
        `retention|retention/${OTHER_ID}`,
      ]);
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

  it('keeps only retention for an offboarded principal', async () => {
    await fixture.$client.query("UPDATE principals SET status = 'offboarded' WHERE id = $1", [
      OTHER_ID,
    ]);
    try {
      await worker.reconcile();
      const keys = [...(await scheduleKeys())].filter((key) => key.includes(OTHER_ID));
      expect(keys).toEqual([`retention|retention/${OTHER_ID}`]);
    } finally {
      await fixture.$client.query("UPDATE principals SET status = 'active' WHERE id = $1", [
        OTHER_ID,
      ]);
      await worker.reconcile();
    }
  });
});

describe('retention and offboarding through pg-boss', () => {
  const retentionEvents = async (principalId: string): Promise<number> => {
    const result = await fixture.$client.query(
      "SELECT count(*)::int AS n FROM ledger_events WHERE principal_id = $1 AND kind = 'retention_applied'",
      [principalId],
    );
    return (result.rows as { n: number }[])[0]?.n ?? 0;
  };

  it('runs retention for a principal who is not active', async () => {
    await fixture.$client.query("UPDATE principals SET status = 'paused' WHERE id = $1", [
      OTHER_ID,
    ]);
    try {
      const before = await retentionEvents(OTHER_ID);
      const id = await boss.send('retention', { principalId: OTHER_ID });
      await waitFor(async () => (await boss.getJobById('retention', id!))?.state === 'completed');
      expect(await retentionEvents(OTHER_ID)).toBe(before + 1);
    } finally {
      await fixture.$client.query("UPDATE principals SET status = 'active' WHERE id = $1", [
        OTHER_ID,
      ]);
    }
  }, 30_000);

  it('offboards a principal from the offboard queue and drops their schedules at once', async () => {
    const synthetic = '01K5S9V6QW3SWCCPVB0N0E3Q8H';
    await fixture.$client.query(
      "INSERT INTO principals (id, upn, status) VALUES ($1, 'synthetic@example.test', 'active')",
      [synthetic],
    );
    await worker.reconcile();
    expect([...(await scheduleKeys())].some((key) => key.includes(`/${synthetic}`))).toBe(true);

    const id = await boss.send('offboard-principal', {
      principalId: synthetic,
      actor: 'user:dom',
      reason: 'drill',
    });
    await waitFor(
      async () => (await boss.getJobById('offboard-principal', id!))?.state === 'completed',
    );
    const status = await fixture.$client.query('SELECT status FROM principals WHERE id = $1', [
      synthetic,
    ]);
    expect((status.rows as { status: string }[])[0]?.status).toBe('offboarded');
    expect([...(await scheduleKeys())].filter((key) => key.includes(`/${synthetic}`))).toEqual([
      `retention|retention/${synthetic}`,
    ]);
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
        fallbackAdminUpn: config.dom.email,
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

  it('sends the organisation alert to every recorded Lance.Admin rather than to Dom by UPN', async () => {
    await setOrganisationCeiling(10);
    await fixture.$client.query(
      "UPDATE principals SET lance_roles = ARRAY['Lance.User', 'Lance.Admin'] WHERE id = $1",
      [OTHER_ID],
    );
    const counts = async (principalId: string): Promise<string[]> =>
      (await scoped(principalId).select().from(alerts))
        .map((alert) => `${alert.dedupeKey}:${String(alert.count)}`)
        .sort();
    const before = await counts(SEED_PRINCIPAL_ID);
    try {
      await runOrganisationBudgetGuard({ root, config, fallbackAdminUpn: config.dom.email });

      const other = await scoped(OTHER_ID).select().from(alerts);
      expect(other.some((alert) => alert.dedupeKey.startsWith('budget:organisation:100:'))).toBe(
        true,
      );
      expect(await counts(SEED_PRINCIPAL_ID)).toEqual(before);
    } finally {
      await fixture.$client.query("UPDATE principals SET lance_roles = '{}' WHERE id = $1", [
        OTHER_ID,
      ]);
      await setOrganisationCeiling(1000);
    }
  });
});
