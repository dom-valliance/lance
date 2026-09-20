-- Ledger immutability and role grants.
--
-- CLAUDE.md non-negotiable 1: the ledger accepts INSERT and SELECT only.
-- ADR 0011: the nightly retention job is the single exception. A member of
-- lance_retention may set payload to NULL on an existing row and change
-- nothing else, so payload_hash and the provenance links survive.

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

  -- Everything below is the UPDATE path, allowed only for retention.
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
--> statement-breakpoint
CREATE OR REPLACE TRIGGER ledger_events_reject_delete
  BEFORE DELETE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER ledger_events_reject_truncate
  BEFORE TRUNCATE ON ledger_events
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER ledger_events_guard_update
  BEFORE UPDATE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
--> statement-breakpoint
-- The migrator owns every relational object, so ALTER DEFAULT PRIVILEGES
-- below covers whatever later migrations create.
DO $$
DECLARE
  target text;
BEGIN
  EXECUTE 'ALTER FUNCTION ledger_immutable() OWNER TO lance_migrator';

  FOR target IN
    SELECT format('%I.%I', schemaname, tablename)
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO lance_migrator', target);
  END LOOP;

  FOR target IN
    SELECT format('%I.%I', sequence_schema, sequence_name)
    FROM information_schema.sequences
    WHERE sequence_schema = 'public'
  LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO lance_migrator', target);
  END LOOP;

  FOR target IN
    SELECT quote_ident(t.typname)
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
  LOOP
    EXECUTE format('ALTER TYPE public.%s OWNER TO lance_migrator', target);
  END LOOP;
END
$$;
--> statement-breakpoint
-- lance_app: the three Container Apps.
GRANT USAGE ON SCHEMA public TO lance_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lance_app;
--> statement-breakpoint
-- The ledger and its materialised observations are append-only for the
-- application, so take back everything but SELECT and INSERT.
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_events FROM lance_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON observations FROM lance_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lance_app;
--> statement-breakpoint
-- AGE keeps its catalogue in ag_catalog and the graph's labels in a schema
-- named after the graph. Reads only, per spec section 5.2.
GRANT USAGE ON SCHEMA ag_catalog TO lance_app;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA ag_catalog TO lance_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ag_catalog TO lance_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA lance_ontology TO lance_app;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA lance_ontology TO lance_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA lance_ontology TO lance_app;
--> statement-breakpoint
-- lance_retention: the nightly job. USAGE on the schema is the minimum needed
-- to reach the table at all; the only write it holds is payload (ADR 0011).
GRANT USAGE ON SCHEMA public TO lance_retention;
--> statement-breakpoint
GRANT SELECT ON ledger_events TO lance_retention;
--> statement-breakpoint
GRANT UPDATE (payload) ON ledger_events TO lance_retention;
--> statement-breakpoint
-- Future tables created by the migrator follow the same pattern. The ledger
-- and observations are revoked explicitly above, and any later append-only
-- table must be revoked in its own migration.
ALTER DEFAULT PRIVILEGES FOR ROLE lance_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lance_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE lance_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lance_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE lance_migrator IN SCHEMA public
  GRANT USAGE ON TYPES TO lance_app;
