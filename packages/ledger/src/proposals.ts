import { proposals, type Db } from '@lance/db';
import { nowIso, type ProposalStatus } from '@lance/shared';
import { eq } from 'drizzle-orm';
import { LedgerWriter } from './writer.js';

export type ProposalAction = 'approve' | 'edit' | 'reject' | 'snooze' | 'expire' | 'hold';

export interface DecisionInput {
  proposalId: string;
  action: ProposalAction;
  /** user:dom from Slack or the UI; system:expiry for the expiry job; agent:executor for holds. */
  actor: string;
  note?: string;
  /** Reject reason code from the Slack modal; training data for the promotion analyser (spec 9.1). */
  reasonCode?: string;
  editedPayload?: Record<string, unknown>;
  snoozeHours?: number;
  now?: () => string;
}

export interface DecisionResult {
  proposalId: string;
  from: ProposalStatus;
  to: ProposalStatus;
  /** True when the executor should now run this proposal. */
  execute: boolean;
  eventId: string;
}

export class ProposalTransitionError extends Error {
  override readonly name = 'ProposalTransitionError';
}

/**
 * The proposal state machine (spec 5.1 statuses, 9.1 actions). Every legal
 * move is listed here and nowhere else; anything not listed is refused with
 * the current status in the message. Snooze keeps the proposal pending and
 * pushes its expiry out. Held proposals can be approved or rejected directly
 * once the reason for the hold has gone.
 */
const TRANSITIONS: Record<
  ProposalAction,
  { from: ProposalStatus[]; to: ProposalStatus; execute: boolean }
> = {
  approve: { from: ['pending', 'held'], to: 'approved', execute: true },
  edit: { from: ['pending', 'held'], to: 'edited', execute: true },
  reject: { from: ['pending', 'held', 'approved', 'edited'], to: 'rejected', execute: false },
  snooze: { from: ['pending'], to: 'pending', execute: false },
  expire: { from: ['pending'], to: 'expired', execute: false },
  hold: { from: ['approved', 'edited'], to: 'held', execute: false },
};

export async function decideProposal(db: Db, input: DecisionInput): Promise<DecisionResult> {
  const now = input.now ?? nowIso;
  const ts = now();
  const rule = TRANSITIONS[input.action];
  if (input.action === 'edit' && input.editedPayload === undefined) {
    throw new ProposalTransitionError('An edit needs the edited payload.');
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.id, input.proposalId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ProposalTransitionError(`Proposal ${input.proposalId} does not exist.`);
    }
    if (!rule.from.includes(row.status)) {
      throw new ProposalTransitionError(
        `Cannot ${input.action} proposal ${row.id}: it is ${row.status}, and ${input.action} applies to ${rule.from.join(' or ')}.`,
      );
    }
    if (
      new Date(row.expiresAt).getTime() < new Date(ts).getTime() &&
      input.action !== 'expire' &&
      input.action !== 'reject'
    ) {
      throw new ProposalTransitionError(
        `Proposal ${row.id} expired at ${row.expiresAt.toISOString()}; it can only be rejected.`,
      );
    }

    const changes: Partial<typeof proposals.$inferInsert> = {
      status: rule.to,
      updatedAt: new Date(ts),
    };
    if (input.action === 'snooze') {
      const hours = input.snoozeHours ?? 4;
      changes.expiresAt = new Date(new Date(ts).getTime() + hours * 3600 * 1000);
    } else if (input.action !== 'hold') {
      changes.decidedBy = input.actor;
      changes.decidedAt = new Date(ts);
      changes.decisionNote = input.note ?? null;
    }
    if (input.action === 'edit') changes.editedPayload = input.editedPayload;

    await tx.update(proposals).set(changes).where(eq(proposals.id, row.id));

    const event = await new LedgerWriter(db).append(
      {
        ts,
        actor: input.actor,
        kind: 'decided',
        sourceSystem: 'lance',
        correlationId: row.correlationId,
        policyDecisionId: null,
        payload: {
          proposalId: row.id,
          action: input.action,
          from: row.status,
          to: rule.to,
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
          ...(input.action === 'edit'
            ? { editedFields: Object.keys(input.editedPayload ?? {}) }
            : {}),
          ...(input.action === 'snooze' ? { snoozeHours: input.snoozeHours ?? 4 } : {}),
        },
      },
      tx,
    );

    return {
      proposalId: row.id,
      from: row.status,
      to: rule.to,
      execute: rule.execute,
      eventId: event.id,
    };
  });
}

/** Expires every pending proposal past its expiry. Returns the ids expired. */
export async function expireProposals(db: Db, now: () => string = nowIso): Promise<string[]> {
  const ts = now();
  const rows = await db
    .select({ id: proposals.id, expiresAt: proposals.expiresAt })
    .from(proposals)
    .where(eq(proposals.status, 'pending'));
  const expired: string[] = [];
  for (const row of rows) {
    if (row.expiresAt.getTime() < new Date(ts).getTime()) {
      await decideProposal(db, {
        proposalId: row.id,
        action: 'expire',
        actor: 'system:expiry',
        now,
      });
      expired.push(row.id);
    }
  }
  return expired;
}
