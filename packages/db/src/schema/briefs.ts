import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { briefKind } from '../enums.js';
import { createdAt, timestamptz, ulid, ulidCheck } from './columns.js';

/**
 * Generated morning briefs, afternoon boards, meeting preps, debriefs and
 * weekly reviews (spec section 5.1). Structured content plus the rendered
 * markdown, linked to the ledger correlation id.
 */
export const briefs = pgTable(
  'briefs',
  {
    id: ulid('id').primaryKey(),
    kind: briefKind('kind').notNull(),
    correlationId: ulid('correlation_id').notNull(),
    content: jsonb('content').notNull(),
    markdown: text('markdown').notNull(),
    generatedAt: timestamptz('generated_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    index('briefs_kind_generated_at_idx').on(table.kind, table.generatedAt),
    index('briefs_correlation_id_idx').on(table.correlationId),
    ulidCheck('briefs', 'id'),
    ulidCheck('briefs', 'correlation_id'),
  ],
);

export type Brief = typeof briefs.$inferSelect;
export type NewBrief = typeof briefs.$inferInsert;
