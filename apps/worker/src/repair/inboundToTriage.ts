import { commitments, ledgerEvents, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { newUlid, nowIso } from '@lance/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

/**
 * Moves the open inbound commitments recorded before ADR 0037 into triage.
 * They were tagged inbound on the extractor's old rules, which counted a
 * promise made to anyone on the call, so each is `unconfirmed` until the
 * principal says it is theirs from the To confirm tab.
 *
 * Only `open` rows move, each through the same status change and
 * `commitment_status` ledger event the Commitments page writes. A `chased`
 * row has had a chase sent in the principal's name, so it is theirs and is
 * left alone. `restoreInboundFromTriage` reopens every row this repair moved
 * that is still waiting in triage, found by its ledger actor.
 */

export const REPAIR_ACTOR = 'system:repair-inbound-to-triage';

export const MOVE_REASON =
  'Recorded before inbound commitments needed a definite recipient (ADR 0037); moved to triage to confirm.';

export interface OpenInbound {
  commitmentId: string;
  description: string;
  createdAt: Date;
}

export interface MoveResult {
  moved: string[];
  /** Rows that were no longer open when the move reached them. */
  left: string[];
}

function payloadOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Every open inbound commitment in the scope, oldest first. */
export async function findOpenInbound(db: Db): Promise<OpenInbound[]> {
  const rows = await db
    .select({
      commitmentId: commitments.id,
      description: commitments.description,
      createdAt: commitments.createdAt,
    })
    .from(commitments)
    .where(and(eq(commitments.direction, 'inbound'), eq(commitments.status, 'open')))
    .orderBy(asc(commitments.id));
  return rows;
}

/** Moves each row still open to unconfirmed, one ledger event per row. */
export async function moveInboundToTriage(
  db: Db,
  rows: readonly OpenInbound[],
  now: () => string = nowIso,
): Promise<MoveResult> {
  const writer = new LedgerWriter(db);
  const result: MoveResult = { moved: [], left: [] };
  for (const row of rows) {
    const ts = now();
    const updated = await db
      .update(commitments)
      .set({ status: 'unconfirmed', updatedAt: new Date(ts) })
      .where(
        and(
          eq(commitments.id, row.commitmentId),
          eq(commitments.direction, 'inbound'),
          eq(commitments.status, 'open'),
        ),
      )
      .returning({ id: commitments.id });
    if (updated.length === 0) {
      result.left.push(row.commitmentId);
      continue;
    }
    await writer.append({
      ts,
      actor: REPAIR_ACTOR,
      kind: 'resolved',
      sourceSystem: 'lance',
      sourceRecordId: row.commitmentId,
      correlationId: newUlid(),
      payload: {
        kind: 'commitment_status',
        commitmentId: row.commitmentId,
        from: 'open',
        to: 'unconfirmed',
        reason: MOVE_REASON,
      },
    });
    result.moved.push(row.commitmentId);
  }
  return result;
}

/**
 * Reopens every commitment this repair moved whose last status change is
 * still that move, one ledger event per row. A row the principal has
 * confirmed or dropped since is left as they left it.
 */
export async function restoreInboundFromTriage(
  db: Db,
  now: () => string = nowIso,
): Promise<string[]> {
  const events = await db
    .select({ payload: ledgerEvents.payload })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.actor, REPAIR_ACTOR),
        sql`${ledgerEvents.payload}->>'kind' = 'commitment_status'`,
        sql`${ledgerEvents.payload}->>'to' = 'unconfirmed'`,
      ),
    );
  const ids = [
    ...new Set(
      events.flatMap((event) => {
        const id = payloadOf(event.payload)['commitmentId'];
        return typeof id === 'string' ? [id] : [];
      }),
    ),
  ];
  const writer = new LedgerWriter(db);
  const restored: string[] = [];
  for (const id of ids) {
    const last = await db
      .select({ actor: ledgerEvents.actor, payload: ledgerEvents.payload })
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.sourceRecordId, id),
          sql`${ledgerEvents.payload}->>'kind' = 'commitment_status'`,
        ),
      )
      .orderBy(desc(ledgerEvents.id))
      .limit(1);
    if (last[0]?.actor !== REPAIR_ACTOR || payloadOf(last[0].payload)['to'] !== 'unconfirmed') {
      continue;
    }
    const ts = now();
    const updated = await db
      .update(commitments)
      .set({ status: 'open', updatedAt: new Date(ts) })
      .where(and(eq(commitments.id, id), eq(commitments.status, 'unconfirmed')))
      .returning({ id: commitments.id });
    if (updated.length === 0) continue;
    await writer.append({
      ts,
      actor: REPAIR_ACTOR,
      kind: 'resolved',
      sourceSystem: 'lance',
      sourceRecordId: id,
      correlationId: newUlid(),
      payload: {
        kind: 'commitment_status',
        commitmentId: id,
        from: 'unconfirmed',
        to: 'open',
        reason: 'Restored: the move of inbound commitments to triage was undone.',
      },
    });
    restored.push(id);
  }
  return restored;
}
