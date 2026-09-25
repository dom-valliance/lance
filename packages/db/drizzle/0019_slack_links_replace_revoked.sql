-- A revoked Slack link no longer blocks a new binding (ADR 0021).
--
-- slack_links was keyed on the Slack user id, so a Slack user whose link was
-- revoked (offboarding, an unlink, a mistaken binding) could never be linked
-- again: the insert collided with the revoked row, and the update policy
-- lets only the row's own principal or an admin touch it. Each binding is
-- now a row of its own, kept after it is revoked, keyed on the Slack user
-- and the time it was linked.
--
-- The limits of migration 0014 stand unchanged, and the database still
-- enforces them for lance_app:
--   * a new binding is inserted only in the scope of the principal it binds,
--     and only active (policy slack_links_link);
--   * a Slack user has at most one active binding (the partial unique index
--     below replaces the primary key in that role), so an active link
--     cannot be claimed by anyone else;
--   * a principal has at most one active binding;
--   * the Slack user, the team and the principal of a row stay fixed (column
--     grants), and nothing may delete a row.
-- A principal renewing their own revoked row while the Slack user is bound
-- to someone else is refused by the same unique index.

CREATE UNIQUE INDEX "slack_links_one_active_per_slack_user_idx" ON "slack_links" USING btree ("slack_user_id") WHERE "slack_links"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "slack_links" DROP CONSTRAINT "slack_links_pkey";--> statement-breakpoint
ALTER TABLE "slack_links" ADD CONSTRAINT "slack_links_slack_user_id_linked_at_pk" PRIMARY KEY("slack_user_id","linked_at");
