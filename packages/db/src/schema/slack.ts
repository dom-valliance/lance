import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamptz, ulid, ulidCheck } from './columns.js';
import { principals } from './principals.js';

/**
 * Which principal a Slack user acts for (ADR 0021). A row is written only
 * after the person followed a `/lance login` link and signed in with Entra,
 * so the binding is proven by the holder of both accounts. Every session
 * reads every row, because a Slack request is resolved to a principal
 * before it has a scope; row-level security (migration 0014, enabled and
 * not forced) holds each write to the principal's own scope.
 */
export const slackLinks = pgTable(
  'slack_links',
  {
    slackUserId: text('slack_user_id').primaryKey(),
    slackTeamId: text('slack_team_id').notNull(),
    principalId: ulid('principal_id')
      .notNull()
      .references(() => principals.id),
    linkedAt: timestamptz('linked_at').notNull().defaultNow(),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    ulidCheck('slack_links', 'principal_id'),
    uniqueIndex('slack_links_one_active_per_principal_idx')
      .on(table.principalId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

/**
 * The nonce behind each `/lance login` link (ADR 0021). The link carries
 * the nonce, the expiry and an HMAC over both and the Slack ids stored
 * here; consuming the row sets `used_at`, so a link works once. Row-level
 * security lets a row be consumed only once and only before it expires.
 */
export const slackLinkTokens = pgTable(
  'slack_link_tokens',
  {
    nonce: text('nonce').primaryKey(),
    slackUserId: text('slack_user_id').notNull(),
    slackTeamId: text('slack_team_id').notNull(),
    issuedAt: timestamptz('issued_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
  },
  (table) => [
    check(
      'slack_link_tokens_five_minutes',
      sql`${table.expiresAt} <= ${table.issuedAt} + interval '5 minutes'`,
    ),
    index('slack_link_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * Slack request signatures seen inside the replay window (ADR 0021). A
 * signature that is already here is a replay and is refused; rows are
 * pruned once the window they guard has passed.
 */
export const slackRequestNonces = pgTable(
  'slack_request_nonces',
  {
    signature: text('signature').primaryKey(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [index('slack_request_nonces_expires_at_idx').on(table.expiresAt)],
);

export type SlackLink = typeof slackLinks.$inferSelect;
export type SlackLinkToken = typeof slackLinkTokens.$inferSelect;
