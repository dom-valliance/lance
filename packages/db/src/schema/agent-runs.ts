import { index, integer, numeric, pgTable, text } from 'drizzle-orm/pg-core';
import { agentRunStatus } from '../enums.js';
import { createdAt, timestamptz, ulid, ulidCheck } from './columns.js';
import { principalId } from './principals.js';

/**
 * One row per agent invocation, for cost and latency accounting
 * (spec section 5.1). Token counts and cost are never null, so a run that
 * fails before the first response still totals correctly.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: ulid('id').primaryKey(),
    principalId: principalId(),
    agent: text('agent').notNull(),
    version: text('version').notNull(),
    model: text('model').notNull(),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
    status: agentRunStatus('status').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    traceId: text('trace_id'),
    correlationId: ulid('correlation_id'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (table) => [
    index('agent_runs_agent_started_at_idx').on(table.agent, table.startedAt),
    index('agent_runs_correlation_id_idx').on(table.correlationId),
    ulidCheck('agent_runs', 'id'),
    ulidCheck('agent_runs', 'correlation_id'),
  ],
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
