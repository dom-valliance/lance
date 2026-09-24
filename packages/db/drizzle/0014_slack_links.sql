-- Slack identity bound by the user, and a private surface per principal
-- (ADR 0021, ADR 0023, docs/plans/multi-user.md M4).
--
-- slack_links says which principal a Slack user acts for. A Slack request is
-- resolved to a principal before it has a scope, as an Entra token is through
-- principals, so every session reads every row: row-level security is
-- enabled, not forced, and holds each write to the principal's own scope.
-- lance_migrator owns the tables and the migration job keeps writing them.
--
-- principals.slack_user_id stops being something anyone sets. The database
-- fills it from the principal's active link, through a trigger owned by
-- lance_migrator, so the existing lookups read a proven binding. The values
-- recorded before links existed were never proven by the person and are
-- cleared here; SLACK_ALLOWED_USER_ID covers Dom until he links.
--
-- slack_link_tokens holds the nonce behind each /lance login link and
-- slack_request_nonces the Slack request signatures seen inside the replay
-- window. Neither names a principal. Row-level security on both lets the
-- database, not only the code, refuse a second use of a link, a link used
-- after it expired, and the removal of anything still inside its window.

CREATE TABLE "slack_link_tokens" (
	"nonce" text PRIMARY KEY NOT NULL,
	"slack_user_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "slack_link_tokens_five_minutes" CHECK ("slack_link_tokens"."expires_at" <= "slack_link_tokens"."issued_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "slack_links" (
	"slack_user_id" text PRIMARY KEY NOT NULL,
	"slack_team_id" text NOT NULL,
	"principal_id" char(26) NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "slack_links_principal_id_ulid" CHECK ("principal_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "slack_request_nonces" (
	"signature" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "principals" ADD COLUMN "slack_channel_id" text;--> statement-breakpoint
ALTER TABLE "principals" ADD COLUMN "lance_roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "principals" ADD COLUMN "roles_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_links" ADD CONSTRAINT "slack_links_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_link_tokens_expires_at_idx" ON "slack_link_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_links_one_active_per_principal_idx" ON "slack_links" USING btree ("principal_id") WHERE "slack_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "slack_request_nonces_expires_at_idx" ON "slack_request_nonces" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_slack_channel_id_unique" UNIQUE("slack_channel_id");--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_lance_roles_known" CHECK ("principals"."lance_roles" <@ ARRAY['Lance.User', 'Lance.Admin']::text[]);
--> statement-breakpoint
-- Unproven Slack ids go; the link trigger below writes proven ones.
UPDATE principals SET slack_user_id = NULL WHERE slack_user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE slack_links OWNER TO lance_migrator;
--> statement-breakpoint
ALTER TABLE slack_link_tokens OWNER TO lance_migrator;
--> statement-breakpoint
ALTER TABLE slack_request_nonces OWNER TO lance_migrator;
--> statement-breakpoint
-- Default privileges may have granted lance_app everything on the new
-- tables; take it back and grant exactly the writes the policies allow.
REVOKE ALL ON slack_links, slack_link_tokens, slack_request_nonces FROM lance_app;
--> statement-breakpoint
ALTER TABLE slack_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY slack_links_read ON slack_links FOR SELECT USING (true);
--> statement-breakpoint
-- A link is created in the scope of the principal it binds, and active.
CREATE POLICY slack_links_link ON slack_links FOR INSERT
  WITH CHECK (principal_id = app_principal() AND revoked_at IS NULL);
--> statement-breakpoint
-- A principal may revoke or renew their own links; an admin scope may revoke
-- anyone's (offboarding). The column grants keep the ids themselves fixed.
CREATE POLICY slack_links_own ON slack_links FOR UPDATE
  USING (principal_id = app_principal() OR app_is_admin())
  WITH CHECK (principal_id = app_principal() OR app_is_admin());
--> statement-breakpoint
GRANT SELECT ON slack_links TO lance_app;
--> statement-breakpoint
GRANT INSERT (slack_user_id, slack_team_id, principal_id, linked_at) ON slack_links TO lance_app;
--> statement-breakpoint
GRANT UPDATE (linked_at, revoked_at) ON slack_links TO lance_app;
--> statement-breakpoint
-- principals.slack_user_id follows the active link. SECURITY DEFINER, owned
-- by lance_migrator, which owns principals and passes principals_guard; the
-- search path is pinned so a caller cannot redirect the tables it names.
CREATE FUNCTION slack_links_sync() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.revoked_at IS NULL THEN
    UPDATE principals SET slack_user_id = NULL, updated_at = now()
      WHERE slack_user_id = NEW.slack_user_id AND id <> NEW.principal_id;
    UPDATE principals SET slack_user_id = NEW.slack_user_id, updated_at = now()
      WHERE id = NEW.principal_id AND slack_user_id IS DISTINCT FROM NEW.slack_user_id;
  ELSE
    UPDATE principals SET slack_user_id = NULL, updated_at = now()
      WHERE id = NEW.principal_id AND slack_user_id = NEW.slack_user_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION slack_links_sync() OWNER TO lance_migrator;
--> statement-breakpoint
REVOKE ALL ON FUNCTION slack_links_sync() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER slack_links_sync AFTER INSERT OR UPDATE ON slack_links
  FOR EACH ROW EXECUTE FUNCTION slack_links_sync();
--> statement-breakpoint
ALTER TABLE slack_link_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY slack_link_tokens_read ON slack_link_tokens FOR SELECT USING (true);
--> statement-breakpoint
-- A token is issued unused, for five minutes at most from now.
CREATE POLICY slack_link_tokens_issue ON slack_link_tokens FOR INSERT
  WITH CHECK (
    used_at IS NULL AND expires_at > now() AND expires_at <= now() + interval '5 minutes'
  );
--> statement-breakpoint
-- Consuming marks an unused, unexpired token used, once.
CREATE POLICY slack_link_tokens_consume ON slack_link_tokens FOR UPDATE
  USING (used_at IS NULL AND expires_at > now())
  WITH CHECK (used_at IS NOT NULL);
--> statement-breakpoint
CREATE POLICY slack_link_tokens_prune ON slack_link_tokens FOR DELETE USING (expires_at < now());
--> statement-breakpoint
GRANT SELECT, DELETE ON slack_link_tokens TO lance_app;
--> statement-breakpoint
GRANT INSERT (nonce, slack_user_id, slack_team_id, expires_at) ON slack_link_tokens TO lance_app;
--> statement-breakpoint
GRANT UPDATE (used_at) ON slack_link_tokens TO lance_app;
--> statement-breakpoint
ALTER TABLE slack_request_nonces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY slack_request_nonces_read ON slack_request_nonces FOR SELECT USING (true);
--> statement-breakpoint
-- Slack signs requests up to five minutes either side of now, so an entry
-- is never needed for longer than ten minutes from now.
CREATE POLICY slack_request_nonces_record ON slack_request_nonces FOR INSERT
  WITH CHECK (expires_at <= now() + interval '10 minutes');
--> statement-breakpoint
CREATE POLICY slack_request_nonces_prune ON slack_request_nonces FOR DELETE
  USING (expires_at < now());
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON slack_request_nonces TO lance_app;
--> statement-breakpoint
-- The principal's own scope may record their Lance app roles and set their
-- private channel once. principals_guard below holds every other column.
CREATE POLICY principals_self_update ON principals FOR UPDATE
  USING (id = app_principal())
  WITH CHECK (id = app_principal());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION principals_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_has_role(current_user, 'lance_migrator', 'USAGE') THEN
    RETURN NEW;
  END IF;

  -- Written only by slack_links_sync, which runs as lance_migrator.
  IF NEW.slack_user_id IS DISTINCT FROM OLD.slack_user_id THEN
    RAISE EXCEPTION
      'principals: slack_user_id follows the principal''s active Slack link (ADR 0021)'
      USING HINT = 'Link the Slack user through /lance login, which writes slack_links.';
  END IF;

  IF app_is_admin() THEN
    RETURN NEW;
  END IF;

  IF OLD.entra_oid IS NULL AND NEW.entra_oid IS NOT NULL THEN
    IF (to_jsonb(NEW) - 'entra_oid' - 'updated_at') IS DISTINCT FROM
       (to_jsonb(OLD) - 'entra_oid' - 'updated_at') THEN
      RAISE EXCEPTION
        'principals: binding an entra_oid may not change any other column (ADR 0020)'
        USING HINT = 'Set entra_oid and updated_at alone. Status changes need an admin scope.';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.id = app_principal() THEN
    IF OLD.slack_channel_id IS NOT NULL
       AND NEW.slack_channel_id IS DISTINCT FROM OLD.slack_channel_id THEN
      RAISE EXCEPTION
        'principals: a principal''s Slack channel is set once (ADR 0023)'
        USING HINT = 'Changing or archiving a principal''s channel is an admin action.';
    END IF;
    IF (to_jsonb(NEW) - 'lance_roles' - 'roles_recorded_at' - 'slack_channel_id' - 'updated_at')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'lance_roles' - 'roles_recorded_at' - 'slack_channel_id' - 'updated_at') THEN
      RAISE EXCEPTION
        'principals: a principal''s own scope may change only their roles and their Slack channel (ADR 0021, ADR 0023)'
        USING HINT = 'Status changes need an admin scope; the Entra object id is bound once.';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'principals: outside an admin scope an update may only bind a missing entra_oid (ADR 0020)'
    USING HINT = 'A principal already bound to an Entra object keeps it. Changing it is an admin repair.';
END;
$$;
--> statement-breakpoint
GRANT UPDATE (lance_roles, roles_recorded_at, slack_channel_id) ON principals TO lance_app;
