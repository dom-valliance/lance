import { assertCron, occurrencesBetween } from '@lance/shared';
import { allDetectors } from '../alerts/detectors/index.js';
import { detectorQueue } from '../alerts/engine/run.js';
import { QUEUE_BOARD, QUEUE_MORNING, QUEUE_PREP } from '../briefs/run.js';
import { QUEUE_WEEKLY } from '../briefs/weekly.js';
import {
  AGENT_LOGS_DETECTOR_SCHEDULE,
  AGENT_LOGS_SCHEDULES,
  AGENT_LOGS_WATCHER_NAME,
} from '../watchers/agent-logs/index.js';
import {
  GRAPH_CALENDAR_SCHEDULES,
  GRAPH_CALENDAR_WATCHER_NAME,
  GRAPH_MAIL_SCHEDULES,
  GRAPH_MAIL_WATCHER_NAME,
} from '../watchers/graph/index.js';
import { JAMIE_SCHEDULES, JAMIE_WATCHER_NAME } from '../watchers/jamie/index.js';
import { NOTION_SCHEDULES, NOTION_WATCHER_NAME } from '../watchers/notion/index.js';
import { watcherQueue } from '../watchers/runner.js';

/**
 * Every scheduled system job the worker runs (ADR 0025, docs/plans/jobs.md
 * J1). This module is the only place a schedule is declared: the reconciler
 * turns these declarations, and each principal's rows in `jobs`, into
 * pg-boss schedules, and `registry.test.ts` fails if any other code calls
 * `boss.schedule`.
 *
 * A job's slug is also its pg-boss queue, so the Slack commands, the job
 * row and the queue all use one name.
 *
 * Scope: `principal` jobs run once per active principal, with
 * `{ principalId }` as their payload and the principal's own time zone;
 * `organisation` jobs run once, in the configured time zone. Queues that
 * only take on-demand work (execute, triage, chase) are not scheduled and
 * are not declared here.
 */

export type JobScope = 'principal' | 'organisation';

/** Limits a schedule override must stay within. */
export interface JobBounds {
  /** Earliest local time, `HH:MM`, any run may fall at. */
  readonly earliest?: string;
  /** Latest local time, `HH:MM`, any run may fall at. */
  readonly latest?: string;
  /**
   * The shortest gap allowed between two runs. Defaults to the shortest gap
   * in the declared schedules, so no override can run a job more often than
   * it runs today.
   */
  readonly minIntervalMinutes?: number;
}

export interface JobDeclaration {
  /** Stable name, pg-boss queue and `jobs.slug`. */
  readonly slug: string;
  /** What `/lance jobs` shows. British English, no trailing full stop. */
  readonly title: string;
  /** Default cron expressions; more than one lets daytime and off-hours differ. */
  readonly schedules: readonly string[];
  readonly bounds: JobBounds;
  /** Shown but never disabled; the reconciler schedules it whatever its row says. */
  readonly locked: boolean;
  readonly scope: JobScope;
  /**
   * A per-principal job that runs whatever the principal's status, not only
   * while they are active. Only retention: a paused or offboarded
   * principal's data still ages out (spec 4.4). Such a job must be locked.
   */
  readonly everyStatus: boolean;
}

/** Runs the reconciler on a timer, so a principal whose status changes gains or loses schedules within a minute. */
export const RECONCILE_QUEUE = 'jobs-reconcile';
export const ORGANISATION_BUDGET_QUEUE = 'organisation-budget-guard';
/** The nightly Lance role check (ADR 0020): pauses a principal who has lost both roles. */
export const ROLE_CHECK_QUEUE = 'role-check';
export const EXPIRY_QUEUE = 'expire-proposals';
export const ALERT_DELIVERY_QUEUE = 'alerts-deliver';
export const DIGEST_QUEUE = 'dry-run-digest';
/** Nightly retention for each principal, whatever their status (spec 4.4, ADR 0011). */
export const RETENTION_QUEUE = 'retention';

/** The budget guard raises the alert that says a principal's agents are paused, so it stays on. */
const LOCKED_DETECTORS = new Set(['budget_guard']);

const DAILY = 24 * 60;

const declare = (
  declaration: Omit<JobDeclaration, 'bounds' | 'locked' | 'scope' | 'everyStatus'> &
    Partial<Pick<JobDeclaration, 'bounds' | 'locked' | 'scope' | 'everyStatus'>>,
): JobDeclaration => ({
  bounds: {},
  locked: false,
  scope: 'principal',
  everyStatus: false,
  ...declaration,
});

const watcherJob = (name: string, schedules: readonly string[], title: string): JobDeclaration =>
  declare({ slug: watcherQueue({ name }), title, schedules });

export const SYSTEM_JOBS: readonly JobDeclaration[] = [
  declare({
    slug: RECONCILE_QUEUE,
    title: 'Turn job settings into schedules',
    schedules: ['* * * * *'],
    locked: true,
    scope: 'organisation',
  }),
  declare({
    slug: ORGANISATION_BUDGET_QUEUE,
    title: 'Organisation model spend against its ceiling',
    schedules: ['*/15 * * * *'],
    locked: true,
    scope: 'organisation',
  }),
  declare({
    slug: ROLE_CHECK_QUEUE,
    title: 'Pause principals who no longer hold a Lance role',
    schedules: ['30 2 * * *'],
    locked: true,
    scope: 'organisation',
  }),
  declare({
    slug: RETENTION_QUEUE,
    title: 'Apply the retention windows to what Lance holds',
    schedules: ['15 3 * * *'],
    locked: true,
    everyStatus: true,
  }),
  declare({
    slug: EXPIRY_QUEUE,
    title: 'Expire proposals nobody decided',
    schedules: ['*/15 * * * *'],
    locked: true,
  }),
  declare({
    slug: ALERT_DELIVERY_QUEUE,
    title: 'Deliver alerts to Slack',
    schedules: ['* * * * *'],
    locked: true,
  }),
  declare({
    slug: DIGEST_QUEUE,
    title: 'Dry-run digest',
    schedules: ['0 17 * * 1-5'],
    bounds: { earliest: '12:00', latest: '21:00', minIntervalMinutes: DAILY / 2 },
  }),
  declare({
    slug: QUEUE_MORNING,
    title: 'Morning brief',
    schedules: ['30 6 * * 1-5'],
    bounds: { earliest: '05:30', latest: '08:30', minIntervalMinutes: DAILY / 2 },
  }),
  declare({
    slug: QUEUE_BOARD,
    title: 'Afternoon board',
    schedules: ['0 16 * * 1-5'],
    bounds: { earliest: '14:00', latest: '18:00', minIntervalMinutes: DAILY / 2 },
  }),
  declare({
    slug: QUEUE_PREP,
    title: 'Meeting prep',
    schedules: ['*/5 7-19 * * 1-5'],
    bounds: { earliest: '06:00', latest: '21:00' },
  }),
  declare({
    slug: QUEUE_WEEKLY,
    title: 'Weekly review',
    schedules: ['30 16 * * 5'],
    bounds: { earliest: '12:00', latest: '19:00', minIntervalMinutes: 7 * DAILY },
  }),
  declare({
    slug: detectorQueue({ name: 'agent-logs' }),
    title: 'Alert: agent logs stale or skipped',
    schedules: [AGENT_LOGS_DETECTOR_SCHEDULE],
  }),
  ...allDetectors().map((detector) =>
    declare({
      slug: detectorQueue(detector),
      title: `Alert: ${detector.name.replace(/_/g, ' ')}`,
      schedules: [detector.schedule],
      locked: LOCKED_DETECTORS.has(detector.name),
    }),
  ),
  watcherJob(GRAPH_MAIL_WATCHER_NAME, GRAPH_MAIL_SCHEDULES, 'Watch mail'),
  watcherJob(GRAPH_CALENDAR_WATCHER_NAME, GRAPH_CALENDAR_SCHEDULES, 'Watch the calendar'),
  watcherJob(JAMIE_WATCHER_NAME, JAMIE_SCHEDULES, 'Watch Jamie meetings and tasks'),
  watcherJob(AGENT_LOGS_WATCHER_NAME, AGENT_LOGS_SCHEDULES, 'Watch agent logs'),
  watcherJob(NOTION_WATCHER_NAME, NOTION_SCHEDULES, 'Watch Notion tasks'),
];

const BY_SLUG = new Map(SYSTEM_JOBS.map((job) => [job.slug, job]));

export function declarationFor(slug: string): JobDeclaration | undefined {
  return BY_SLUG.get(slug);
}

export function isDeclaredQueue(queue: string): boolean {
  return BY_SLUG.has(queue);
}

export const principalJobs = (): JobDeclaration[] =>
  SYSTEM_JOBS.filter((job) => job.scope === 'principal');

/** Per-principal jobs that run for every principal, not only active ones. */
export const everyStatusJobs = (): JobDeclaration[] =>
  SYSTEM_JOBS.filter((job) => job.scope === 'principal' && job.everyStatus);

export const organisationJobs = (): JobDeclaration[] =>
  SYSTEM_JOBS.filter((job) => job.scope === 'organisation');

/**
 * The window a schedule is sampled over when checked against its bounds:
 * fifteen days from a Monday, so a weekly schedule shows two gaps and a
 * weekday-only one starts on its first day. The limit covers a job that
 * runs every minute across the whole window.
 */
const SAMPLE_FROM = new Date('2026-01-05T00:00:00.000Z');
const SAMPLE_TO = new Date('2026-01-20T00:00:00.000Z');
const SAMPLE_LIMIT = 15 * 24 * 60;

const localHhMm = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);

/** Every run of the given expressions in the sample window, merged and in order. */
function sampleRuns(expressions: readonly string[], timeZone: string): Date[] {
  return expressions
    .flatMap((expression) =>
      occurrencesBetween(expression, {
        timeZone,
        from: SAMPLE_FROM,
        to: SAMPLE_TO,
        limit: SAMPLE_LIMIT,
      }),
    )
    .sort((a, b) => a.getTime() - b.getTime());
}

/** The shortest gap between runs, in minutes; infinite for a schedule that runs once in the sample. */
export function shortestGapMinutes(expressions: readonly string[], timeZone: string): number {
  const runs = sampleRuns(expressions, timeZone);
  let shortest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < runs.length; index += 1) {
    const gap = ((runs[index]?.getTime() ?? 0) - (runs[index - 1]?.getTime() ?? 0)) / 60_000;
    if (gap > 0) shortest = Math.min(shortest, gap);
  }
  return shortest;
}

/** Why `override` falls outside the job's bounds, or null when it is within them. */
export function boundsViolation(
  job: JobDeclaration,
  override: string,
  timeZone: string,
): string | null {
  try {
    assertCron(override);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const minimum = job.bounds.minIntervalMinutes ?? shortestGapMinutes(job.schedules, timeZone);
  const gap = shortestGapMinutes([override], timeZone);
  if (gap < minimum) {
    return `"${override}" runs ${job.slug} every ${String(gap)} minutes, and it may run no more often than every ${String(minimum)}.`;
  }
  const { earliest, latest } = job.bounds;
  if (earliest !== undefined || latest !== undefined) {
    const outside = sampleRuns([override], timeZone).find((run) => {
      const local = localHhMm(run, timeZone);
      return (
        (earliest !== undefined && local < earliest) || (latest !== undefined && local > latest)
      );
    });
    if (outside !== undefined) {
      return `"${override}" runs ${job.slug} at ${localHhMm(outside, timeZone)}, outside ${earliest ?? '00:00'} to ${latest ?? '23:59'}.`;
    }
  }
  return null;
}

export interface EffectiveSchedule {
  readonly schedules: readonly string[];
  /** Set when the principal's override was refused and the defaults apply. */
  readonly refusedOverride: string | null;
}

/** The schedules a job runs on for one principal: their override when it is within bounds, else the defaults. */
export function effectiveSchedules(
  job: JobDeclaration,
  override: string | null,
  timeZone: string,
): EffectiveSchedule {
  if (override === null) return { schedules: job.schedules, refusedOverride: null };
  const violation = boundsViolation(job, override, timeZone);
  if (violation === null) return { schedules: [override], refusedOverride: null };
  return { schedules: job.schedules, refusedOverride: violation };
}
