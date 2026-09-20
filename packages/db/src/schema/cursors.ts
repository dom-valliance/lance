import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns.js';

/**
 * Watcher cursors (spec section 5.1): one row per watcher per partition, for
 * example per mail folder. Idempotent ingestion depends on these
 * (CLAUDE.md non-negotiable 6).
 */
export const cursors = pgTable(
  'cursors',
  {
    watcher: text('watcher').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.watcher, table.key] })],
);

export type Cursor = typeof cursors.$inferSelect;
export type NewCursor = typeof cursors.$inferInsert;
