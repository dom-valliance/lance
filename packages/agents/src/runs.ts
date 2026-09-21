import { agentRuns, type Db } from '@lance/db';
import { newUlid } from '@lance/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { TokenUsage } from './cost.js';

export interface RunStart {
  agent: string;
  version: string;
  model: string;
  correlationId: string;
  traceId: string | null;
  startedAt: string;
}

export interface RunFinish {
  finishedAt: string;
  status: 'succeeded' | 'failed';
  usage: TokenUsage;
  estimatedCostUsd: number;
  error?: string;
}

/** Records agent_runs rows (spec 5.1, 13). Tests inject an in-memory one. */
export interface RunRecorder {
  start(run: RunStart): Promise<string>;
  finish(runId: string, outcome: RunFinish): Promise<void>;
}

export function dbRunRecorder(db: Db): RunRecorder {
  return {
    async start(run) {
      const id = newUlid();
      await db.insert(agentRuns).values({
        id,
        agent: run.agent,
        version: run.version,
        model: run.model,
        startedAt: new Date(run.startedAt),
        status: 'running',
        traceId: run.traceId,
        correlationId: run.correlationId,
      });
      return id;
    },
    async finish(runId, outcome) {
      await db
        .update(agentRuns)
        .set({
          finishedAt: new Date(outcome.finishedAt),
          status: outcome.status,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          cacheReadTokens: outcome.usage.cacheReadTokens,
          cacheWriteTokens: outcome.usage.cacheWriteTokens,
          estimatedCostUsd: outcome.estimatedCostUsd.toFixed(6),
          error: outcome.error ?? null,
        })
        .where(eq(agentRuns.id, runId));
    },
  };
}

/** Sum of estimated cost for runs started at or after `since`. */
export function dbSpendReader(db: Db, since: () => Date): () => Promise<number> {
  return async () => {
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(${agentRuns.estimatedCostUsd}), 0)` })
      .from(agentRuns)
      .where(and(gte(agentRuns.startedAt, since()), sql`true`));
    return Number(rows[0]?.total ?? 0);
  };
}
