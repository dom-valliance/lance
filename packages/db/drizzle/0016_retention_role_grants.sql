-- The nightly retention job and offboarding (spec 4.4, ADR 0011, package 5.6).
--
-- The worker acts as lance_retention for the length of one transaction per
-- principal (SET LOCAL ROLE), inside that principal's scope, so row-level
-- security holds it to their rows. Migration 0002 gave the role UPDATE on
-- ledger_events.payload and 0004 on observations.payload. Model logs also
-- include the error text an agent run keeps in agent_runs.error, which can
-- quote the model's output, so the role gains that one column there.
--
-- lance_app gains nothing here: it still cannot null a ledger payload, and
-- the ledger trigger still refuses any UPDATE by a role outside
-- lance_retention. The worker identity's membership of lance_retention is
-- granted by the migration job (packages/db/src/grants.ts), not here,
-- because the identity's name differs per environment.

GRANT SELECT ON agent_runs TO lance_retention;
--> statement-breakpoint
GRANT UPDATE (error) ON agent_runs TO lance_retention;
