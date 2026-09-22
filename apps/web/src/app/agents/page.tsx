import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import {
  ageLabel,
  agentsRouter,
  costBarWidthPercent,
  costPercentLabel,
  isBreakerConcerning,
  isOverCeiling,
  pushesLabel,
  systemStateLabel,
  truncateTail,
} from '@/lib/agents-view';
import { formatDayMonth, formatGbp } from '@/lib/brief-view';
import { formatInstant } from '@/lib/proposal-view';
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
        {watchers.length === 0 ? (
          <TableCard>
            <EmptyState>No watcher is registered.</EmptyState>
          </TableCard>
        ) : (
          <TableCard>
            <Table caption="Watchers, their partitions and their last run">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Partitions</Th>
                  <Th>Started at</Th>
                  <Th>Last run</Th>
                </tr>
              </thead>
              <tbody>
                {watchers.map((watcher) => (
                  <Tr key={watcher.name}>
                    <Td className="font-medium">{watcher.name}</Td>
                    <Td>
                      {watcher.partitions.length === 0 ? (
                        <span className="text-xs text-muted-foreground">No partitions yet</span>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {watcher.partitions.map((partition) => (
                            <li key={partition.key} className="text-xs">
                              <span className="font-mono">{partition.key}</span>
                              <span className="text-muted-foreground">
                                {' '}
                                · cursor <span className="font-mono">
                                  {partition.cursor}
                                </span> · {ageLabel(partition.ageMinutes)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted-foreground">
                      {watcher.startedAt === null
                        ? 'Not started'
                        : formatInstant(watcher.startedAt)}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">
                      {ageLabel(watcher.lastRunAgeMinutes)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableCard>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Agents</h2>
        {agents.length === 0 ? (
          <TableCard>
            <EmptyState>No agent has run yet.</EmptyState>
          </TableCard>
        ) : (
          <TableCard>
            <Table caption="Model-backed agents, their run counts and cost">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Runs today</Th>
                  <Th>Runs 7 days</Th>
                  <Th>Failures today</Th>
                  <Th>Cost today</Th>
                  <Th>Cost 7 days</Th>
                  <Th>Last run</Th>
                  <Th>Last error</Th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const tail = truncateTail(agent.lastError);
                  return (
                    <Tr
                      key={agent.name}
                      {...(agent.failuresToday > 0 ? { accent: 'red' as const } : {})}
                    >
                      <Td className="font-medium">{agent.name}</Td>
                      <Td>{agent.runsToday}</Td>
                      <Td>{agent.runs7Days}</Td>
                      <Td>
                        {agent.failuresToday === 0 ? (
                          agent.failuresToday
                        ) : (
                          <Badge tone="red" size="sm">
                            {agent.failuresToday}
                          </Badge>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap">{formatGbp(agent.costTodayGbp)}</Td>
                      <Td className="whitespace-nowrap">{formatGbp(agent.cost7DaysGbp)}</Td>
                      <Td className="whitespace-nowrap text-xs text-muted-foreground">
                        {agent.lastRunAt === null ? 'Never' : formatInstant(agent.lastRunAt)}
                      </Td>
                      <Td className="max-w-xs text-xs text-muted-foreground">{tail ?? 'None'}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableCard>
        )}
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
          <h2 className="text-base font-semibold">Cost by day</h2>
          {days.length === 0 ? (
            <p className="text-sm text-muted-foreground">No cost recorded yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Cost by day, most recent last</caption>
              <tbody>
                {days.map((day) => (
                  <tr key={day.date} className="border-t border-border first:border-t-0">
                    <td className="py-1.5 text-xs text-muted-foreground">
                      {formatDayMonth(day.date)}
                    </td>
                    <td className="py-1.5 text-right">{formatGbp(day.gbp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Pushes</h2>
        <p className="text-sm text-muted-foreground">{pushesLabel(pushesLastHour)}</p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Breakers</h2>
        {breakers.length === 0 ? (
          <TableCard>
            <EmptyState>No connector has a breaker recorded.</EmptyState>
          </TableCard>
        ) : (
          <TableCard>
            <Table caption="Connector breakers and their state">
              <thead>
                <tr>
                  <Th>Connector</Th>
                  <Th>State</Th>
                  <Th>Open until</Th>
                </tr>
              </thead>
              <tbody>
                {breakers.map((breaker) => (
                  <Tr key={breaker.connector}>
                    <Td className="font-medium">{breaker.connector}</Td>
                    <Td>
                      <Badge tone={isBreakerConcerning(breaker.state) ? 'red' : 'green'} size="sm">
                        {breaker.state}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted-foreground">
                      {breaker.openUntil === null ? 'Not open' : formatInstant(breaker.openUntil)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableCard>
        )}
      </section>
    </div>
  );
}
