import { occurrencesBetween } from '@lance/shared';

/**
 * The load harness's clock (docs/runbooks/load-test.md). The worker's
 * schedules are the reconciler's real rows in pg-boss; this clock decides
 * when each falls due by running them against virtual time, which is real
 * time shifted so the run opens just before a Monday 06:30. Everything a
 * job does still runs on real time, so every duration it measures is real.
 */

export interface VirtualClock {
  /** Virtual epoch milliseconds now. */
  now(): number;
  /** The real instant a virtual instant falls at. */
  realOf(virtual: Date): number;
  /** The virtual instant a real one falls at. */
  virtualOf(real: number): Date;
}

export function virtualClock(
  virtualStart: Date,
  realStart: number,
  realNow = Date.now,
): VirtualClock {
  const offset = virtualStart.getTime() - realStart;
  return {
    now: () => realNow() + offset,
    realOf: (virtual) => virtual.getTime() - offset,
    virtualOf: (real) => new Date(real + offset),
  };
}

/** The next Monday at `HH:MM` local time in `timeZone`, strictly after `after`. */
export function nextMondayAt(localTime: string, timeZone: string, after: Date): Date {
  const [hour, minute] = localTime.split(':');
  const [next] = occurrencesBetween(`${String(Number(minute))} ${String(Number(hour))} * * 1`, {
    timeZone,
    from: after,
    to: new Date(after.getTime() + 8 * 24 * 3600 * 1000),
    limit: 1,
  });
  if (next === undefined) throw new Error(`No Monday ${localTime} in ${timeZone} within a week.`);
  return next;
}

export interface ScheduleRow {
  name: string;
  key: string;
  cron: string;
  timezone: string | null;
  data?: object | null;
  /** The send options pg-boss stored with the schedule; the group is what the harness forwards. */
  options?: { group?: { id: string; tier?: string } } | null;
}

export interface DueJob {
  schedule: ScheduleRow;
  at: Date;
}

/** Every run of every schedule in (from, to], in time order. */
export function dueBetween(schedules: readonly ScheduleRow[], from: Date, to: Date): DueJob[] {
  if (to <= from) return [];
  const due: DueJob[] = [];
  for (const schedule of schedules) {
    const runs = occurrencesBetween(schedule.cron, {
      timeZone: schedule.timezone ?? 'UTC',
      from,
      to,
      limit: 60,
    });
    for (const at of runs) if (at > from && at <= to) due.push({ schedule, at });
  }
  return due.sort((a, b) => a.at.getTime() - b.at.getTime());
}
