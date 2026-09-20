import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { alertSeverity, alertStatus } from '../enums.js';
import { createdAt, timestamptz, ulid, ulidCheck, updatedAt } from './columns.js';

/**
 * Alerts raised by watchers, the critic and the executor (spec section 5.1).
 * `dedupe_key` collapses repeats into one row with a rising `count`.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: ulid('id').primaryKey(),
    severity: alertSeverity('severity').notNull(),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    provenance: jsonb('provenance').notNull(),
    status: alertStatus('status').notNull().default('open'),
    firstSeen: timestamptz('first_seen').notNull().defaultNow(),
    lastSeen: timestamptz('last_seen').notNull().defaultNow(),
    count: integer('count').notNull().default(1),
    ackedBy: text('acked_by'),
    ackedAt: timestamptz('acked_at'),
    mutedUntil: timestamptz('muted_until'),
    slackTs: text('slack_ts'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('alerts_status_idx').on(table.status),
    index('alerts_severity_idx').on(table.severity),
    index('alerts_last_seen_idx').on(table.lastSeen),
    ulidCheck('alerts', 'id'),
  ],
);

export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
