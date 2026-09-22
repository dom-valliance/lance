import { agentRuns, cursors, ledgerEvents, type Db } from '@lance/db';
import type { AgentRunStatus } from '@lance/shared';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';

/**
 * The four reads behind the Agents page (spec 12, Agents row): watcher
 * cursors, agent runs for the cost and failure counts, the last run of
 * every agent that has ever run, and the interruption pushes in the last
 * hour. Read-only: nothing on the Agents page changes state.
 */

export interface CursorRow {
  watcher: string;
  key: string;
  value: string;
  updatedAt: Date;
}

export interface AgentRunRow {
  agent: string;
  startedAt: Date;
  status: AgentRunStatus;
  /** `estimated_cost_usd` as a number; the column is `numeric`, so it arrives as text. */
  costUsd: number;
  error: string | null;
}

export interface AgentLastRun {
  agent: string;
  startedAt: Date;
  /** The error of that last run, not of the last run that failed. */
  error: string | null;
}

export interface AgentsStoreLike {
  /** Every cursor row, watcher and key ascending. */
  listCursors(): Promise<CursorRow[]>;
  /** Runs started at or after `since`, for the counts and the cost chart. */
  runsSince(since: Date): Promise<AgentRunRow[]>;
  /** One row per agent: its most recent run. Names agents that have not run lately. */
  lastRuns(): Promise<AgentLastRun[]>;
  /** Unsolicited Slack posts recorded since `since` (spec 9.4). */
  pushesSince(since: Date): Promise<number>;
}

/** The ledger payload discriminator `recordPush` writes for every push. */
const PUSH_PAYLOAD_KIND = 'slack_push';

export function createAgentsStore(db: Db): AgentsStoreLike {
  return {
    async listCursors(): Promise<CursorRow[]> {
      return db
        .select({
          watcher: cursors.watcher,
          key: cursors.key,
          value: cursors.value,
          updatedAt: cursors.updatedAt,
        })
        .from(cursors)
        .orderBy(asc(cursors.watcher), asc(cursors.key));
    },

    async runsSince(since: Date): Promise<AgentRunRow[]> {
      const rows = await db
        .select({
          agent: agentRuns.agent,
          startedAt: agentRuns.startedAt,
          status: agentRuns.status,
          costUsd: agentRuns.estimatedCostUsd,
          error: agentRuns.error,
        })
        .from(agentRuns)
        .where(gte(agentRuns.startedAt, since))
        .orderBy(asc(agentRuns.startedAt));
      return rows.map((row) => ({ ...row, costUsd: Number(row.costUsd) }));
    },

    async lastRuns(): Promise<AgentLastRun[]> {
      return db
        .selectDistinctOn([agentRuns.agent], {
          agent: agentRuns.agent,
          startedAt: agentRuns.startedAt,
          error: agentRuns.error,
        })
        .from(agentRuns)
        .orderBy(asc(agentRuns.agent), desc(agentRuns.startedAt));
    },

    async pushesSince(since: Date): Promise<number> {
      // The same predicate the worker's budget uses, so the page and the
      // budget can never disagree about how loud the hour has been.
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(ledgerEvents)
        .where(
          and(
            eq(ledgerEvents.kind, 'resolved'),
            gte(ledgerEvents.ts, since),
            sql`${ledgerEvents.payload} ->> 'kind' = ${PUSH_PAYLOAD_KIND}`,
          ),
        );
      return rows[0]?.count ?? 0;
    },
  };
}
