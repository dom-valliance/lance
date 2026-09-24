import { pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, ulid, ulidCheck, updatedAt } from './columns.js';

/**
 * The spec 5.1 users table, kept for compatibility and no longer written
 * (ADR 0015). `principals` replaced it; Dom's principal reuses his id.
 */
export const users = pgTable(
  'users',
  {
    id: ulid('id').primaryKey(),
    upn: text('upn').notNull().unique(),
    slackUserId: text('slack_user_id'),
    notionUserId: text('notion_user_id'),
    timeZone: text('time_zone').notNull().default('Europe/London'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [ulidCheck('users', 'id')],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
