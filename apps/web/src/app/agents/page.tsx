import { AgentsTable, BreakersTable, WatchersTable } from '@/app/agents/agents-tables';
import { CostByDay } from '@/app/agents/cost-by-day';
import { PageHeader } from '@/components/page-header';
import {
  agentsRouter,
  costBarWidthPercent,
  costPercentLabel,
  isOverCeiling,
  pushesLabel,
  systemStateLabel,
} from '@/lib/agents-view';
import { formatGbp } from '@/lib/brief-view';
import { apiClient } from '@/lib/trpc';

export const dynamic = 'force-dynamic';

/** The 14-day cost table shows at most this many rows, most recent last. */
const COST_DAYS = 14;

export default async function AgentsPage() {
  const client = await apiClient();
  const status = await agentsRouter(client).status.query();
  const { system, watchers, agents, costToday, costByDay, pushesLastHour, breakers } = status;
  const days = costByDay.slice(-COST_DAYS);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agents"
        summary="Every agent and watcher with its last run, cursor age, breaker state, error tail, and cost today and over seven days."
      />

      <section className="rounded-xl bg-card p-6">
        <h2 className="text-base font-semibold">System</h2>
        <p className="mt-2 text-sm text-muted-foreground">{systemStateLabel(system)}</p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Watchers</h2>
        <WatchersTable watchers={watchers} />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Agents</h2>
        <AgentsTable agents={agents} />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-xl bg-card p-6">
          <h2 className="text-base font-semibold">Cost today</h2>
          <div
            role="progressbar"
            aria-valuenow={Math.round(costToday.fraction * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Cost today against the ceiling"
            className="h-3 overflow-hidden rounded-full bg-muted"
          >
            <div
              style={{ width: `${String(costBarWidthPercent(costToday.fraction))}%` }}
              className={
                isOverCeiling(costToday.fraction) ? 'h-full bg-sem-red-fg' : 'h-full bg-brand'
              }
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {formatGbp(costToday.gbp)} of the {formatGbp(costToday.ceilingGbp)} ceiling (
            {costPercentLabel(costToday.fraction)})
            {isOverCeiling(costToday.fraction) ? ', over budget.' : '.'}
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-xl bg-card p-6">
          {days.length === 0 ? (
            <>
              <h2 className="text-base font-semibold">Cost by day</h2>
              <p className="text-sm text-muted-foreground">No cost recorded yet.</p>
            </>
          ) : (
            <CostByDay days={days} ceilingGbp={costToday.ceilingGbp} />
          )}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Pushes</h2>
        <p className="text-sm text-muted-foreground">{pushesLabel(pushesLastHour)}</p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Breakers</h2>
        <BreakersTable breakers={breakers} />
      </section>
    </div>
  );
}
