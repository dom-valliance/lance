import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';
import { principalStatus } from '../enums.js';
import { createdAt, timestamptz, ulid, ulidCheck, updatedAt } from './columns.js';

/**
 * The people Lance acts for (ADR 0015). It is the lookup that turns an
 * Entra object id, a UPN or a Slack user id into the principal whose scope
 * a session then takes, so every session reads every row. Row-level
 * security (migration 0011, not forced) limits what `lance_app` may write
 * to a first sign-in: an `onboarding` insert, or binding a missing
 * `entra_oid`; an admin scope may change a status. Dom's row reuses his
 * `users` id.
 *
 * `slack_user_id` is written by the database alone, from the principal's
 * active row in `slack_links` (ADR 0021, migration 0014). The principal's
 * own scope may record their Lance app roles and set their private Slack
 * channel once (ADR 0023), and set their own time zone (onboarding step 6).
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
    /**
     * When `status` last changed, stamped by the database on every status
     * change whoever makes it (migration 0020); no role may set it. Null
     * for a row whose status has not changed since the column was added.
     * The role check offboards only a principal whose last status change
     * was its own pause.
     */
    statusChangedAt: timestamptz('status_changed_at'),
    /** The principal's private Slack channel (ADR 0023); every delivery posts here. */
    slackChannelId: text('slack_channel_id').unique(),
    /**
     * The Lance app roles the principal's last verified Entra token carried,
     * recorded at each sign-in and at the Slack link, so a Slack request,
     * which carries no token, can be gated on `Lance.Admin`.
     */
    lanceRoles: text('lance_roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    rolesRecordedAt: timestamptz('roles_recorded_at'),
    /**
     * When the principal finished onboarding and became active (package
     * 5.5), set once by the onboarding completion in an admin scope. Live
     * mode opens five working days after it. Null for a principal who was
     * never onboarded, which is Dom, whose row predates onboarding.
     */
    activatedAt: timestamptz('activated_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    ulidCheck('principals', 'id'),
    check(
      'principals_lance_roles_known',
      sql`${table.lanceRoles} <@ ARRAY['Lance.User', 'Lance.Admin']::text[]`,
    ),
  ],
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
