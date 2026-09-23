import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { principalStatus } from '../enums.js';
import { createdAt, ulid, ulidCheck, updatedAt } from './columns.js';

/**
 * The people Lance acts for (ADR 0015). Not under row-level security: it
 * is the lookup that turns an Entra object id, a UPN or a Slack user id
 * into the principal whose scope a session then takes. Dom's row reuses
 * his `users` id.
 */
export const principals = pgTable(
  'principals',
  {
    id: ulid('id').primaryKey(),
    entraOid: text('entra_oid').unique(),
    upn: text('upn').notNull().unique(),
    slackUserId: text('slack_user_id').unique(),
    notionUserId: text('notion_user_id'),
    foundryEmployeeId: text('foundry_employee_id'),
    timeZone: text('time_zone').notNull().default('Europe/London'),
    status: principalStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [ulidCheck('principals', 'id')],
);

/**
 * The principal a session is scoped to, as set on its connection by
 * `scopedDb` (ADR 0015). `app_principal()` is created in migration 0009.
 */
const SESSION_PRINCIPAL = sql`app_principal()`;

/**
 * `principal_id` for a principal-bearing table. The default takes the
 * value from the session scope, so no caller ever names a principal, and
 * an unscoped insert defaults to null and is refused by row-level security.
 */
export const principalId = () =>
  ulid('principal_id')
    .notNull()
    .default(SESSION_PRINCIPAL)
    .references(() => principals.id);

/** Nullable, for tables where null means the organisation (ADR 0019). */
export const organisationOrPrincipalId = () =>
  ulid('principal_id')
    .default(SESSION_PRINCIPAL)
    .references(() => principals.id);

export type Principal = typeof principals.$inferSelect;
export type NewPrincipal = typeof principals.$inferInsert;
