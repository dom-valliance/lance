import { proposals, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { newUlid, nowIso } from '@lance/shared';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { PauseGate } from '../scheduler/gate.js';
import { QUEUES, type ExecuteJob } from '../scheduler/queues.js';

export const EXECUTOR = 'executor';
export const EXECUTOR_ACTOR = 'agent:executor@0.1.0';

export interface ConnectorWrite {
  /** The single connector write for one proposal (spec 7.5 step 3). Phase 1 supplies it. */
  perform(proposalId: string): Promise<{ targetRecordId: string | null }>;
}

export interface ExecutorDeps {
  db: Db;
  gate: PauseGate;
  write: ConnectorWrite;
}

export type ExecuteOutcome =
  | { status: 'held'; reason: string }
  | { status: 'skipped'; reason: string }
  | { status: 'executed'; eventId: string }
  | { status: 'failed'; eventId: string; error: string };

/**
 * Executes one approved proposal. Deterministic code, no model in the loop
 * (CLAUDE.md non-negotiable 2). Phase 0 delivers the gate and the ledger
 * trail; policy re-evaluation and the target hash check arrive in Phase 1
 * alongside the first connector write.
 */
export async function executeProposal(
  deps: ExecutorDeps,
  job: ExecuteJob,
): Promise<ExecuteOutcome> {
  const verdict = await deps.gate.check();
  const rows = await deps.db
    .select()
    .from(proposals)
    .where(eq(proposals.id, job.proposalId))
    .limit(1);
  const proposal = rows[0];
  if (proposal === undefined) {
    return { status: 'skipped', reason: `proposal ${job.proposalId} does not exist` };
  }

  if (!verdict.runnable) {
    if (proposal.status === 'approved' || proposal.status === 'edited') {
      await deps.db
        .update(proposals)
        .set({ status: 'held', updatedAt: new Date(nowIso()) })
        .where(eq(proposals.id, proposal.id));
    }
    return { status: 'held', reason: verdict.reason };
  }

  if (proposal.status !== 'approved' && proposal.status !== 'edited') {
    return {
      status: 'skipped',
      reason: `proposal ${proposal.id} is ${proposal.status}, not approved`,
    };
  }

  const ledger = new LedgerWriter(deps.db);
  await deps.db
    .update(proposals)
    .set({ status: 'executing', updatedAt: new Date(nowIso()) })
    .where(eq(proposals.id, proposal.id));

  try {
    const result = await deps.write.perform(proposal.id);
    const event = await ledger.append({
      ts: nowIso(),
      actor: EXECUTOR_ACTOR,
      kind: 'executed',
      sourceSystem: proposal.targetSystem,
      sourceRecordId: result.targetRecordId,
      correlationId: proposal.correlationId,
      policyDecisionId: null,
      payload: { proposalId: proposal.id, actionClass: proposal.actionClass },
    });
    await deps.db
      .update(proposals)
      .set({ status: 'executed', executionEventId: event.id, updatedAt: new Date(nowIso()) })
      .where(eq(proposals.id, proposal.id));
    return { status: 'executed', eventId: event.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const event = await ledger.append({
      ts: nowIso(),
      actor: EXECUTOR_ACTOR,
      kind: 'failed',
      sourceSystem: proposal.targetSystem,
      correlationId: proposal.correlationId,
      payload: { proposalId: proposal.id, actionClass: proposal.actionClass, error: message },
    });
    await deps.db
      .update(proposals)
      .set({ status: 'failed', executionEventId: event.id, updatedAt: new Date(nowIso()) })
      .where(eq(proposals.id, proposal.id));
    return { status: 'failed', eventId: event.id, error: message };
  }
}

export function registerExecutor(boss: PgBoss, deps: ExecutorDeps): Promise<string> {
  return boss.work<ExecuteJob>(QUEUES.execute, async (jobs) => {
    for (const job of jobs) {
      await executeProposal(deps, job.data);
    }
  });
}

/** Phase 0 stand-in: there are no connector writes yet, so any attempt is a failure with a clear message. */
export const noConnectorWrites: ConnectorWrite = {
  perform(proposalId) {
    return Promise.reject(
      new Error(
        `No connector write is registered for proposal ${proposalId}; connector writes arrive in Phase 1.`,
      ),
    );
  },
};

export function newCorrelationId(): string {
  return newUlid();
}
