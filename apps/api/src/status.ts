import { agentRuns, cursors, type Db, type SystemState } from '@lance/db';
import type { SystemMode } from '@lance/shared';
import { gte, sql } from 'drizzle-orm';

/**
 * The `/lance status` and `GET /admin/status` payload (spec 9.2): paused
 * state, mode, every watcher cursor with its age, and today's model spend.
 *
 * The snapshot is data only. `renderStatus` turns it into the plain text
 * Slack shows, so the same numbers reach Slack and the web UI.
 */

export interface CursorStatus {
  watcher: string;
  key: string;
  value: string;
  /** ISO-8601 with an explicit offset. */
  updatedAt: string;
  ageMinutes: number;
}

export interface StatusSnapshot {
  /** The instant the snapshot was taken, ISO-8601 with an explicit offset. */
  at: string;
  paused: boolean;
  pausedReason: string | null;
  pausedBy: string | null;
  pausedAt: string | null;
  mode: SystemMode;
  cursors: CursorStatus[];
  /** Sum of `agent_runs.estimated_cost_usd` for runs started today, in GBP. */
  costTodayGbp: number;
}

export interface StatusSource {
  snapshot(): Promise<StatusSnapshot>;
}

/** The slice of `SystemControl` the status source needs. */
export interface SystemStateReader {
  read(): Promise<SystemState>;
}

export interface DbStatusSourceOptions {
  /**
   * `config.cost.usdToGbp`. Passed in rather than read from config here so
   * the status source stays a database concern and the rate stays one value
   * loaded once at startup.
   */
  usdToGbp: number;
  /** `config.timeZone`. Decides where "today" starts. */
  timeZone: string;
  /** Injected in tests. Defaults to the system clock. */
  now?: () => Date;
}

const MS_PER_MINUTE = 60_000;

/**
 * Offset, in milliseconds, between UTC and `timeZone` at the instant
 * `date`. Positive east of Greenwich. Built from `Intl.DateTimeFormat`
 * rather than a date library, matching `@lance/shared/time`.
 */
const zoneOffsetMs = (date: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      throw new Error(`Could not resolve the ${type} of "${date.toISOString()}" in "${timeZone}".`);
    }
    return Number(value);
  };

  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return asIfUtc - date.getTime() + (date.getTime() % 1000);
};

/**
 * Midnight at the start of `date`'s local day in `timeZone`, as a UTC
 * instant. Re-reads the offset at the candidate midnight so a day that
 * begins either side of a clock change still starts in the right place.
 */
export const startOfLocalDay = (date: Date, timeZone: string): Date => {
  const offset = zoneOffsetMs(date, timeZone);
  const local = new Date(date.getTime() + offset);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const candidate = new Date(localMidnight - offset);
  const candidateOffset = zoneOffsetMs(candidate, timeZone);
  return candidateOffset === offset ? candidate : new Date(localMidnight - candidateOffset);
};

/**
 * Reads the live snapshot from Postgres: `system_state` through
 * `SystemControl`, every `cursors` row, and the `agent_runs` cost total for
 * runs started today in `options.timeZone`.
 */
export const createDbStatusSource = (
  db: Db,
  control: SystemStateReader,
  options: DbStatusSourceOptions,
): StatusSource => {
  const now = options.now ?? ((): Date => new Date());

  return {
    async snapshot(): Promise<StatusSnapshot> {
      const at = now();
      const state = await control.read();

      const cursorRows = await db.select().from(cursors).orderBy(cursors.watcher, cursors.key);

      const dayStart = startOfLocalDay(at, options.timeZone);
      const costRows = await db
        .select({
          totalUsd: sql<string>`coalesce(sum(${agentRuns.estimatedCostUsd}), 0)::text`,
        })
        .from(agentRuns)
        .where(gte(agentRuns.startedAt, dayStart));
      const totalUsd = Number(costRows[0]?.totalUsd ?? '0');

      return {
        at: at.toISOString(),
        paused: state.paused,
        pausedReason: state.pausedReason,
        pausedBy: state.pausedBy,
        pausedAt: state.pausedAt?.toISOString() ?? null,
        mode: state.mode,
        cursors: cursorRows.map((row) => ({
          watcher: row.watcher,
          key: row.key,
          value: row.value,
          updatedAt: row.updatedAt.toISOString(),
          ageMinutes: Math.max(
            0,
            Math.floor((at.getTime() - row.updatedAt.getTime()) / MS_PER_MINUTE),
          ),
        })),
        costTodayGbp: totalUsd * options.usdToGbp,
      };
    },
  };
};

const formatLondon = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));

const formatAge = (ageMinutes: number): string => {
  if (ageMinutes < 1) return 'less than a minute ago';
  if (ageMinutes === 1) return '1 minute ago';
  if (ageMinutes < 120) return `${String(ageMinutes)} minutes ago`;
  return `${String(Math.floor(ageMinutes / 60))} hours ago`;
};

/**
 * Plain text for Slack and the console. British English, no emojis, no
 * Block Kit: the slash command replies inline and Slack renders this as is.
 */
export const renderStatus = (snapshot: StatusSnapshot, displayName: string): string => {
  const lines: string[] = [`${displayName} status`];

  if (snapshot.paused) {
    const reason = snapshot.pausedReason ?? 'no reason recorded';
    const actor = snapshot.pausedBy ?? 'unknown actor';
    const since = snapshot.pausedAt === null ? 'unknown time' : formatLondon(snapshot.pausedAt);
    lines.push(`Paused: yes. Reason: ${reason}. By: ${actor}. Since: ${since}.`);
  } else {
    lines.push('Paused: no.');
  }

  lines.push(`Mode: ${snapshot.mode}.`);

  if (snapshot.cursors.length === 0) {
    lines.push('Watchers: no cursors recorded yet.');
  } else {
    lines.push('Watchers:');
    for (const cursor of snapshot.cursors) {
      lines.push(`  ${cursor.watcher} (${cursor.key}): updated ${formatAge(cursor.ageMinutes)}.`);
    }
  }

  lines.push(`Cost today: GBP ${snapshot.costTodayGbp.toFixed(2)}.`);

  return lines.join('\n');
};
