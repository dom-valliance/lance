# Runbook: restore

## Postgres

Flexible Server keeps automated backups for the configured retention (default 7 days, set to 35 in `infra/`). Point-in-time restore creates a new server.

1. Azure portal, the server, Restore, pick the time, name the new server `lance-pg-restore-<date>`.
2. Enable `age` and `vector` on the new server (`azure.extensions` parameter), then `CREATE EXTENSION` both in the database.
3. Repoint `PG_HOST` in the Container Apps to the new server. Restart.
4. Run `pnpm ontology:rebuild` if the graph is suspect; the ledger is the source of truth and the graph is derived.
5. Record a `state_changed` event with reason `restored_from:<timestamp>`.

## Ledger is never restored partially

If only the graph or the `observations` view is damaged, rebuild them from the ledger. Never restore a subset of ledger rows; a partial ledger is worse than a paused system. Pause first (see `kill-switch.md`), restore whole, resume.

## Major version move

Moving from PostgreSQL 16 to a newer major with AGE enabled is a new server plus `pg_dump` and `pg_restore`, not an in-place upgrade. Plan a pause window.
