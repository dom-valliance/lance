-- pg-boss keeps its queue and cron tables in its own schema (spec 3.2).
-- The worker connects as a member of lance_app and pg-boss creates its
-- tables on first start, so lance_app owns the schema. Nothing else lives here.

CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION lance_app;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA pgboss TO lance_app;
