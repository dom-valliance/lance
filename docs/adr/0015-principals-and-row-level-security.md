# 0015. Principals and row-level security

Date: 2026-09-23
Status: Accepted

## Context

Spec section 1.2 scopes v1 to one user. The roadmap (`docs/plans/roadmap.md`, ADR 0031) builds multi-user next, and the Phase 4 briefing (`docs/plans/ontology.md`, section 4) asks for the seam first: a `principals` table, a `principal_id` column on every table that holds a principal's data, and Postgres row-level security so isolation does not depend on application code. At `ea60797` no table carries a principal, the api admits one UPN from config, and `system_state` is one row enforced by a CHECK on `id = 1`.

The briefing proposes `withPrincipal(db, principalId, fn)` opening a transaction and setting `app.principal` locally, and dropping the column default after the backfill so every insert names its principal. Two facts about this codebase bear on that:

- Jobs interleave database work with Graph, Jamie, Notion, Slack and model calls that take seconds to minutes, and each ledger append commits on its own so an external read is recorded even when a later step fails (non-negotiable 1). One transaction around a job would hold a connection and a snapshot for its whole length, and a failure would roll back ledger events for reads that did happen.
- About 150 query call sites across 45 files insert rows. Passing a principal to each is churn with a failure mode (a caller naming the wrong principal) that the database can remove.

## Decision

**Tables.** `principals` (id, `entra_oid`, `upn`, `slack_user_id`, `notion_user_id`, `foundry_employee_id`, `time_zone`, `status`, timestamps) has no RLS; it is the lookup that resolves an identity to a principal. Dom's row is created from `users` and reuses its id. `users` is no longer written. `principal_state` (keyed by `principal_id`, under RLS) holds each principal's pause, mode, quiet hours, push budget and cost ceiling. `system_state` keeps its single row as the global switch: global pause, the mode ceiling and the organisation cost ceiling. A reader applies the stricter of the two. Its `quiet_hours_*` and `push_budget_per_hour` columns stay, because migrations are forward only, and nothing reads them.

**Columns.** `principal_id char(26) NOT NULL REFERENCES principals(id) DEFAULT app_principal()` on `ledger_events`, `observations`, `proposals`, `policy_decisions`, `cursors`, `commitments`, `briefs`, `alerts`, `agent_runs` and `principal_state`. Existing rows are backfilled with Dom's id. `policy_rules.principal_id` is nullable, and null means an organisation default. The default replaces the briefing's `DROP DEFAULT`: a row takes its principal from the session scope, never from a caller argument, and an unscoped insert defaults to null and is refused by the policy's `WITH CHECK`. Uniques that were global become per principal: `ledger_events (principal_id, idempotency_key)`, `observations (principal_id, idempotency_key)`, `cursors (principal_id, watcher, key)`, `alerts (principal_id, dedupe_key)`.

**Policies.** Two SQL functions read the session: `app_principal()` returns `app.principal` as a `char(26)`, or null when it is unset or empty, and `app_is_admin()` is true when `app.role` is `admin`. Every principal-bearing table has `ENABLE` and `FORCE ROW LEVEL SECURITY` and one policy, `USING (principal_id = app_principal()) WITH CHECK (principal_id = app_principal())`. On `policy_rules`, `USING` also admits `principal_id IS NULL`, and `WITH CHECK` admits null only when `app_is_admin()`. `lance_app` has no `BYPASSRLS`. The ledger immutability trigger adds `principal_id` to the columns retention may not change. pg-boss tables are untouched.

**Scope.** `app.principal` and `app.role` are set when a connection is checked out, not per transaction. `createDb` wraps its pool so every checkout sets both settings, to the empty string for an unscoped handle, before the first statement. `scopedDb(db, { principalId, admin? })` returns a Drizzle handle over the same pool whose checkouts set the principal, and `withPrincipal(db, principalId, fn)` calls `fn` with one. Transactions still work as before: Drizzle checks out one connection for a transaction, and the setting is applied on that checkout. A connection can never carry one principal's setting into another's query, because every checkout sets its own. An unscoped handle reads no rows from a principal-bearing table and cannot insert into one.

**Where the scope comes from in Phase 4.** There is one principal. The api and the worker resolve it at start-up from `principals` by the configured UPN and build their dependencies over its scoped handle. The Slack routes resolve the signed user id through `principals.slack_user_id`. The worker seeds organisation rules through an admin-scoped handle. Resolving the principal per request from the Entra `oid`, and a `principalId` on every job payload with one schedule per principal, arrive with Phase 5 (packages 5.1 and 5.3), where there is more than one principal to resolve.

**Enforcement.** ESLint restricts `createDb` to the composition roots (`apps/*/src/main.ts`, `packages/db`, the ontology rebuild script). Tests that prove isolation connect as a member of `lance_app`, because a superuser bypasses RLS even when it is forced.

## Consequences

Isolation holds at the database whatever the application does. A query that forgets its scope returns nothing rather than someone else's rows. Every checkout costs one extra round trip for the `set_config` call, which is small next to the connector calls around it. The migration job and any future data repair must set `app.principal` (or `app.role = 'admin'` for organisation rows) before they touch principal-bearing tables, because the owning role is subject to forced RLS too. The request-scoped and job-scoped resolution deferred to Phase 5 must replace the start-up resolution before a second principal is created. The single-principal boot path refuses to start when it finds more than one active principal.
