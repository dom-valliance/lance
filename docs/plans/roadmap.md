# Roadmap after Phase 3

Date: 2026-09-23
Replaces: the phase order in spec section 15 from Phase 4 onwards. Phases 0 to 3 stand as built.
Sources: [ontology.md](ontology.md) (the Phase 4 ontology briefing, v3), [multi-user.md](multi-user.md) and [jobs.md](jobs.md), each as Dom wrote it on 23 September.

The briefings keep their scope, design, ADR texts and acceptance criteria. This file changes only when each piece is built and what it waits for. Where a briefing and this file disagree on order or dependency, this file wins.

---

## 1. Decisions

Dom, 23 September:

1. Multi-user and jobs are built before the reference ontology (Foundry, attribution, the Ontology page).
2. Graph scoping (ontology WP4.3) moves into the first phase. Without it, a second principal's graph evidence is visible to every principal, and `ACTIONED_AS` deduplication has no shared Meeting node.
3. Ontology WP4.6 is split. Policy tiers (ADR 0019) and the `promote_to_shared` proposal class come first; the Policies page, shadow mode, the promotion analyser, demotion and undo cards come after the ontology, when counterparty classes have data behind them.
4. The pilot of a second principal (M8) happens before the ontology. It waits for multi-user acceptance and for the framework workshop in the week of 6 October.
5. The whole jobs track (J1 to J8) comes before the ontology, with MCP behind `FF_MCP_CONNECTIONS`. Foundry inputs and filters on organisation type or project arrive with the ontology.

Consequences, recorded in ADR 0031:

6. M5 (fan-out) and J1 (the job registry) are one work package, because both rewrite the scheduler. The registry's reconciler is the thing that produces one schedule per principal.
7. ADR numbers stay as the briefings reserve them (0015 to 0030), so cross-references hold. They are written in build order, not numeric order. ADR 0031 records this roadmap as the deviation from spec section 15.
8. Items the spec left for Phase 5 hardening move into the multi-user phase where a second principal makes them defects: per-secret Key Vault scoping, the Slack nonce store, the refresh-token advisory lock, the data map, the LIA, per-principal retention and the evidence export's principal filter.

---

## 2. Schedule

| Phase | Name | Contents | Starts when | Size (briefing days) |
|---|---|---|---|---|
| 4 | Principal seam | WP4.1; WP4.3 with the reference layer declared but empty; policy tiers and `promote_to_shared` | Now | 6 to 7 |
| 5 | Multi-user | M1, M2, M5 with J1, M4, M3 without the Foundry step, M7, M6, load test | Phase 4 accepted | 15 to 17 |
| Pilot | Second principal | M8: one colleague, two weeks dry run, then live for their own mailbox | Phase 5 accepted, workshop held, LIA merged | 2 weeks elapsed, runs beside Phase 6 |
| 6 | Jobs | J2 to J8 | Phase 5 accepted | 15 to 17 |
| 7 | Ontology and autonomy | WP4.2, WP4.4, WP4.5, the rest of WP4.6, WP4.7, and the carry-ins in section 4 | Phase 6 accepted | 11 to 14 |
| 8 | Hardening | What is left of spec Phase 5 after decision 8 | Phase 7 accepted | to size at Phase 7 close |

Sizes add up the briefings' own estimates. Phases 0 to 3 ran well ahead of estimates like these. The one fixed date is the workshop.

Usage criteria from Phases 1 to 3 (twenty live approvals, retiring the inbox agent, a real debrief with an approved task, five consecutive briefs by 06:35) stay open and block nothing, as before.

---

## 3. Phases in detail

### Phase 4. Principal seam

Branch `feat/phase-4-principal-seam`. ADRs first: 0015 (principals and RLS), 0017 (reference, shared and private layers; `promote_to_shared`), 0019 (policy tiers), 0031 (this roadmap).

| # | Package | Source | Depends on |
|---|---|---|---|
| 4.1 | `principals`, `principal_state`, `principal_id` on every principal-bearing table, forced RLS, `withPrincipal`, propagation through api, worker, agents and ledger, lint rule on the Drizzle client, isolation suite | ontology WP4.1, sections 4.1 to 4.5 | none |
| 4.2 | `layer` and `principal_id` on nodes and edges, repository scoping by `PrincipalScope`, `runCypher` package-internal, `iCalUId` meeting key, `graph_event_id`, `transcript_ref` and `tags` moved to `ATTENDED`, backfills as recorded mutations, readers switched to the edge, isolation harness | ontology WP4.3 | 4.1 |
| 4.3 | Tiered evaluation (floors, personal, organisation, `propose`), seed rules become organisation defaults, `promote_to_shared` action class with its hard floor at never `auto`, property tests, 100% branch coverage kept | ontology WP4.6 (tiers only), section 2.7 | 4.1 |

4.2 and 4.3 run in parallel once 4.1 has merged. `layer: 'reference'` exists as a value with no nodes. Reference nodes arrive in Phase 7.

Acceptance, taken from ontology section 8:

- Every principal-bearing table has a non-null `principal_id` under forced RLS.
- The graph isolates private evidence by principal.
- One meeting is one node.
- Rebuild reproduces the graph, with the same `layer` and `principal_id` values.
- `promote_to_shared` never resolves to `auto`.
- The WP4.1 tests in ontology section 4.5, with every existing suite passing under Dom's scope.
- Migration run as a non-superuser `lance_migrator` member and against dev before merge.

### Phase 5. Multi-user

Branch `feat/phase-5-multi-user`. ADRs first: 0020 to 0024 (multi-user section 3) and 0025 (job registry, jobs section 3).

| # | Package | Source | Depends on |
|---|---|---|---|
| 5.1 | Entra app roles and groups, role-gated sign-in, first sign-in creates an `onboarding` principal, admin procedures, nightly role check | M1 | Phase 4 |
| 5.2 | Per-principal secrets (including the `foundry-refresh-token--<id>` name, unused until Phase 7), Key Vault scoping fixed in the template, advisory lock on refresh-token rotation, Notion integration renamed, `notion_user_id` resolution | M2 | 5.1 |
| 5.3 | Scheduler rewrite: `jobs` registry with system job declarations and bounds, reconciler producing per-principal schedules, fan-out, `principal_state` pause and scoped kill switch, per-principal and organisation budgets, fair-share model rate limiter, run now and pause, Slack `/lance jobs`, `pause <slug>`, `resume <slug>` | M5 and J1 | Phase 4 |
| 5.4 | `slack_links`, `/lance login`, private channel per principal, delivery reads the channel from the principal, foreign-decision refusal and alert, nonce store | M4 | 5.1 |
| 5.5 | Onboarding checklist, steps 1, 2, 3, 5 and 6; Foundry (step 4) is added in Phase 7 | M3 | 5.2, 5.4 |
| 5.6 | Admin page, offboarding runbook exercised on a synthetic principal, data map, LIA, data-processing notice, retention per principal, evidence export principal filter, ISO 27001 access review entry | M7 | 5.1, 5.2 |
| 5.7 | Voice profiles with a Valliance default, per-principal briefs, `ACTIONED_AS` deduplication of meeting tasks | M6 | 5.3 |
| 5.8 | Load test at 30 synthetic principals, phase review across every leak path (SQL, Cypher, Slack, Key Vault, prompts, logs, admin page), deploy to dev | M8 (load test), multi-user section 10 | all |

5.1 and 5.3 start together. 5.7 is last on purpose: the workshop is most likely to change it, so it lands after 6 October if timing allows. `ACTIONED_AS` is written by the executor as part of an approved `create_task`, so it meets the rule that every shared-layer mutation traces to a decided proposal.

Acceptance: multi-user section 8, except the pilot row and the "real two-person meeting" half of the deduplication row, which move to the pilot. Also jobs section 10, rows 1 and 2 (every scheduled job is in the registry; system jobs are manageable within bounds).

### Pilot

Gate: Phase 5 accepted, the workshop held, the LIA merged. If the workshop changes the multiplayer model, amend [multi-user.md](multi-user.md) before onboarding anyone.

Without the reference layer, the colleague's counterparties resolve to `unknown` and every proposal stays at `propose`. That is the safe direction. Client detectors stay silent for them, as they are for Dom today. Say so in the colleague's data-processing notice.

Acceptance: the pilot row of multi-user section 8, and one real two-person meeting producing one Notion task proposal.

### Phase 6. Jobs

Branch `feat/phase-6-jobs`. ADRs first: 0026 to 0030 (jobs section 3).

| # | Package | Depends on |
|---|---|---|
| 6.1 | J2: `JOB.md` schema, versions, references, input gatherers (every source except `foundry.*`), `job-runner`, harness prompt, critic hook, delivery, breaker | Phase 5 |
| 6.2 | J3: Jobs page, job page, `/lance run <slug>` | 6.1 |
| 6.3 | J4: drafting agent, split editor, preview, activation and re-confirmation, cases | 6.1 |
| 6.4 | J5: event catalogue and matcher. Filters on title, attendee count, tag, label, importance, status, alert kind, severity and job slug. Filters on organisation, organisation type and project arrive in Phase 7 | 6.1 |
| 6.5 | J6: MCP client, Connections page, OAuth, classification, hash pinning, `mcp_write`, host allowlist, behind `FF_MCP_CONNECTIONS`, with its own review | 6.1 |
| 6.6 | J7: Cowork import and the organisation library, approved through `promote_to_shared` (Phase 4) by a `Lance.Admin` (Phase 5) | 6.3 |
| 6.7 | J8: three imported jobs live for Dom, load and cost check, phase review, deploy | all |

6.2 to 6.5 run in parallel after 6.1.

Acceptance: jobs section 10 rows 3 to 11, with two adjustments. One-to-one preparation runs without `foundry.employee`, and its role and coach lines arrive in Phase 7. The `transcript.ready` criterion filters on a Jamie tag, which Phase 4 already put on the `ATTENDED` edge, so it stands as written.

### Phase 7. Ontology and autonomy

Branch `feat/phase-7-ontology`. ADRs first: 0016 (reference data through a port) and 0018 (deals are presale projects).

| # | Package | Source |
|---|---|---|
| 7.1 | `ReferenceSource`, Foundry implementation, read-through cache, daily key sync as the one organisation-wide registry job, `foundry` source system, reconciliation of observed employees | ontology WP4.2 |
| 7.2 | `project_locators`, tag and channel suggestions, `ABOUT` edges, domain candidates, organisation types, golden sets | ontology WP4.4 |
| 7.3 | Ontology page and api | ontology WP4.5 |
| 7.4 | Policies page, shadow mode, promotion analyser, demotion, executed cards with undo | ontology WP4.6 (the rest) |
| 7.5 | Carry-ins: Foundry onboarding step (outstanding for existing principals, not a gate on `active`), `foundry.employee` and `foundry.project` job inputs, organisation, organisation type and project filters on job events | multi-user M3, jobs 2.4 and J5 |
| 7.6 | 10k-node performance, rebuild drill, VIP alignment note, phase review, deploy | ontology WP4.7 |

7.4 runs beside 7.1 to 7.3. The promotion analyser counts per principal, and the pilot colleague is its first second principal.

Acceptance: ontology section 8, rows not closed in Phase 4, plus a test that an event filter on organisation type matches a reference client.

### Phase 8. Hardening

Spec Phase 5, minus the items in decision 8: secret rotation runbook and drill, kill switch drill across every queue including `job-run`, accessibility audit, watcher load at 10 times volume, and any retention job the earlier phases did not finish. Sized when Phase 7 closes.

---

## 4. What moved between briefings

| Item | Briefing said | Now |
|---|---|---|
| WP4.3 graph layers | Phase 4, beside Foundry | Phase 4, before multi-user |
| WP4.6 tiers, `promote_to_shared` | Phase 4 | Phase 4 |
| WP4.6 Policies page, shadow, promotion, demotion, undo | Phase 4 | Phase 7 |
| M3 step 4, connect Foundry | Multi-user onboarding | Phase 7 |
| M5 fan-out and J1 registry | Separate packages | One package, 5.3 |
| M8 pilot gate | Phase 4 accepted and workshop | Phase 5 accepted, workshop, LIA |
| Job inputs `foundry.*` | J2 | Phase 7 |
| Event filters on organisation, organisation type, project | J5 | Phase 7 |
| Key Vault scoping, nonce store, refresh lock, data map, LIA | Spec Phase 5 | Phase 5 |
