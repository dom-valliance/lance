# Phase acceptance log

Evidence for each acceptance criterion in spec section 15. A phase is closed when every row has evidence and a date.

## Phase 0. Foundations

| Criterion | Evidence | Date |
|---|---|---|
| CI green | Workflow in `.github/workflows/ci.yml` validated locally with action-validator; the same commands pass locally: lint, typecheck, format:check, test (15 tasks, 396 tests), build. Not yet run on GitHub because no remote exists (ADR 0007). | 2026-09-20 |
| Ledger UPDATE and DELETE fail in test | `packages/db/src/migrate.test.ts` (grant and trigger matrix, 19 cases) and `packages/ledger/src/ledger.test.ts` (as a lance_app member, SQLSTATE 42501 on UPDATE and DELETE). | 2026-09-20 |
| Policy tests at 100 percent branch coverage | `packages/policy` vitest thresholds at 100 on statements, branches, functions and lines; 73 tests including property-based suites; five engine mutations caught. | 2026-09-20 |
| `/lance status` answers from production | Not yet. Blocked on Dom's prerequisites: Azure deployment (`docs/runbooks/deploy.md`), Entra app (`entra-setup.md`), Slack app (`slack-app-setup.md`). Answers locally in `apps/api/src/main.test.ts` against a real database. | pending |

Kill switch drill (spec 14) already runs in CI: `apps/worker/src/executor/killswitch.test.ts`.

## Independent review, 2026-09-20

An Opus 5 review of the Phase 0 tree found twelve issues. Fixed in the same day: executor compare-and-swap and gate re-check; executor holds recorded so resume releases them; ledger scan pages until a resume; retention grant on observations; Postgres password authentication off by default; `.tsx` and relative write paths covered by the boundary rules; pause, resume and mode changes transactional with their ledger event; forbid rules may tighten the rule_change floor; production connection from `PG_*` with TLS; Entra tokens require `exp`, RS256 and skip the unverified email claim; `/lance status` limited to Dom.

Deferred to Phase 5 hardening, with the reasoning:

- Key Vault role assignments are vault-wide, so the web identity can read worker secrets. Per-secret scoping needs the secrets to exist at deploy time; the fix is a second vault for web-only secrets or placeholder secrets with per-secret role assignments. Must land before `live` mode.
- Slack signature verification has a five minute replay window and no nonce cache. Add a short-lived nonce store keyed on the signature before Phase 1 exposes approve buttons.
