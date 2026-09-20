import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { ledgerKind } from '../enums.js';
import { createdAt, timestamptz, ulid, ulidCheck } from './columns.js';

/**
 * The append-only ledger (spec section 5.1, CLAUDE.md non-negotiable 1).
 *
 * No `updated_at` and no default on `ts`: `ts` is event time supplied by the
 * writer, not insert time. The `ledger_immutable` trigger and the role grants
 * in migration 0002 reject DELETE, TRUNCATE and every UPDATE except the
 * retention payload null described in ADR 0011.
 */
export const ledgerEvents = pgTable(
  'ledger_events',
  {
    id: ulid('id').primaryKey(),
    ts: timestamptz('ts').notNull(),
    actor: text('actor').notNull(),
    kind: ledgerKind('kind').notNull(),
    sourceSystem: text('source_system'),
    sourceRecordId: text('source_record_id'),
    sourceRecordHash: text('source_record_hash'),
    idempotencyKey: text('idempotency_key').unique(),
    correlationId: ulid('correlation_id').notNull(),
    parentEventId: ulid('parent_event_id'),
    policyDecisionId: ulid('policy_decision_id'),
    payload: jsonb('payload'),
    payloadHash: text('payload_hash').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('ledger_events_correlation_id_idx').on(table.correlationId),
    index('ledger_events_kind_ts_idx').on(table.kind, table.ts),
    index('ledger_events_source_record_idx').on(table.sourceSystem, table.sourceRecordId),
    index('ledger_events_ts_idx').on(table.ts),
    ulidCheck('ledger_events', 'id'),
    ulidCheck('ledger_events', 'correlation_id'),
    ulidCheck('ledger_events', 'parent_event_id'),
    ulidCheck('ledger_events', 'policy_decision_id'),
  ],
);

export type LedgerEvent = typeof ledgerEvents.$inferSelect;
export type NewLedgerEvent = typeof ledgerEvents.$inferInsert;
