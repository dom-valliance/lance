import type { Db } from '@lance/db';
import { ledgerEvents, observations } from '@lance/db';

/** A pool or an open transaction; both expose the same query builders. */
export type DbExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
import {
  LedgerEventInputSchema,
  hashRecord,
  newUlid,
  type LedgerEventInputCandidate,
} from '@lance/shared';
import { eq } from 'drizzle-orm';

export interface AppendResult {
  id: string;
  /** False when an idempotency key matched an existing event and nothing was written. */
  inserted: boolean;
}

export function readString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' ? value : null;
}

export function readStringArray(payload: Record<string, unknown> | null, key: string): string[] {
  const value = payload?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

interface ObservedProvenance {
  sourceSystem: string;
  sourceRecordId: string;
  sourceRecordHash: string;
  idempotencyKey: string;
}

interface ProvenanceFields {
  sourceSystem?: string | null;
  sourceRecordId?: string | null;
  sourceRecordHash?: string | null;
  idempotencyKey?: string | null;
}

/** An observed event without full provenance is a bug in the watcher runner (non-negotiables 5 and 6). */
export function observedProvenance(input: ProvenanceFields): ObservedProvenance {
  const { sourceSystem, sourceRecordId, sourceRecordHash, idempotencyKey } = input;
  if (!sourceSystem || !sourceRecordId || !sourceRecordHash || !idempotencyKey) {
    throw new Error(
      'An observed ledger event needs sourceSystem, sourceRecordId, sourceRecordHash and idempotencyKey; the watcher runner must set all four before appending.',
    );
  }
  return { sourceSystem, sourceRecordId, sourceRecordHash, idempotencyKey };
}

/**
 * The only way anything reaches ledger_events (CLAUDE.md non-negotiable 1).
 *
 * Appends are idempotent on idempotency_key: a repeat returns the existing id
 * and writes nothing. An observed event also materialises its observations
 * row in the same transaction so the two can never disagree.
 */
export class LedgerWriter {
  constructor(private readonly db: Db) {}

  /**
   * Appends inside `executor` when one is given (an open transaction from the
   * caller), so state changes and their ledger events commit together.
   */
  async append(
    candidate: LedgerEventInputCandidate,
    executor: DbExecutor = this.db,
  ): Promise<AppendResult> {
    const input = LedgerEventInputSchema.parse(candidate);
    const id = newUlid();
    const payload = input.payload ?? null;
    const payloadHash = hashRecord(payload);
    if (input.kind === 'observed') observedProvenance(input);

    return executor.transaction(async (tx) => {
      const inserted = await tx
        .insert(ledgerEvents)
        .values({
          id,
          ts: new Date(input.ts),
          actor: input.actor,
          kind: input.kind,
          sourceSystem: input.sourceSystem ?? null,
          sourceRecordId: input.sourceRecordId ?? null,
          sourceRecordHash: input.sourceRecordHash ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          correlationId: input.correlationId,
          parentEventId: input.parentEventId ?? null,
          policyDecisionId: input.policyDecisionId ?? null,
          payload,
          payloadHash,
        })
        .onConflictDoNothing({ target: ledgerEvents.idempotencyKey })
        .returning({ id: ledgerEvents.id });

      const row = inserted[0];
      if (row === undefined) {
        const existing = await tx
          .select({ id: ledgerEvents.id })
          .from(ledgerEvents)
          .where(eq(ledgerEvents.idempotencyKey, input.idempotencyKey ?? ''))
          .limit(1);
        const found = existing[0];
        if (found === undefined) {
          throw new Error(
            'Ledger append conflicted on idempotency_key but no existing event was found; check the unique index on ledger_events.idempotency_key.',
          );
        }
        return { id: found.id, inserted: false };
      }

      if (input.kind === 'observed') {
        const provenance = observedProvenance(input);
        await tx
          .insert(observations)
          .values({
            id,
            ts: new Date(input.ts),
            ...provenance,
            correlationId: input.correlationId,
            summary: readString(payload, 'summary'),
            labels: readStringArray(payload, 'labels'),
            payload,
          })
          .onConflictDoNothing();
      }

      return { id: row.id, inserted: true };
    });
  }
}
