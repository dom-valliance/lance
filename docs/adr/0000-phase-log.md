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
