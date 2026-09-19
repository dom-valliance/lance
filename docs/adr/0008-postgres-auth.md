# 0008. Postgres authentication from Container Apps

Date: 2026-09-19
Status: Accepted

## Context

Spec section 3.3: Postgres auth via Entra managed identity where the driver supports it, password from Key Vault as fallback. Azure Database for PostgreSQL Flexible Server accepts an Entra access token as the password. `@azure/identity`'s `DefaultAzureCredential` returns a managed identity token in Container Apps and a developer credential locally.

## Decision

`packages/shared/db` builds the `pg` pool with a password callback. In Azure the callback requests a token for scope `https://ossrdbms-aad.database.windows.net/.default` and caches it until five minutes before expiry. When `PG_PASSWORD` is set (local development, or the Key Vault fallback), it is used instead. Each Container App's managed identity is created as an Entra principal in Postgres and granted `lance_app`; the migration job's identity is granted `lance_migrator`.

## Consequences

No database password in production. Token refresh failures surface as connection errors and raise `token_refresh_failed` for the `postgres` connector. Local development still uses a password against the compose container.
