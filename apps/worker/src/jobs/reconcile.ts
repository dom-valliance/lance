import { principals, scopedDb, type Db, type JobRow } from '@lance/db';
import { JobControl } from '@lance/ledger';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import {
  effectiveSchedules,
  isDeclaredQueue,
  organisationJobs,
  principalJobs,
  SYSTEM_JOBS,
  type JobDeclaration,
} from './registry.js';

/**
 * The reconciler (ADR 0025): turns the registry's declarations and each
 * principal's rows in `jobs` into pg-boss schedules, and removes every
 * schedule on a declared queue that should not exist. It runs at worker
 * start, on the `jobs-reconcile` queue whenever the api changes a job row,
 * and every minute from the registry, which is how a principal whose status
 * changed gains or loses their schedules.
 *
 * Keys: `<slug>/<principalId>` for a per-principal job, with `/<n>` added
 * when the job has more than one cron, and `<slug>` for an organisation
 * job. pg-boss refuses a colon in a key, so the separator ADR 0025 writes as
 * `:` is a slash. Any other key on a declared queue is removed, which is
 * what clears the unkeyed schedules the single-principal worker wrote.
 */

export const SCHEDULER_ACTOR = 'system:scheduler';

export interface DesiredSchedule {
  queue: string;
  key: string;
  cron: string;
  timeZone: string;
  data: Record<string, string>;
}

export interface ReconcileResult {
  /** Schedules created or changed. */
  scheduled: number;
  /** Schedules removed. */
  removed: number;
  unchanged: number;
  /** Active principals whose jobs were reconciled. */
  principals: number;
}

export interface ReconcileDeps {
  boss: PgBoss;
  /** Unscoped: reads `principals` and scopes a handle to each. */
  root: Db;
  /** The zone organisation jobs run in, `config.timeZone`. */
  organisationTimeZone: string;
  log?: (entry: Record<string, unknown>, message: string) => void;
}

/**
 * The one place the worker calls `boss.schedule`. It refuses a queue the
 * registry does not declare, so a schedule cannot exist without a
 * declaration; `registry.test.ts` checks nothing else calls it.
 */
export async function scheduleDeclared(boss: PgBoss, desired: DesiredSchedule): Promise<void> {
  if (!isDeclaredQueue(desired.queue)) {
    throw new Error(
      `Refusing to schedule ${desired.queue}: the job registry in apps/worker/src/jobs/registry.ts does not declare it. Declare the job there first (ADR 0025).`,
    );
  }
  await boss.schedule(desired.queue, desired.cron, desired.data, {
    tz: desired.timeZone,
    key: desired.key,
  });
}

export const principalScheduleKey = (
  slug: string,
  principalId: string,
  index: number,
  count: number,
): string => (count > 1 ? `${slug}/${principalId}/${String(index)}` : `${slug}/${principalId}`);

function desiredForPrincipal(
  principal: { id: string; timeZone: string },
  rows: readonly JobRow[],
  log: ReconcileDeps['log'],
): DesiredSchedule[] {
  const desired: DesiredSchedule[] = [];
  for (const job of principalJobs()) {
    const row = rows.find((candidate) => candidate.slug === job.slug);
    // A locked job runs whatever its row says; a missing row means the
    // defaults, which is what a lazily created row holds.
    const enabled = job.locked || (row?.enabled ?? true);
    if (!enabled) continue;
    const effective = effectiveSchedules(job, row?.scheduleOverride ?? null, principal.timeZone);
    if (effective.refusedOverride !== null) {
      log?.(
        { principalId: principal.id, job: job.slug, reason: effective.refusedOverride },
        'schedule override refused; the default schedule applies',
      );
    }
    effective.schedules.forEach((cron, index) => {
      desired.push({
        queue: job.slug,
        key: principalScheduleKey(job.slug, principal.id, index, effective.schedules.length),
        cron,
        timeZone: principal.timeZone,
        data: { principalId: principal.id },
      });
    });
  }
  return desired;
}

function desiredForOrganisation(timeZone: string): DesiredSchedule[] {
  return organisationJobs().flatMap((job: JobDeclaration) =>
    job.schedules.map((cron, index) => ({
      queue: job.slug,
      key: job.schedules.length > 1 ? `${job.slug}/${String(index)}` : job.slug,
      cron,
      timeZone,
      data: {},
    })),
  );
}

const sameData = (left: object | undefined, right: object): boolean =>
  JSON.stringify(left ?? {}) === JSON.stringify(right);

/** Reconciles every declared job for every active principal. Serialised within the process. */
export function createReconciler(deps: ReconcileDeps): () => Promise<ReconcileResult> {
  let running: Promise<ReconcileResult> = Promise.resolve({
    scheduled: 0,
    removed: 0,
    unchanged: 0,
    principals: 0,
  });
  return () => {
    const next = running.catch(() => undefined).then(() => reconcileOnce(deps));
    running = next;
    return next;
  };
}

export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileResult> {
  const active = await deps.root
    .select({ id: principals.id, timeZone: principals.timeZone })
    .from(principals)
    .where(eq(principals.status, 'active'));

  const desired: DesiredSchedule[] = desiredForOrganisation(deps.organisationTimeZone);
  const defaults = principalJobs().map((job) => ({ slug: job.slug, locked: job.locked }));
  for (const principal of active) {
    const control = new JobControl(scopedDb(deps.root, { principalId: principal.id }));
    await control.ensure(defaults, { actor: SCHEDULER_ACTOR });
    desired.push(...desiredForPrincipal(principal, await control.list(), deps.log));
  }

  const existing = (await deps.boss.getSchedules()).filter((schedule) =>
    isDeclaredQueue(schedule.name),
  );
  const wanted = new Map(
    desired.map((schedule) => [`${schedule.queue}|${schedule.key}`, schedule]),
  );

  let removed = 0;
  let unchanged = 0;
  const current = new Map<string, (typeof existing)[number]>();
  for (const schedule of existing) {
    const id = `${schedule.name}|${schedule.key}`;
    if (wanted.has(id)) {
      current.set(id, schedule);
      continue;
    }
    await deps.boss.unschedule(schedule.name, schedule.key);
    removed += 1;
  }

  let scheduled = 0;
  for (const [id, schedule] of wanted) {
    const present = current.get(id);
    if (
      present !== undefined &&
      present.cron === schedule.cron &&
      present.timezone === schedule.timeZone &&
      sameData(present.data, schedule.data)
    ) {
      unchanged += 1;
      continue;
    }
    await scheduleDeclared(deps.boss, schedule);
    scheduled += 1;
  }
  return { scheduled, removed, unchanged, principals: active.length };
}

/** Every queue the registry declares, for creating them at boot. */
export const declaredQueues = (): string[] => SYSTEM_JOBS.map((job) => job.slug);
