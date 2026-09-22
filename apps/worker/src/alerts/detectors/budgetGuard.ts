import { budgetState, BUDGET_WARNING_FRACTION } from '@lance/agents';
import { agentRuns } from '@lance/db';
import { hashRecord } from '@lance/shared';
import { gte } from 'drizzle-orm';
import type { DetectedAlert, Detector, DetectorContext } from './types.js';
import { localDate, localDayStart } from './support.js';

/**
 * The budget guard (spec 13): "a daily spend ceiling (default GBP 15).
 * Crossing 80% raises P1; crossing 100% pauses model-backed agents
 * (watchers continue) and raises P0."
 *
 * The pause is not this detector's doing. `runAgent` refuses to call a
 * model once `budgetState` says `exceeded`, so the pause holds whether or
 * not the alert was ever raised; the detector's job is to say so out loud.
 * Both read the same threshold from `@lance/agents`.
 *
 * Spec 11 has no alert kind of its own for the budget, so these ride on
 * `cost_spike` with their own dedupe keys, which keeps the two thresholds
 * and the trailing-mean spike three separate rows on the alerts page.
 */

export const BUDGET_GUARD_SCHEDULE = '*/15 * * * *';

const WARNING_PERCENT = Math.round(BUDGET_WARNING_FRACTION * 100);

function gbp(amount: number): string {
  return `GBP ${amount.toFixed(2)}`;
}

export const budgetGuardDetector: Detector = {
  name: 'budget_guard',
  schedule: BUDGET_GUARD_SCHEDULE,

  async run(context: DetectorContext): Promise<DetectedAlert[]> {
    const now = context.now();
    const zone = context.config.timeZone;
    const today = localDate(now, zone);
    const { usdToGbp } = context.config.cost;
    const dailyCeilingGbp =
      (await context.control?.read())?.costCeilingGbp ?? context.config.cost.dailyCeilingGbp;

    const rows = await context.db
      .select({ cost: agentRuns.estimatedCostUsd })
      .from(agentRuns)
      .where(gte(agentRuns.startedAt, new Date(localDayStart(today, zone))));
    const spendUsd = rows.reduce((sum, row) => sum + Number(row.cost), 0);

    const state = budgetState(spendUsd, dailyCeilingGbp, usdToGbp);
    if (state === 'ok') return [];

    const spentGbp = spendUsd * usdToGbp;
    const provenance = [
      {
        system: 'lance' as const,
        recordId: `agent_runs:${today}`,
        hash: hashRecord(spendUsd),
        observedAt: now,
      },
    ];

    if (state === 'warning') {
      return [
        {
          kind: 'cost_spike',
          severity: 'P1',
          dedupeKey: `budget:${String(WARNING_PERCENT)}:${today}`,
          title: `Daily model spend at ${String(WARNING_PERCENT)}% of the ceiling`,
          body: [
            `Model-backed agents have spent ${gbp(spentGbp)} of today's ${gbp(dailyCeilingGbp)} ceiling.`,
            'Suggested action: let the day run if the work is expected, or raise the ceiling in Settings before the remaining spend is refused.',
          ].join(' '),
          provenance,
        },
      ];
    }

    return [
      {
        kind: 'cost_spike',
        severity: 'P0',
        dedupeKey: `budget:100:${today}`,
        title: 'Daily model spend has reached the ceiling',
        body: [
          `Model-backed agents have spent ${gbp(spentGbp)} against today's ${gbp(dailyCeilingGbp)} ceiling and are paused until midnight.`,
          'Watchers continue, so nothing stops being observed; triage, the planner, the critic and the chase wait.',
          'Suggested action: raise the ceiling in Settings to resume today, or leave it and the agents start again tomorrow.',
        ].join(' '),
        provenance,
      },
    ];
  },
};
