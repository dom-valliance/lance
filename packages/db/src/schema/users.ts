import { pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, ulid, ulidCheck, updatedAt } from './columns.js';

/**
 * People Lance acts for or resolves identities against (spec section 5.1).
 * One row in v1: Dom. Times are stored UTC and displayed in `time_zone`.
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
