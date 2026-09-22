# Phase acceptance log

Evidence for each acceptance criterion in spec section 15. A phase is closed when every row has evidence and a date.

## Phase 0. Foundations

| Criterion | Evidence | Date |
|---|---|---|
| CI green | First GitHub Actions run on `main` passed all three jobs on 2026-09-21: lint, typecheck, format, test (15 tasks against the Postgres image built in the runner) and build; migration guard; Bicep build and lint with what-if skipped for lack of credentials. | 2026-09-21 |
| Ledger UPDATE and DELETE fail in test | `packages/db/src/migrate.test.ts` (grant and trigger matrix, 19 cases) and `packages/ledger/src/ledger.test.ts` (as a lance_app member, SQLSTATE 42501 on UPDATE and DELETE). | 2026-09-20 |
| Policy tests at 100 percent branch coverage | `packages/policy` vitest thresholds at 100 on statements, branches, functions and lines; 73 tests including property-based suites; five engine mutations caught. | 2026-09-20 |
| `/lance status` answers from production | Dev environment deployed 2026-09-21 (rg-lance-dev, images 9137265): six migrations and the seed applied by the migrate identity, api `/health/ready` 200 as its managed identity, web sign-in redirect correct, worker started in dry_run with pg-boss's tables created under its own identity. Dom ran `/lance status`, `/lance pause drill` and `/lance resume` from Slack at 12:19 on 2026-09-21; the production ledger holds the two `state_changed` events (actor `user:dom`, one correlation id, resume pointing at the pause). Phase 0 closed. | 2026-09-21 |

Phase 0 closed on 2026-09-21. Kill switch drill (spec 14) already runs in CI: `apps/worker/src/executor/killswitch.test.ts`.

## Independent review, 2026-09-20

An Opus 5 review of the Phase 0 tree found twelve issues. Fixed in the same day: executor compare-and-swap and gate re-check; executor holds recorded so resume releases them; ledger scan pages until a resume; retention grant on observations; Postgres password authentication off by default; `.tsx` and relative write paths covered by the boundary rules; pause, resume and mode changes transactional with their ledger event; forbid rules may tighten the rule_change floor; production connection from `PG_*` with TLS; Entra tokens require `exp`, RS256 and skip the unverified email claim; `/lance status` limited to Dom.

Deferred to Phase 5 hardening, with the reasoning:

- Key Vault role assignments are vault-wide, so the web identity can read worker secrets. Per-secret scoping needs the secrets to exist at deploy time; the fix is a second vault for web-only secrets or placeholder secrets with per-secret role assignments. Must land before `live` mode.
- Slack signature verification has a five minute replay window and no nonce cache. Add a short-lived nonce store keyed on the signature before Phase 1 exposes approve buttons.

## Phase 1. Mail and calendar, dry run then live

Branch `feat/phase-1-connectors`. Built 2026-09-21: connector framework, Graph and Notion and Slack connectors, watcher runner, triage agent, proposal router and decision service, executor dispatch, Slack cards and interactions, Proposals and Ledger pages.

| Criterion | Evidence | Date |
|---|---|---|
| Zero duplicate observations across a full re-poll | `apps/worker/src/watchers/runner.test.ts`: a second poll over the same records inserts nothing; the Graph watcher integration test repeats it with delta fixtures. Production re-poll evidence pending the first live week. | 2026-09-21 (test), live pending |
| Every proposal in Slack resolves to a ledger trail in the UI Ledger page | The Ledger page follows a correlation id end to end; pending a live proposal. | pending |
| Dom has approved at least 20 proposals live | Pending five dry-run working days then live use. | pending |
| Inbox agent's Slack posting retired in favour of Lance | Pending, end of Phase 1 (`docs/runbooks/slack-app-setup.md` section 7). | pending |

### Phase 1 review, 2026-09-21

An independent Opus 5 review of the branch against the non-negotiables returned eleven findings. All confirmed findings were fixed on the branch before hand-over:

| Finding | Fix |
|---|---|
| Dry run did not stop the executor: an approval in `dry_run` mode wrote to the mailbox (non-negotiable 7) | `PauseGate.checkWrite` refuses while paused or in any mode other than live; the executor uses it before and after the claim. Kill switch test covers dry run. |
| An edit replaced the payload instead of merging, dropping recipients and task input | The executor merges the edit over the proposed payload and re-evaluates policy with the edited destination and the recorded labels. |
| The target check compared a Graph folder id with a well-known name, so it never ran | The re-fetched message is normalised under the folder kind the observation recorded; any fetch or parse failure holds the proposal. |
| The critic ran only on `auto` decisions, so no `draft_email` was ever checked; the model review was unwired; two spec 7.4 checks were missing | The critic runs on every proposal policy does not forbid. It now checks the authorising rule covers the action and that no email address in the payload is absent from the source records. The Opus draft review is wired through `critic/review.ts`. |
| A retried write could duplicate a committed one | Non-idempotent connector writes retry only on 429; PATCH writes keep the full policy (`packages/connectors`). |
| The package root exported general-purpose write methods, bypassing the `writes` boundary | Write capability is package-internal; the public connector objects expose reads only. |
| The Entra id token was passed to the browser in the SSE URL | The web app's `/api/events` route handler subscribes on the browser's behalf with the token in a header; the api accepts the header alone. |
| Triage jobs were completed and discarded while paused | The job is re-sent with a delay instead. |
| A record that failed to normalise lost triage for the records before it | Per-record failures are isolated; good records are triaged, the cursor stays put, the failure counts towards the breaker. |
| Notion paging had no cap | `MAX_QUERY_PAGES`. |
| `/lance resume` released held proposals without re-queuing them | Both resume entry points re-queue every released proposal. |
| A retried triage job re-proposed the same tasks; an alert could be raised with no provenance | Task candidates are matched to existing proposals on the correlation id; an alert with empty provenance is not raised. |

Accepted as is, with the reason:

- Refresh token rotation has no cross-process lock. The worker runs one replica (`maxReplicas: 1` in `infra/modules/containerapps.bicep`) and the api never refreshes, so no second rotation can race it. A Postgres advisory lock is the Phase 5 item if the worker ever scales.
- The mail backfill cannot be narrowed to 14 days: the Graph message delta endpoint takes no filter. The first poll is bounded by `MAX_DELTA_PAGES` and idempotent.

## Phase 2. Jamie and Notion, commitments, debrief

Opened 2026-09-21 on branch `feat/phase-2-meetings`, with Dom's go-ahead, while Phase 1 runs its dry-run week in dev. Two Phase 1 criteria stay open until that week delivers them: twenty live approvals and retiring the inbox agent's posting. Phase 2 does not wait on them because both are usage evidence, not code.

| Criterion | Evidence | Date |
|---|---|---|
| Eval F1 for commitment extraction above 0.8 on the golden set | `pnpm --filter @lance/agents eval:commitments:live` over the 50 synthetic records in `fixtures/evals/commitments` with `claude-sonnet-5`: F1 0.857, precision 85.7%, recall 85.7%, due date accuracy 87.5% over 48 matched pairs (56 expected, 56 extracted, 48 true positives). First run scored 0.533 before the scorer stopped counting people's names in descriptions and the prompt refused group counterparties and third-party promises. | 2026-09-21 |
| A real meeting produces a debrief card with at least one approved Notion task within one hour of transcript arrival | pending | |

### Phase 2 review, 2026-09-21

An independent Opus 5 review of the branch returned ten findings. Fixed before hand-over:

| Finding | Fix |
|---|---|
| A same-name sighting with no identifier created a new Person node and a SAME_AS candidate on every meeting | A candidate-grade match with no email or system id reuses the known node unless rule 3 bars it |
| Commitments from one correlation id were stamped with the first candidate's provenance | Candidates are grouped by source record and recorded with that record's provenance |
| Rebuild skipped a mutation whose payload was missing and reported success | Rebuild throws naming the event; the graph cannot be rebuilt from a ledger that retention has trimmed |
| A graph mutation and its ledger event were not atomic | Both run in one transaction, as do a chase's row update and its event |
| A meeting with a future start dragged the Jamie poll window forward | The cursor is clamped to now before the overlap is applied |
| A chase was marked chased even when policy forbade the draft | A forbidden draft leaves the commitment untouched and records the refusal |
| Commitment resolutions were attributed to a constant actor | The router passes the actor derived from the verified UPN |
| A chase request left no ledger trace until the worker ran | The api appends a `commitment_chase_requested` event at enqueue |
| `LIMIT $limit` in the ontology search | The bound is checked and inlined |

Accepted with a decision to make in Phase 5: evidence quotes copied into the triage `resolved` event outlive the transcript they came from (ledger two years, transcripts 180 days). Retention will either null the quote fields in ledger payloads at the transcript window or the window will be set on purpose; recorded here so the retention job (WP5.1) carries it.

Also settled in Phase 2: the mail-derived commitment path and the transcript path share one extractor and one golden set; Jamie exposes `tasks.update` and Lance does not use it (ADR 0005 addendum).


### Web UI design pass, 2026-09-22

The web app was rebuilt from the Claude Design package described in `docs/design/README.md`, on branch `feat/web-design-system`. Seven pages (Today, Proposals, Proposal detail, Tasks, Commitments, Ledger with its trail and CSV export, Settings) plus sign-in follow the package; Alerts, Ontology, Policies and Agents wait for the next design pass. Two contracts were fixed on the way and belong to later phases:

- `MorningBriefContentSchema` and `AfternoonBoardContentSchema` in `@lance/shared` are the shape the Phase 3 planner must write into `briefs.content`; `briefs.latest` validates against them and the Today page renders them.
- Regenerate on Today, Mark done and Create task on Tasks are wired as server actions that answer with a plain-words sentence until the Phase 3 planner and the create-task and complete-task proposals exist; each is one call away from the real mutation.

The api gained `systemState.status`, `pause`, `resume`, `setMode` and `setInterruptionBudget`, `settings.retention` and `briefs.latest`; `SystemControl.setInterruptionBudget` records quiet hours and the push budget as a `state_changed` event (spec 9.4, "Configurable in Settings"). Sign-in moved to `/sign-in` inside the app; Auth.js's `error=AccessDenied` code is the one query parameter read, and the copy shown is the app's own.

## Phase 3. Briefs and alerts

Opened 2026-09-22 on branch `feat/phase-3-briefs-alerts` after Phase 2 was deployed to dev at d95cff8. Phase 2's remaining criterion (a real meeting producing a debrief with an approved Notion task within an hour) waits on use.

| Criterion | Evidence | Date |
|---|---|---|
| Five consecutive weekday briefs delivered by 06:35 with no missing meeting | pending | |
| Stale watermark in the inbox agent's channel raises an alert in test | `apps/worker/src/watchers/agent-logs/detect.test.ts`: a watermark older than the threshold raises one P1 `stale_watermark` alert, a fresh one none; the watcher's Slack partition parses watermark lines from the channel history. | 2026-09-22 |
| Push budget test passes | `apps/worker/src/alerts/engine/deliver.test.ts`: a P0 posts in quiet hours while a P1 waits for working hours, a P2 is never pushed, pushes beyond the hourly budget fold into one batch post with a link, repeats redraw the card, a muted alert is not delivered; proposal cards record a push too. | 2026-09-22 |

