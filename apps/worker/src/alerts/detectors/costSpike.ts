import { agentRuns } from '@lance/db';
import { hashRecord } from '@lance/shared';
import { gte } from 'drizzle-orm';
import type { DetectedAlert, Detector, DetectorContext } from './types.js';
import { addLocalDays, localDate, localDayStart } from './support.js';

/**
 * `cost_spike` (spec 11): today's model spend against the trailing week.
 * Spend is read from `agent_runs`, which every model call writes (spec 13),
 * so the detector never talks to Anthropic and never depends on a live
 * price lookup.
 */

export const COST_SPIKE_SCHEDULE = '0 * * * *';

/** Spec 11: "day > 2x trailing 7-day mean". */
export const COST_SPIKE_MULTIPLE = 2;
export const TRAILING_DAYS = 7;

/**
 * A mean taken over one or two spending days says nothing; a new watcher or
 * a quiet week would raise a spike on the first ordinary day of work.
 */
export const MIN_DAYS_WITH_SPEND = 3;

function usd(amount: number): string {
  return `USD ${amount.toFixed(2)}`;
}

export const costSpikeDetector: Detector = {
  name: 'cost_spike',
  schedule: COST_SPIKE_SCHEDULE,

  async run(context: DetectorContext): Promise<DetectedAlert[]> {
    const now = context.now();
    const zone = context.config.timeZone;
    const today = localDate(now, zone);
    const from = localDayStart(addLocalDays(today, -TRAILING_DAYS), zone);

    const rows = await context.db
      .select({ startedAt: agentRuns.startedAt, cost: agentRuns.estimatedCostUsd })
      .from(agentRuns)
      .where(gte(agentRuns.startedAt, new Date(from)));

    const totals = new Map<string, number>();
    for (const row of rows) {
      const day = localDate(row.startedAt.toISOString(), zone);
      totals.set(day, (totals.get(day) ?? 0) + Number(row.cost));
    }

    const todayTotal = totals.get(today) ?? 0;
    const trailing = Array.from({ length: TRAILING_DAYS }, (_unused, index) => {
      return totals.get(addLocalDays(today, -(index + 1))) ?? 0;
    });
    const daysWithSpend = trailing.filter((total) => total > 0).length;
    if (daysWithSpend < MIN_DAYS_WITH_SPEND) return [];

    const mean = trailing.reduce((sum, total) => sum + total, 0) / TRAILING_DAYS;
    if (todayTotal <= mean * COST_SPIKE_MULTIPLE) return [];

    const multiple = mean === 0 ? Number.POSITIVE_INFINITY : todayTotal / mean;
    return [
      {
        kind: 'cost_spike',
        severity: 'P1',
        dedupeKey: `date:${today}`,
        title: `Model spend today is ${multiple.toFixed(1)} times the seven-day mean`,
        body: [
          `Agent runs so far today cost ${usd(todayTotal)}, against a mean of ${usd(mean)} over the last ${String(TRAILING_DAYS)} complete days.`,
          'Suggested action: open the Agents page, find which agent and correlation id the spend sits on, and pause or lower that agent if the run was not expected.',
        ].join(' '),
        provenance: [
          {
            system: 'lance',
            recordId: `agent_runs:${today}`,
            hash: hashRecord(todayTotal),
            observedAt: now,
          },
        ],
      },
    ];
  },
};
