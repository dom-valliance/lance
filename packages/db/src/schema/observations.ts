import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, ulid, ulidCheck } from './columns.js';
import { principalId } from './principals.js';

/**
 * Normalised `observed` events, for query convenience (spec section 5.1).
 *
 * This is a plain table, not a view: it is materialised by the ledger writer
 * in the same transaction as the ledger insert, and is rebuildable in full
 * from `ledger_events`. `id` is the ledger event id. The application role has
 * SELECT and INSERT only, as it does on the ledger itself.
 */
export const observations = pgTable(
  'observations',
  {
    id: ulid('id').primaryKey(),
    principalId: principalId(),
    ts: timestamptz('ts').notNull(),
    sourceSystem: text('source_system').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    sourceRecordHash: text('source_record_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    correlationId: ulid('correlation_id').notNull(),
    summary: text('summary'),
    labels: text('labels').array().notNull().default([]),
    payload: jsonb('payload'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('observations_principal_idempotency_key_idx').on(
      table.principalId,
      table.idempotencyKey,
    ),
    index('observations_principal_id_idx').on(table.principalId, table.id),
    index('observations_correlation_id_idx').on(table.correlationId),
    index('observations_source_record_idx').on(table.sourceSystem, table.sourceRecordId),
    index('observations_ts_idx').on(table.ts),
    ulidCheck('observations', 'id'),
    ulidCheck('observations', 'correlation_id'),
  ],
);

export type Observation = typeof observations.$inferSelect;
export type NewObservation = typeof observations.$inferInsert;
