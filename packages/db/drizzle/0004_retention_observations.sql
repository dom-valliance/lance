-- observations carries the same raw payload as its ledger event, so the
-- retention job must be able to null both (spec 4.4, ADR 0011). Nothing else
-- on observations is writable by lance_retention.

GRANT SELECT ON observations TO lance_retention;
--> statement-breakpoint
GRANT UPDATE (payload) ON observations TO lance_retention;
