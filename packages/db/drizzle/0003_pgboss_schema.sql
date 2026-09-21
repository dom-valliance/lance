-- pg-boss keeps its queue and cron tables in its own schema (spec 3.2). The
-- migrator owns the schema; the worker's identity (a lance_app member) creates
-- and alters pg-boss's tables inside it on first start, so it needs USAGE and
-- CREATE there and nothing else.

CREATE SCHEMA IF NOT EXISTS pgboss;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA pgboss TO lance_app;
