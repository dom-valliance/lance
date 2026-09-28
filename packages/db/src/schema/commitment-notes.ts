import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { commitments } from './commitments.js';
import { createdAt, ulid, ulidCheck } from './columns.js';
import { principalId } from './principals.js';

/** The longest note the page accepts; the database holds the same limit. */
export const COMMITMENT_NOTE_MAX_CHARS = 4000;

/**
 * The principal's commentary on one commitment, oldest first on the page.
 * Append-only, like the ledger: the application role has SELECT and INSERT
 * only (migration 0022), so a note reads as it was written. Row-level
 * security holds every read and write to the principal's own scope.
 */
export const commitmentNotes = pgTable(
  'commitment_notes',
  {
    id: ulid('id').primaryKey(),
    principalId: principalId(),
    commitmentId: ulid('commitment_id')
      .notNull()
      .references(() => commitments.id),
    body: text('body').notNull(),
    /** The ledger actor who wrote it, `user:<name>`. */
    author: text('author').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('commitment_notes_commitment_id_idx').on(table.commitmentId, table.id),
    ulidCheck('commitment_notes', 'id'),
    check(
      'commitment_notes_body_length',
      sql.raw(`char_length(btrim("body")) BETWEEN 1 AND ${String(COMMITMENT_NOTE_MAX_CHARS)}`),
    ),
  ],
);

export type CommitmentNote = typeof commitmentNotes.$inferSelect;
export type NewCommitmentNote = typeof commitmentNotes.$inferInsert;
