import { index, integer, jsonb, pgTable, real, text } from 'drizzle-orm/pg-core';
import { commitmentDirection, commitmentStatus } from '../enums.js';
import { createdAt, timestamptz, ulid, ulidCheck, updatedAt } from './columns.js';

/**
 * Promises extracted from mail and meetings (spec section 5.1).
 * `outbound` means Dom owes, `inbound` means it is owed to Dom.
 */
export const commitments = pgTable(
  'commitments',
  {
    id: ulid('id').primaryKey(),
    direction: commitmentDirection('direction').notNull(),
    ownerPersonId: text('owner_person_id').notNull(),
    counterpartyPersonId: text('counterparty_person_id').notNull(),
    description: text('description').notNull(),
    dueAt: timestamptz('due_at'),
    dueConfidence: real('due_confidence'),
    evidenceQuote: text('evidence_quote').notNull(),
    sourceRefs: jsonb('source_refs').notNull(),
    status: commitmentStatus('status').notNull().default('open'),
    chaseCount: integer('chase_count').notNull().default(0),
    nextChaseAt: timestamptz('next_chase_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('commitments_status_idx').on(table.status),
    index('commitments_direction_idx').on(table.direction),
    index('commitments_next_chase_at_idx').on(table.nextChaseAt),
    ulidCheck('commitments', 'id'),
  ],
);

export type Commitment = typeof commitments.$inferSelect;
export type NewCommitment = typeof commitments.$inferInsert;
