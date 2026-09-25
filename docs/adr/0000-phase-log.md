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
| Inbox agent's Slack posting retired in favour of Lance | Dom changed his Cowork inbox task on 2026-09-23 so it keeps tagging mail and no longer posts to `dom-claude-agent`; its last watermark there reads 2026-09-23T14:01:29Z. The stale watermark alert that then fired is off by default from `1f3e2e4` (`INBOX_AGENT_WATERMARK_ALERT`). | 2026-09-23 |

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


### Phase 3 review, 2026-09-22

An Opus 5 review of the phase diff found fifteen issues; all are fixed on the branch.

| Finding | Fix |
|---|---|
| The worker's brief shapes diverged from `MorningBriefContentSchema` and `AfternoonBoardContentSchema` in `@lance/shared`, which the api and the Today page read | The assembly, planner and renderers emit the shared shapes; both briefs are parsed against the shared schemas before insert, with Slack ts and thread ids stored beside the content |
| `raiseAlert` inserted a second row for a resolved or suppressed dedupe key, and the unique key made that a crash | One row per key whatever its status; resolved rows and lapsed mutes reopen with a fresh card, live mutes stay muted |
| `authTest()` at boot was unguarded, so a Slack outage stopped the worker starting | The agent-logs watcher is skipped and a P1 `watcher_failed` is raised when Slack will not identify the bot |
| Batched alerts shared the overflow post's ts in `slack_ts`, so a repeat tried to redraw the batch post as a card | Migration 0007 adds `batch_ts`; batched rows carry it instead and are neither re-posted nor redrawn |
| Proposal cards posted regardless of the push budget | `createProposal` checks the remaining budget first; delivery posts held cards once the hour allows |
| Nothing was delivered while paused | P0 goes out paused or not; P1 and proposal cards wait |
| The planner's `getSourceRecord` returned mail bodies | body, bodyPreview, bodyText and transcript are stripped before the record reaches the model |
| `client_mail_unanswered` treated an unknown domain as a client | Only an Organisation of type `client` counts |
| The calendar window ignored the organiser | The organiser is folded into the attendee list |
| Repeats on acked alerts were not redrawn | Acked cards are redrawn with the new count |
| Detectors formatted times with `toLondon` rather than `config.timeZone` | `localDateTime(iso, zone)` in the detector support module |
| The morning queue had two workers | One, from `registerBriefs` |
| Planner objectives skipped the voice checks | `applyPlan` drops objectives and reasons that fail `checkVoice` |
| Two delivery ticks could post the same alert | Rows are claimed with a token before the post and released if it fails |
| The budget guard's use of `cost_spike` was undocumented | ADR 0013 |

### First day of Phase 3 in dev, 2026-09-22

Dom asked for a brief with `/lance brief`; nothing arrived, and a P0 said the spend ceiling was reached with no way to change it in Settings. Read from `pgboss.job`, `agent_runs` and `alerts` in dev:

| Found | Cause | Fix |
|---|---|---|
| Every Slack post failing since 11:43, breaker open, brief job failed three times after three planner runs | Five alerts raised from the worker's own boot path carry no provenance; the card rendered an empty context block, which Slack rejects as `invalid_blocks` | No provenance block when there is no provenance; the Block Kit limit check now covers context element counts |
| Detector jobs failing after writing their alert, counts rising by three | Ledger actors allow letters and hyphens; detector names carry underscores | `detectorActor` hyphenates; a test parses every detector's actor |
| 15,064 failed `mail-label` runs at zero cost | Haiku 4.5 rejects adaptive thinking and the effort parameter with a 400; every message was retried on every poll | Neither is sent to a model that rejects them |
| Triage USD 40 in 18 hours, 1,748 runs | The first poll over the mailbox triaged every message in the window, then the agent-logs watcher fed every Slack log line to triage | Watchers can opt out of triage; agent-logs does. The backfill cost is one-off and stays |
| Two triage jobs failing on a cypher syntax error | `SET m.end = $end`: `end` is a keyword on the SET path though not in a map literal | Property renamed `end_at` on both paths; a test exercises the update |
| Nothing in the worker console log while all this failed | pg-boss records a failure on the job row and says nothing | Every queue handler goes through `work()`, which logs `job failed` with the queue, job ids and error before rethrowing |
| The ceiling alert says "raise the ceiling in Settings" and Settings had no such control; the quiet hours and push budget Settings saves were never read | Both lived in config only | Migration 0008 adds `system_state.cost_ceiling_gbp`; `SystemControl.setCostCeiling`, the api procedure and a Settings card set it; the agents, the budget guard, delivery and proposal cards read the row on every run |
| The brief ran the planner three times and stored nothing | The brief was stored after the Slack post | Stored first, Slack second, and the planner is skipped with a note when the budget is spent |

Still open from the same look: the Notion connector gets HTTP 404 from `data_sources/20257534-6e48-81fe-b4b5-000b69ecace6/query` (the id is right; the integration must be shared with the All Tasks and Meetings databases), and `watcher_failed` alerts from before consent stay open although the watchers recovered. `docs/runbooks/observing.md` says where to look first.

### Notion scope, 2026-09-22

Dom shared the All Tasks database with the `Dom's Lance` integration and decided not to share the Meetings database, which no longer captures meetings. The default for spec 16 Q7 changes accordingly: the notion watcher reads All Tasks only, and `NOTION_MEETINGS_DATA_SOURCE_ID` is unset unless the Meetings database comes back into use. The Meetings connector code stays for that case. Meeting content continues to arrive from Jamie.

Sharing the database also started a backfill: 3,390 task observations in one poll, each queued for triage at a Sonnet call apiece and nothing to propose. The queued jobs were deleted from `pgboss.job` by hand (3,133 rows, GBP 1 already spent) and the notion watcher now opts out of triage, as the agent-logs watcher does.

## Phases 4 to 8

From Phase 4 onwards the order is set by [docs/plans/roadmap.md](../plans/roadmap.md) (ADR 0031), not spec section 15. Acceptance criteria for each phase are listed there, drawn from the briefings in `docs/plans/`.

## Phase 4. Principal seam

Opened 2026-09-23 on branch `feat/phase-4-principal-seam`. ADRs 0015, 0017 and 0019 written first.

| Criterion | Evidence | Date |
|---|---|---|
| Every principal-bearing table has a non-null `principal_id` under forced RLS | `packages/db/src/isolation.test.ts`, run as a `lance_app` member: every public table but `principals`, `system_state` and `users` has forced RLS and a policy, found from the catalogue so a new table is covered; a second principal's rows are invisible and an insert naming them is refused; an unscoped session reads nothing and cannot insert; `lance_app` has no `BYPASSRLS`. `migrate.backfill.test.ts` migrates a database filled at 0008, as dev is: the users row becomes the principal with its id, every row carries it, run state moves to `principal_state`, and the ledger trigger now guards `principal_id`. `migrate.nonsuperuser.test.ts` applies 0009 as a `lance_migrator` member. | 2026-09-23 |
| The kill switch pauses one principal without pausing another, and the global row pauses both | `packages/ledger/src/control.test.ts`, "the kill switch across principals" | 2026-09-23 |
| The existing suites pass under the principal's scope | `openSeededTestDb` logs in as a `lance_app` member, so the database suites of every app run under the same policies the apps do; fixture work the role is refused (clearing a table, adding a principal) goes through `openFixtureDb`. Root `pnpm test` green, 20 of 20 tasks, uncached. | 2026-09-23 |
| `promote_to_shared` never resolves to `auto` | `packages/policy/src/tiers.test.ts` property suite, with the other two tier properties from ADR 0019; `packages/policy` at 100% on statements, branches, functions and lines | 2026-09-23 |
| The graph isolates private evidence by principal | `packages/ontology/src/repository.isolation.test.ts`: two principals write private evidence for one meeting; every public read method, listed and classified so a new one fails the test until it is, returns none of the other principal's private nodes, edges or edge properties, including through a shared node; unlayered nodes are invisible until the start-up backfill layers them (`repository.backfill.test.ts`). ESLint keeps the raw Cypher runners inside `packages/ontology` and `createDb` to the composition roots, both proven by fixtures in `packages/shared/src/lint/import-boundaries.test.ts`. | 2026-09-23 |
| One meeting is one node | Same suite: two principals' observations of one `iCalUId` give one Meeting node and one `ATTENDED` edge from each principal's own Person, each carrying that principal's Graph event id, transcript and tags | 2026-09-23 |
| Rebuild reproduces the graph, `layer` and `principal_id` included | Same suite and the backfill suite: rebuild merges every principal's recorded mutations by ledger id into an empty graph and yields the same nodes, edges, layers and principals | 2026-09-23 |
| Migration run against dev before merge | Rehearsed by the phase review on a throwaway container loaded with dev-shaped rows, as a NOSUPERUSER `lance_migrator` member, and `migrate.backfill.test.ts` covers a users row whose id is not the seed's. Applied to dev on 2026-09-24 by the deploy of `33654d8` (migration job `caj-lance-migrate-dev-3hyvjf5`, Succeeded 07:05 UTC). | 2026-09-24 |

### Phase 4 review, 2026-09-23

An independent Opus review of `main..HEAD` found no path by which one principal's rows or private graph evidence reach another. Fixed on the branch:

| Finding | Fix |
|---|---|
| High. The deploy moved the apps before running the migration job, so the new apps would start without `principals` and the old image would run against the migrated schema, failing every ledger append | The migration job runs on the new image before the apps move (`scripts/run-migration-job.sh <env> <tag>`, `deploy.yml`, ADR 0032). The apps wait up to `LANCE_STARTUP_WAIT_SECONDS` for their principal. The deploy that carries 0009 needs `/lance pause` before merge and `/lance resume` after verification (`docs/runbooks/deploy.md`, notes) |
| Medium. One `policy_rules` policy let a non-admin scope delete an organisation rule or take it over as its own | One policy per command: every principal reads organisation rows, only an admin scope inserts, updates or deletes them. Isolation suite covers update and delete |
| Low. `lance_app` could insert and update `principals`, including the Slack id the allowlist trusts | `lance_app` reads `principals` only, and holds no write on the dead `users` table. ADR 0015 states what row-level security does and does not protect against |
| Low. A principal's resume during a global pause released proposals the executor then held again | It clears the principal's own pause, releases nothing and records `resume_own`, so the next resume after the global pause lifts still finds the holds |
| Low. App suites ran as the container superuser, which bypasses row-level security | `openSeededTestDb` logs in as a `lance_app` member |
| Low. The seed would fail after the migration if dev's users row carried another id | The seed reuses the principal the migration made for the seed UPN |

Left for Phase 5, before a second principal: a transcript's name-only attendee becomes a shared Person with no exact key, which ADR 0017 does not cover; the backfill keeps a principal's `jamie_id` on a shared Meeting once it has an `iCalUId`; a meeting Jamie saw before the principal's calendar did can leave a Jamie-keyed Meeting beside the `iCalUId` one.

### Phase 4 in dev, 2026-09-24

Dom paused, merged and resumed. The deploy of `33654d8` ran migration job `caj-lance-migrate-dev-3hyvjf5` at 07:05 UTC, then moved all three apps (api and worker revision 28, web 29). Read from dev afterwards:

- One principal, Dom's, reusing the users id `01K5S9V6QW3SWCCPVB0N0E300H`, active, with his pause, dry-run mode, GBP 30.01 ceiling and push budget carried into `principal_state`; the global row open (`live`) and unpaused.
- The worker started at 07:11:50 in dry run and backfilled the graph: 533 nodes, 1,271 edges, context moved to 70 meeting edges, 10 meetings keyed on `iCalUId`, no key conflicts, 88 recorded mutations.
- Dom resumed at 07:14:54; the executor then held three approved proposals, as dry run requires. From 07:11 every watcher completed, cursors advanced, 10 Graph observations were recorded, triage ran, and no job failed.
- api `/health/ready` 200 with `paused: false, mode: dry_run`; web redirects to sign-in; an unauthenticated api route answers 401.

One gap, against non-negotiable 1. The migration moved the pause into `principal_state` and cleared `system_state`, which is all the old image reads, so between 07:05 and 07:11 the old worker ran unpaused. `watcher-graph-mail` and `watcher-agent-logs` each polled once at 07:10 and failed on the old writer's `ON CONFLICT (idempotency_key)`, so those two reads left no ledger event. Neither advanced its cursor, and the new worker re-read the same window from 07:15, so no observation was lost. The runbook's deploy notes now say how to handle a migration that moves state the running image reads.

Decisions taken while building, recorded in ADR 0015: the scope is set on each connection checkout rather than per transaction, because jobs interleave database work with slow connector and model calls; `principal_id` defaults from the scope rather than losing its default, so no caller names a principal; the global mode is a ceiling that starts open, so each principal's own mode, which starts in dry run, decides. Open before a second principal exists, for Phase 5: shared Person and Organisation nodes keep `source_refs` naming the mailbox record that first showed them, which tells another principal where the name was seen; decide whether shared nodes keep refs at all or keep only the system and time. The principal's own `ATTENDED` edge is written for every Jamie meeting in their account, including one Jamie marks as not attended; nothing reads the edge as attendance yet. Carried to Phase 5 (package 5.3): a `principalId` on every job payload, one schedule per principal, the organisation cost ceiling across principals (the global `cost_ceiling_gbp` has no reader until then), and releasing other principals' held proposals after a global resume.

## Phase 5. Multi-user

Opened 2026-09-24 on branch `feat/phase-5-multi-user`. ADRs 0020 to 0025 and 0033 written first. Packages built by Opus agents in worktrees under `../lance-worktrees/`, each rebased onto the phase branch and verified again there.

| Package | Commits | Migration |
|---|---|---|
| 5.0 Shared layer carries no private provenance (ADR 0033) | `bf3d61c`, `396d440` | 0011 |
| 5.1 Identity and roles (ADR 0020, 0024) | `b2163db` to `2a0d2e7` | 0012 |
| 5.3 Scheduler, job registry, fan-out, budgets, fair share (ADR 0025) | to `a38a79e` | 0013 |
| 5.4 Slack linking, private channels, nonce store (ADR 0021, 0023) | to `cf200c0` | 0014 |
| 5.2 Credentials per principal, second vault, rotation lock (ADR 0022) | to `106b2ae` | 0015 |

Decided by Dom on 2026-09-24 and 25, after the thirty-principal load test (`docs/runbooks/load-test.md`): fix the Monday mail backlog at its cause rather than loosen the 60 second queue target, so mail and triage run concurrently, one job per principal at a time, and bulk mail skips model triage (ADR 0034); raise model concurrency from 4 to 16, which the account's limits of 10,000 requests and 10 million input tokens a minute allow for the same spend; default the organisation ceiling to GBP 30 with an admin control. Found while building ADR 0034: policy was never given a move's destination when a proposal was created, so seed rule 4 (move newsletters and notifications into `AI-Filed` automatically) never fired and every such move became a card. Fixed; Dom keeps the rule as the spec has it, so once live those moves run without a card.

Found while merging: the executor set a proposal to held and recorded the hold as two statements, so a resume between them left the proposal held while running (the kill switch drill had flaked on it). The hold and its event now commit together under a per-principal lock that pause and resume take (`14dd959`); a race test in the ledger suite fails on every run with the lock removed. The readiness probe now names what it reports, `pausedGlobally` and `modeCeiling`. Test budgets were raised for full local runs, where fast suites timed out waiting their turn; three uncached root runs then passed in a row.

| Criterion | Evidence | Date |
|---|---|---|

### Phase 5 review, 2026-09-25

Three independent Opus reviews of `790af1a..2eb1079` (the first, and two that covered what it had delegated and not received) found no critical issue and no path by which one principal's rows reached another's session through SQL. They found, and the branch fixes:

| Finding | Fix |
|---|---|
| High. Policy read a move's folder name and the executor moved to its folder id, so a triage proposal naming AI-Filed with the id `deleteditems` could be auto-approved and soft-delete a message | A move names its destination one way, at proposal and execution; a move into Deleted Items or the recoverable-items folders is refused whatever the rules say (`5f67569`) |
| High. Graph consent was tied only to its state, so a forwarded consent link stored another person's token under the sender's principal | The state is bound to an HttpOnly cookie on the api's hostname and kept in Postgres; the callback verifies the id token's `oid` and `tid` against the principal; ledger events precede the secret write (`0b90a71` to `36b00e0`) |
| High. Every principal's triage, commitments, debrief, detectors and briefs acted as Dom, rewriting Dom's shared Person with another principal's Notion id | Each context builds its own principal's identity and passes it everywhere `config.dom` stood for the principal; the prompts name the principal (`b0d8268`, `60a546e`, ADR 0035) |
| High. Retention could not act after the first deploy, because the migration job ran its new command only on the next deploy | The Deploy workflow runs the job again after the apps move (`6c35c82`) |
| Found by the lead: the tenant has no Entra ID P1, so the setup script's group assignment would fail | Roles are assigned to people directly; `grant-access.sh`; ADR 0020 amendment (`a684ce9`) |
| Medium. A `/lance login` link bound whoever opened it | A link binds only when the Slack profile email equals the signing-in UPN, never replaces an existing link silently, and `/lance unlink` exists (`231bca4`) |
| Medium. The legacy backfill ran in every principal's context; single-principal Jamie meetings were shared; a Jamie observation could rename a shared meeting; meeting merges were not atomic | Backfill once, for the legacy owner, before any context; single-principal meetings private; the calendar wins; merges in one locked transaction (`c338c07`, `32a80a5`) |
| Medium. Organisation-wide telemetry and the whole shared Notion database were recorded in every principal's ledger | Spans carry `lance.principal` and the query filters on it; Notion reads filter on the principal as assignee (`2fdf999`, `f3d78df`) |
| Medium. Jobs the Phase 4 image queued without a principal would fail on deploy; upgrade steps were spread over three runbooks; consent state was in memory under two api replicas; retention after offboarding kept late rows | Adoption at boot; one ordered checklist in `deploy.md`; consent state in Postgres; offboarded principals retained at zero days (`b36b96f`, `a9b4b93`, `3f1cab8`) |
| Low. The raw id token reached browser JavaScript; the api trusted the client's notice hash; the last admin or Dom could be offboarded without confirmation; organisation rule changes had no ledger writer; the evidence export carried source record hashes; job groups and budget alert recipients | Each fixed (`f3cc484`, `c671957`, `3f1cab8`, `9dfe28e`, `9d85ed2`, `d357ece`), with the Slack re-link, role-check grace and onboarding-principal fixes (`d607701` to `c62d4f3`) |

Every check at `32cffac`: lint, typecheck, format, the full suite uncached, build, the migration guard, the deployer-role check, the Bicep build, and the three images with their smoke tests.

## Pilot

| Criterion | Evidence | Date |
|---|---|---|

## Phase 6. Jobs

| Criterion | Evidence | Date |
|---|---|---|

## Phase 7. Ontology and autonomy

| Criterion | Evidence | Date |
|---|---|---|

## Phase 8. Hardening

| Criterion | Evidence | Date |
|---|---|---|
