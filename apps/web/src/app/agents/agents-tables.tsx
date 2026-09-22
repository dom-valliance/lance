import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import {
  ageLabel,
  isBreakerConcerning,
  truncateTail,
  type AgentStatus,
  type Breaker,
  type WatcherStatus,
} from '@/lib/agents-view';
import { formatGbp } from '@/lib/brief-view';
import { formatInstant } from '@/lib/proposal-view';

/** Every watcher, its partitions and cursors, and how long since it last ran. */
export function WatchersTable({ watchers }: { watchers: WatcherStatus[] }) {
  if (watchers.length === 0) {
    return (
      <TableCard>
        <EmptyState>No watcher is registered.</EmptyState>
      </TableCard>
    );
  }
  return (
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
                          · cursor <span className="font-mono">{partition.cursor}</span> ·{' '}
                          {ageLabel(partition.ageMinutes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Td>
              <Td className="whitespace-nowrap text-xs text-muted-foreground">
                {watcher.startedAt === null ? 'Not started' : formatInstant(watcher.startedAt)}
              </Td>
              <Td className="whitespace-nowrap text-xs">{ageLabel(watcher.lastRunAgeMinutes)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableCard>
  );
}

/** Every model-backed agent, its run and failure counts, cost, and last error. */
export function AgentsTable({ agents }: { agents: AgentStatus[] }) {
  if (agents.length === 0) {
    return (
      <TableCard>
        <EmptyState>No agent has run yet.</EmptyState>
      </TableCard>
    );
  }
  return (
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
              <Tr key={agent.name} {...(agent.failuresToday > 0 ? { accent: 'red' as const } : {})}>
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
  );
}

/** Every connector breaker and its state. */
export function BreakersTable({ breakers }: { breakers: Breaker[] }) {
  if (breakers.length === 0) {
    return (
      <TableCard>
        <EmptyState>No connector has a breaker recorded.</EmptyState>
      </TableCard>
    );
  }
  return (
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
  );
}
