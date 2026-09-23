-- Principals, a principal_id on every principal-bearing table, and forced
-- row-level security (ADR 0015, docs/plans/ontology.md section 4).
--
-- The ledger trigger rejects UPDATE, so existing rows are never updated.
-- ADD COLUMN with a constant default fills them without firing row triggers;
-- the default is then switched to the session scope. A database with no
-- users row has no rows to backfill: the columns take the session default
-- from the start and the seed creates the first principal.

CREATE TYPE "public"."principal_status" AS ENUM('onboarding', 'active', 'paused', 'offboarded');
--> statement-breakpoint
-- The principal a session is scoped to, set on each connection checkout by
-- scopedDb in @lance/db. Null when the session is unscoped.
CREATE FUNCTION app_principal() RETURNS char(26)
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.principal', true), '')::char(26) $$;
--> statement-breakpoint
-- True when the session was opened as an admin scope, the only scope that
-- may write organisation rows (ADR 0015, ADR 0019).
CREATE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT coalesce(current_setting('app.role', true), '') = 'admin' $$;
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"entra_oid" text,
	"upn" text NOT NULL,
	"slack_user_id" text,
	"notion_user_id" text,
	"foundry_employee_id" text,
	"time_zone" text DEFAULT 'Europe/London' NOT NULL,
	"status" "principal_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_entra_oid_unique" UNIQUE("entra_oid"),
	CONSTRAINT "principals_upn_unique" UNIQUE("upn"),
	CONSTRAINT "principals_slack_user_id_unique" UNIQUE("slack_user_id"),
	CONSTRAINT "principals_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "principal_state" (
	"principal_id" char(26) PRIMARY KEY DEFAULT app_principal() NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"paused_by" text,
	"paused_at" timestamp with time zone,
	"mode" "system_mode" DEFAULT 'dry_run' NOT NULL,
	"quiet_hours_start" text DEFAULT '19:00' NOT NULL,
	"quiet_hours_end" text DEFAULT '07:00' NOT NULL,
	"push_budget_per_hour" integer DEFAULT 3 NOT NULL,
	"cost_ceiling_gbp" numeric(10, 2) DEFAULT 15 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Dom's principal from the one users row, reusing its id. The per-principal
-- run state moves to principal_state; the global row keeps its mode, which
-- is now a ceiling, and its cost ceiling, which is now the organisation's.
DO $$
DECLARE
  user_count integer;
  dom_id char(26);
BEGIN
  SELECT count(*) INTO user_count FROM users;
  IF user_count > 1 THEN
    RAISE EXCEPTION 'Migration 0009 expects at most one users row and found %', user_count
      USING HINT = 'v1 has one principal. Decide which row is the principal before migrating.';
  END IF;
  IF user_count = 0 THEN
    RETURN;
  END IF;

  SELECT id INTO dom_id FROM users;
  INSERT INTO principals (id, upn, slack_user_id, notion_user_id, time_zone, created_at, updated_at)
  SELECT id, upn, slack_user_id, notion_user_id, time_zone, created_at, updated_at FROM users;

  INSERT INTO principal_state (
    principal_id, paused, paused_reason, paused_by, paused_at, mode,
    quiet_hours_start, quiet_hours_end, push_budget_per_hour, cost_ceiling_gbp
  )
  SELECT dom_id, paused, paused_reason, paused_by, paused_at, mode,
    quiet_hours_start, quiet_hours_end, push_budget_per_hour, cost_ceiling_gbp
  FROM system_state WHERE id = 1;

  UPDATE system_state
  SET paused = false, paused_reason = NULL, paused_by = NULL, paused_at = NULL, updated_at = now()
  WHERE id = 1;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  dom_id char(26);
  target text;
BEGIN
  SELECT id INTO dom_id FROM principals;

  FOREACH target IN ARRAY ARRAY[
    'ledger_events', 'observations', 'proposals', 'policy_decisions', 'cursors',
    'alerts', 'commitments', 'briefs', 'agent_runs'
  ] LOOP
    IF dom_id IS NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN principal_id char(26) NOT NULL DEFAULT app_principal()',
        target
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN principal_id char(26) NOT NULL DEFAULT %L',
        target, dom_id
      );
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN principal_id SET DEFAULT app_principal()',
        target
      );
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
-- Existing rules are the v1 seed rules and become organisation defaults.
ALTER TABLE "policy_rules" ADD COLUMN "principal_id" char(26);
--> statement-breakpoint
ALTER TABLE "policy_rules" ALTER COLUMN "principal_id" SET DEFAULT app_principal();
--> statement-breakpoint
ALTER TABLE "ledger_events" DROP CONSTRAINT "ledger_events_idempotency_key_unique";
--> statement-breakpoint
ALTER TABLE "observations" DROP CONSTRAINT "observations_idempotency_key_unique";
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_dedupe_key_unique";
--> statement-breakpoint
ALTER TABLE "cursors" DROP CONSTRAINT "cursors_watcher_key_pk";
--> statement-breakpoint
ALTER TABLE "cursors" ADD CONSTRAINT "cursors_principal_id_watcher_key_pk" PRIMARY KEY("principal_id","watcher","key");
--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_events_principal_idempotency_key_idx" ON "ledger_events" USING btree ("principal_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "ledger_events_principal_id_idx" ON "ledger_events" USING btree ("principal_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "observations_principal_idempotency_key_idx" ON "observations" USING btree ("principal_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "observations_principal_id_idx" ON "observations" USING btree ("principal_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_principal_dedupe_key_idx" ON "alerts" USING btree ("principal_id","dedupe_key");
--> statement-breakpoint
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'principal_state', 'ledger_events', 'observations', 'proposals', 'policy_rules',
    'policy_decisions', 'cursors', 'alerts', 'commitments', 'briefs', 'agent_runs'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (principal_id) REFERENCES public.principals(id)',
      target, target || '_principal_id_principals_id_fk'
    );
  END LOOP;
END
$$;
--> statement-breakpoint
-- Forced row-level security. FORCE applies the policy to the owning role too,
-- so the migration job and any repair must scope themselves as well.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'principal_state', 'ledger_events', 'observations', 'proposals',
    'policy_decisions', 'cursors', 'alerts', 'commitments', 'briefs', 'agent_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY principal_isolation ON %I USING (principal_id = app_principal()) WITH CHECK (principal_id = app_principal())',
      target
    );
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE policy_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE policy_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Every principal reads the organisation defaults beside their own rules;
-- only an admin scope writes a row with no principal (ADR 0019).
CREATE POLICY principal_isolation ON policy_rules
  USING (principal_id IS NULL OR principal_id = app_principal())
  WITH CHECK (principal_id = app_principal() OR (principal_id IS NULL AND app_is_admin()));
--> statement-breakpoint
-- The objects above belong to the role running the migration; hand them to
-- lance_migrator like every other relational object (migration 0002), and
-- grant lance_app what it needs, since default privileges follow the owner.
ALTER TABLE principals OWNER TO lance_migrator;
--> statement-breakpoint
ALTER TABLE principal_state OWNER TO lance_migrator;
--> statement-breakpoint
ALTER TYPE principal_status OWNER TO lance_migrator;
--> statement-breakpoint
ALTER FUNCTION app_principal() OWNER TO lance_migrator;
--> statement-breakpoint
ALTER FUNCTION app_is_admin() OWNER TO lance_migrator;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON principals TO lance_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON principal_state TO lance_app;
--> statement-breakpoint
GRANT USAGE ON TYPE principal_status TO lance_app;
--> statement-breakpoint
-- Retention may null payload and nothing else; principal_id joins the
-- columns it must leave alone (ADR 0011, ADR 0015).
CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'ledger_events is append-only: DELETE is rejected (CLAUDE.md non-negotiable 1)'
      USING HINT = 'Ledger rows are never removed. Run the retention job, which nulls payload and keeps payload_hash.';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION
      'ledger_events is append-only: TRUNCATE is rejected (CLAUDE.md non-negotiable 1)'
      USING HINT = 'Recreate the database from scratch if you need an empty ledger in development.';
  END IF;

  IF NOT pg_has_role(current_user, 'lance_retention', 'MEMBER') THEN
    RAISE EXCEPTION
      'ledger_events is append-only: UPDATE is rejected (CLAUDE.md non-negotiable 1)'
      USING HINT = 'Only a member of lance_retention may null payload. See ADR 0011.';
  END IF;

  IF NEW.payload IS NOT NULL THEN
    RAISE EXCEPTION
      'ledger_events retention may only set payload to NULL, not rewrite it (ADR 0011)'
      USING HINT = 'Use UPDATE ledger_events SET payload = NULL WHERE ts < $1.';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.ts IS DISTINCT FROM OLD.ts
     OR NEW.actor IS DISTINCT FROM OLD.actor
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.source_system IS DISTINCT FROM OLD.source_system
     OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id
     OR NEW.source_record_hash IS DISTINCT FROM OLD.source_record_hash
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.parent_event_id IS DISTINCT FROM OLD.parent_event_id
     OR NEW.policy_decision_id IS DISTINCT FROM OLD.policy_decision_id
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'ledger_events retention may change payload only, and this UPDATE changes another column (ADR 0011)'
      USING HINT = 'Set payload alone. payload_hash and every provenance column must survive retention.';
  END IF;

  RETURN NEW;
END;
$$;
