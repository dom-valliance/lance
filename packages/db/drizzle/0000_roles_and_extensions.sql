-- Extensions, group roles and the AGE graph (ADR 0004, ADR 0008, ADR 0011).
--
-- Everything here is idempotent, so a partially applied migration history or a
-- database restored from a dump can be brought forward without hand editing.

CREATE EXTENSION IF NOT EXISTS age;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
-- AGE's functions live in a shared library that must be loaded before the
-- graph catalogue is queried or create_graph is called.
LOAD 'age';
--> statement-breakpoint
-- Group roles. NOLOGIN: Container App managed identities and the local
-- development user are granted membership, they never log in as the group.
-- lance_app       the three Container Apps. SELECT and INSERT on the ledger.
-- lance_migrator  the migration job. Owns every relational object.
-- lance_retention the nightly retention job. Nulls ledger payloads only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'lance_app') THEN
    CREATE ROLE lance_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'lance_migrator') THEN
    CREATE ROLE lance_migrator NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'lance_retention') THEN
    CREATE ROLE lance_retention NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- The role running the migrations reassigns ownership to lance_migrator in a
-- later migration, which needs membership of that role. A superuser has it
-- implicitly; on Azure the migrate identity is an Entra admin principal
-- (azure_pg_admin), not a superuser, so grant it here.
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'lance_migrator', 'MEMBER') THEN
    EXECUTE format('GRANT lance_migrator TO %I', current_user);
  END IF;
END
$$;
--> statement-breakpoint
-- create_graph raises if the graph already exists, so guard on the catalogue.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'lance_ontology') THEN
    PERFORM ag_catalog.create_graph('lance_ontology');
  END IF;
END
$$;
