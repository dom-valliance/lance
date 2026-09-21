import { proposals, type Db } from '@lance/db';
import { LedgerWriter, SystemControl } from '@lance/ledger';
import { newUlid, nowIso } from '@lance/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { PauseGate } from '../scheduler/gate.js';
import { QUEUES, type ExecuteJob } from '../scheduler/queues.js';

export const EXECUTOR = 'executor';
export const EXECUTOR_ACTOR = 'agent:executor@0.1.0';

export interface WriteOutcome {
  targetRecordId: string | null;
  url: string | null;
  /** For compensatable actions: what an undo would do (spec 7.5 step 5). */
  compensation: Record<string, unknown> | null;
}

export interface ConnectorWrite {
  /** The single connector write for one proposal (spec 7.5 step 3). */
  perform(proposalId: string): Promise<WriteOutcome>;
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
 * (CLAUDE.md non-negotiable 2). The gate is asked twice, before and after
 * the claim, and refuses while paused or in any mode other than live, so a
 * proposal approved in dry run is held rather than written. Policy is
 * re-evaluated and the target re-checked inside `write.perform`.
 */
export async function executeProposal(
  deps: ExecutorDeps,
  job: ExecuteJob,
): Promise<ExecuteOutcome> {
  const verdict = await deps.gate.checkWrite();
  const rows = await deps.db
    .select()
    .from(proposals)
    .where(eq(proposals.id, job.proposalId))
    .limit(1);
  const proposal = rows[0];
  if (proposal === undefined) {
    return { status: 'skipped', reason: `proposal ${job.proposalId} does not exist` };
  }

  if (proposal.status !== 'approved' && proposal.status !== 'edited') {
    return {
      status: 'skipped',
      reason: `proposal ${proposal.id} is ${proposal.status}, not approved`,
    };
  }

  if (!verdict.runnable) {
    const held = await deps.db
      .update(proposals)
      .set({ status: 'held', updatedAt: new Date(nowIso()) })
      .where(and(eq(proposals.id, proposal.id), inArray(proposals.status, ['approved', 'edited'])))
      .returning({ id: proposals.id });
    if (held.length > 0) {
      await new SystemControl(deps.db).recordHold([{ id: proposal.id, from: proposal.status }], {
        actor: EXECUTOR_ACTOR,
        reason: verdict.reason,
      });
    }
    return { status: 'held', reason: verdict.reason };
  }

  // Compare-and-swap: only the worker that moves the row from approved or
  // edited to executing performs the write, so a redelivered job or a second
  // replica cannot execute the same proposal twice.
  const claimed = await deps.db
    .update(proposals)
    .set({ status: 'executing', updatedAt: new Date(nowIso()) })
    .where(and(eq(proposals.id, proposal.id), inArray(proposals.status, ['approved', 'edited'])))
    .returning({ id: proposals.id });
  if (claimed.length === 0) {
    return { status: 'skipped', reason: `proposal ${proposal.id} was claimed by another worker` };
  }

  // The gate is checked again after the claim so a pause that landed in the
  // meantime stops the write and the proposal goes back to held.
  const recheck = await deps.gate.checkWrite();
  if (!recheck.runnable) {
    await deps.db
      .update(proposals)
      .set({ status: 'held', updatedAt: new Date(nowIso()) })
      .where(eq(proposals.id, proposal.id));
    await new SystemControl(deps.db).recordHold([{ id: proposal.id, from: proposal.status }], {
      actor: EXECUTOR_ACTOR,
      reason: recheck.reason,
    });
    return { status: 'held', reason: recheck.reason };
  }

  const ledger = new LedgerWriter(deps.db);
  try {
    const result = await deps.write.perform(proposal.id);
    const event = await ledger.append({
      ts: nowIso(),
      actor: EXECUTOR_ACTOR,
      kind: 'executed',
      sourceSystem: proposal.targetSystem,
      sourceRecordId: result.targetRecordId,
      correlationId: proposal.correlationId,
      payload: { proposalId: proposal.id, actionClass: proposal.actionClass, url: result.url },
    });
    await deps.db
      .update(proposals)
      .set({
        status: 'executed',
        executionEventId: event.id,
        compensationPayload: result.compensation,
        updatedAt: new Date(nowIso()),
      })
      .where(eq(proposals.id, proposal.id));
    return { status: 'executed', eventId: event.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      error instanceof Error && 'reason' in error && typeof error.reason === 'string'
        ? error.reason
        : null;
    // A changed target is a hold, not a failure (spec 7.5 step 2): the card is updated and nothing is written.
    const held = reason === 'target_changed' || reason === 'forbidden_at_execution';
    const event = await ledger.append({
      ts: nowIso(),
      actor: EXECUTOR_ACTOR,
      kind: 'failed',
      sourceSystem: proposal.targetSystem,
      correlationId: proposal.correlationId,
      payload: {
        proposalId: proposal.id,
        actionClass: proposal.actionClass,
        error: message,
        reason,
        held,
      },
    });
    await deps.db
      .update(proposals)
      .set({
        status: held ? 'held' : 'failed',
        decisionNote: held ? message : undefined,
        executionEventId: held ? undefined : event.id,
        updatedAt: new Date(nowIso()),
      })
      .where(eq(proposals.id, proposal.id));
    return held
      ? { status: 'held', reason: message }
      : { status: 'failed', eventId: event.id, error: message };
  }
}

export function registerExecutor(
  boss: PgBoss,
  deps: ExecutorDeps,
  afterEach?: (proposalId: string, outcome: ExecuteOutcome) => Promise<void>,
): Promise<string> {
  return boss.work<ExecuteJob>(QUEUES.execute, async (jobs) => {
    for (const job of jobs) {
      const outcome = await executeProposal(deps, job.data);
      await afterEach?.(job.data.proposalId, outcome);
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
