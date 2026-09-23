# Phase 4 plan: principal seam, reference ontology and earned autonomy

Date: 2026-09-23 (v3: v2 plus two corrections found while writing the companion multi-user plan)
For: Claude Code in the `lance` repository, branch to open `feat/phase-4-ontology`
Replaces: the Phase 4 line in spec section 15. Everything else in the spec stands.
Suggested home in the repo: `docs/plans/phase-4.md`, linked from `docs/adr/0000-phase-log.md` when Phase 4 opens.

### Changes in v3

- `system_state` stays the single global row; its CHECK constraint forbids a second row. Per-principal pause, mode, quiet hours, push budget and cost ceiling move to a new `principal_state` table (4.1).
- Task nodes for the Notion All Tasks database are `shared`, because that database is visible to the whole team. Jamie tasks stay `private` (2.1, 2.2).
- The companion plan `docs/plans/multi-user.md` builds on WP4.1 and takes everything in 4.6.

### Changes from v1

- The reference layer reads Foundry at the point of use. Lance keeps Foundry keys and its own edges; Foundry keeps the facts (2.1, 2.6, WP4.2). Dom, in the session: "if I can leverage the Palantir one, then why replicate?"
- The reference source sits behind a port so a VIP core can replace Foundry later (ADR 0016). James's outside-in point: build the consumers against the Palantir ontology, swap the core afterwards.
- Meetings key on the calendar `iCalUId`, which every attendee's mailbox shares, so one meeting is one node however many principals see it (2.2, WP4.3). This is the dedupe point Tarek raised for transcripts and meeting actions.
- Projects gain context locators: where the plan, the channel, the files and the tag for a project live (2.5, WP4.4). Tarek's anti-drift point.
- Every write to the shared layer that starts from one principal's evidence goes through an approved proposal (2.7). This is the Ian-to-Val handoff in miniature.
- Attribution and resolution get golden sets, in answer to the session's point about eval discipline (WP4.4, section 8).
- Foundry token lifetime is a named risk: Tarek re-authenticates the Foundry MCP weekly (section 10 Q1, section 11).

---

## 0. How to use this plan

Read `CLAUDE.md`, the spec, `docs/adr/0000-phase-log.md` and this file before writing code. Then:

1. Write ADRs 0015 to 0019 (section 3) and add them to `docs/adr/README.md` before the first migration.
2. Build the work packages in section 7 in order. WP4.1 lands first because every later migration adds columns to tables it changes.
3. Record evidence against section 8 in the phase log as each criterion passes.
4. Section 10 lists open questions with defaults. Build the default and do not block.
5. Run the phase review (an independent Opus review against the non-negotiables) before hand-over, as in Phases 1 to 3.

Phases 1 to 3 have open usage criteria (twenty live approvals, retiring the inbox agent, a real debrief, five consecutive briefs). They do not block Phase 4, for the same reason Phase 2 did not wait on Phase 1: they are usage evidence, not code.

---

## 1. What changed since the spec was written

### 1.1 The 22 September planning session

Source: the VIP and AI Native Planning Session (Jamie, 22 Sep 2026; Tarek, Dom, Volha, James, Ronan, Chris, Sergii). Summary and full transcript are in Dom's Cowork folder under `outputs/ian-assistant/`.

On the ontology:

- Tarek asked whether the Valliance ontology in Foundry could be the source of truth for client, deal, project, task and resource. Volha and Chris: not tasks; yes for the rest, including what flows in from HubSpot. Tasks stay in Notion, which ADR 0009 already says.
- Chris's Foundry pipeline already links meeting attendees to employees in the ontology and meetings to projects, and deliberately leaves full transcripts out to limit PII and bloat.
- Dom: the AGE graph was meant to hold the domain model and the world state (the T-box and the A-box), but "if I can leverage the Palantir one, then why replicate?" The rest of the graph is not built yet, and that is why Lance runs in dry run: "it doesn't know enough about Valliance and about me to be dangerous."
- Tarek: to stop context drift, an ontology should say for each project where the files, the plan and the Slack channel are.
- James: build the consumers (Lance, Val) outside in, against the Palantir ontology; the core can be swapped for VIP later and the consumers still stand.

On personal and shared work:

- Ian is personal and acts for one person; Val is the team system. Val receives a lot of Ian's work, so the handoff between them is the hard part.
- Transcript filing is the worked example. Every personal agent pulling the same meeting produces duplicate transcripts and duplicate actions. Jamie has personal and workspace views; one proposal was that Ian moves a transcript from personal to shared.
- Multi-user means "another column on everything, which is a principal, religiously adhered to" (Dom). Approval rights will vary by role. Tarek: "how do you take a personal job and make it personal but still allow sharing it between teams?"
- Slack posts stay short and specific. Tasks, proposals, commitments, agent status and approvals belong in consolidated pages.
- Evaluation discipline is weak across the team's builds. Lance has around 40 evals; the shared framework needs a reviewed practice.

Dom took an action to add a view to the Lance design that links its architecture to VIP. WP4.7 delivers it.

### 1.2 The multi-user design agreed in Cowork

Frame 8 of the architecture board (Miro, "Multi-user modification") fixed the target shape:

- `principal_id` on every table, enforced by Postgres row-level security rather than application code.
- Entra is the source of identity. Slack binds to it once per user through account linking.
- The ontology splits into a shared organisational layer and a per-principal evidence layer.
- Policy evaluates in tiers: hard floors, personal rules, organisation defaults, then the `propose` fallback.

The promise was to build the seam now, with Dom as the only principal, so multi-user later is additive. That has not happened: no table carries a principal column, and 18 source files use `dom*` identifiers. WP4.1 closes the gap.

### 1.3 What the code does today

Read from the tree at `ea60797`:

- No code path creates an Organisation node, a Project node, a `WORKS_AT` edge or an `ABOUT` edge. `upsertOrganisation` and `upsertProject` have no callers outside tests.
- So `findOrganisationByDomain` always returns null in dev. The `client_mail_unanswered` detector can never fire, `external_meeting_unknown_attendee` treats every domain as unknown, and the brief's organisation lines are empty.
- Persons are created from mail, calendar and Jamie sightings. Only Dom's node has `is_internal: true`.
- Meetings key on `graph_event_id`, and Jamie supplies the same value from `event.externalId`. A Graph event id is specific to one mailbox. The calendar watcher already captures `iCalUId` (`apps/worker/src/watchers/graph/calendar.ts`) but nothing keys on it.
- Jamie meeting tags reach the watcher and are stored on the Meeting node. Nothing maps them to projects or clients.
- `SOURCE_SYSTEMS` in `packages/shared/src/enums.ts` has no `foundry`.

### 1.4 What Foundry holds

Read from the Valliance ontology (`ri.ontology.main.ontology.3b447b8a-abd9-4ce5-a5a8-ff001b919710`) on 23 Sep:

| Object type | apiName | Primary key | What Lance needs from it |
|---|---|---|---|
| Employee | `TomPersonPalantir` | `employeeId` | `userPrincipalName`, `email1`, `slackUserId`, `displayName1`, `jobTitle`, `discipline`, `active`, `startDate1`, `endDate1`; links `directCoaches`, `directCoachees` |
| Valliance Project | `TomClientProjectHubspot` | `projectId` | `projectName`, `type`, `clientId`, `clientName`, `stageDisplayName`, `deliveryStatus`, `ownerName`, `hubspotProjectId`, `hubspotPresaleId`, `notionProjectId`, `notionParentProjectId`, `notionUrl`, `startDate`, `endDate`, `probabilityPercentage` |
| Position | `TomPositionPalantir` | `positionId` | `personId`, `projectId`, `positionTitle`, `allocationPrcentage`, `startDate`, `endDate`, `status`, `billable` |

Counts: 30 employees, 28 active, all 30 with a UPN, 24 with a Slack id. 443 projects: 14 `Project` (11 distinct clients), 94 `Presale` (58 distinct clients), 37 `Internal`, 290 `Notion`, 8 `General`. `General` is not in the type's own description; treat it as internal until someone says otherwise.

Two gaps shape the design. There is no Client object type: a client is a `clientId` and `clientName` carried on projects. And nothing in Foundry holds a client's email domains, so Foundry alone cannot tell Lance that mail from `chambers.com` is a client.

The Employee type also carries salary, date of birth, gender, age, mobile phone, contracted hours and production tag. Lance never requests them.

---

## 2. The refined ontology model

### 2.1 Three layers

Every node and every edge belongs to one layer, recorded as a `layer` property.

| Layer | What it holds | Where the facts live | `principal_id` | Visible to |
|---|---|---|---|---|
| `reference` | Employees, client organisations, Valliance projects, staffing, coaching lines | Foundry. Lance holds a key node per entity and the Foundry-sourced edges between them | null | Every principal |
| `shared` | External people and organisations Lance has observed, confirmed domains, meetings as facts (title, start, end, organiser), Notion All Tasks task nodes, project context locators | Lance's graph | null | Every principal |
| `private` | Threads, commitments, Jamie task nodes, documents, transcript references, tags, and every edge that records an observation: `ATTENDED`, `MENTIONS`, `PARTICIPATED_IN`, `DERIVED_FROM`, `ABOUT`, `OWES`, `OWED_TO`, `ASSIGNED_TO` | Lance's graph | the observing principal | That principal only |

In plain terms: reference is what Foundry says, shared is what the organisation has learned, and private is what one person's mailbox and meetings showed.

A reference key node carries only what Lance needs to join and resolve: the Foundry primary key, the match keys (UPN, email, Slack id for employees; client id and normalised client name for organisations; project id, normalised name and aliases for projects) and `active`. Everything else (job title, stage, delivery status, owner, dates) is read from Foundry when a brief, a detector or a page needs it. Section 2.6 says how.

A Meeting two principals attended is one shared node with two private `ATTENDED` edges. Its transcript reference and tags live on the attending principal's edge, not on the node, because Jamie transcripts sit in personal accounts.

### 2.2 Labels and properties

No new node labels. Deals are Projects of kind `presale`; Valliance calls some projects missions, and those stay Projects with the name in `aliases`. ADR 0018 records why a `Deal` label is not worth the join.

| Label | New or changed properties |
|---|---|
| Person | `layer`, `authority` (`foundry` or `observed`), `foundry_employee_id`, `upn`, `active` |
| Organisation | `layer`, `authority`, `foundry_client_id`, `domains_confirmed` (array), `type` (derived, 2.4) |
| Project | `layer`, `authority`, `kind` (`delivery`, `presale`, `internal`, `planning`), `foundry_project_id`, `notion_project_id`, `active` |
| Meeting | `layer: 'shared'`, `ical_uid` as the primary match key; `graph_event_id` becomes a per-principal property on `ATTENDED`; `transcript_ref` and `tags` move to `ATTENDED` |
| Task | `layer: 'shared'` when `source` is `notion` (the All Tasks database is team-visible); `layer: 'private'` with `principal_id` when `source` is `jamie` |
| Thread, Commitment, Document | `layer: 'private'`, `principal_id` |

`kind` and `notion_project_id` are stored on the key node because resolution and attribution filter on them. They are refreshed from Foundry on every sync.

New edges:

| Edge | From, to | Layer | Properties |
|---|---|---|---|
| `STAFFED_ON` | Person to Project | reference | `foundry_position_id`, `active` |
| `COACHES` | Person to Person | reference | none |
| `OWNS` | Person to Project | reference | none |
| `CLIENT_OF` | Organisation to Project | reference | none |

Position details (role, allocation, dates, billable) are read through, like other reference facts.

`WORKS_AT` gains a `layer`: reference for employees (to the Valliance organisation), shared for observed external people.

Foundry `type` maps to `kind`: `Project` to `delivery`, `Presale` to `presale`, `Internal` and `General` to `internal`, `Notion` to `planning`.

### 2.3 Resolution precedence

`resolvePerson` gains a first step and one rule. The rest of spec 5.3 stands.

1. Reference keys first: UPN, then email, then Slack id, matched exactly against reference Persons. A match returns the reference node. Lance never creates a second node for an employee.
2. Existing exact keys: email, Notion user id, Jamie participant id, Slack id.
3. Name plus organisation scoring, as today.
4. Human review of `SAME_AS` candidates.

The rule: when an observed node and a reference node are the same person, the reference node survives and the observed node folds into it. Lance never merges two reference nodes. A suspected duplicate inside Foundry raises a P2 alert `reference_data_conflict` naming both Foundry ids, so the fix happens at the source.

WP4.2 runs a one-off reconciliation: every existing observed Person whose email matches an employee folds into the reference node, as a recorded mutation.

### 2.4 Organisation type and domains

Type comes from Foundry when the organisation is a Foundry client:

- `client` when it owns at least one `delivery` project that is not closed.
- `prospect` when it owns only `presale` projects.
- `internal` for Valliance, seeded from config with domain `valliance.ai`.
- Observed organisations stay `unknown` unless Dom sets a type.

Type is derived at sync time and stored on the key node, because the policy engine's counterparty class and the detectors need it without a network call.

Domains need a second source, because Foundry has none. WP4.4 proposes domain candidates from evidence and Dom confirms them:

- A mail sender's domain co-occurs with a meeting tagged for that client (2.5), or
- The domain's second-level label scores above 0.85 Jaro-Winkler against the normalised client name (`chambers.com` against "Chambers and Partners").

A confirmed domain is written to `domains_confirmed` on the organisation. Only confirmed domains feed `findOrganisationByDomain`. HubSpot company domains replace most of this in v2.

### 2.5 Attribution and project context

Deterministic first. No model calls in Phase 4 attribution.

A new relational table `project_locators` records where a project's context lives:

| Column | Notes |
|---|---|
| `project_node_id` | The reference Project's node id |
| `kind` | `notion_page`, `slack_channel`, `sharepoint_folder`, `jamie_tag`, `repository` |
| `value` | The page id, channel id, folder URL, tag name or repository URL |
| `principal_id` | Null for shared locators; set for `jamie_tag`, because Jamie tags belong to one person's account |
| `source` | `foundry`, `suggested`, `principal` |
| `status` | `suggested`, `confirmed`, `dismissed` |

How the table fills:

- **From Foundry.** `notionUrl` gives a confirmed `notion_page` locator for every project that has one.
- **Jamie tags.** Suggested by exact and normalised match between tag names and project names, client names and aliases. Dom's 24 tags (clients, rituals, missions, the AI-Tagged marker) are the first set. Unmatched tags are listed on the Ontology page.
- **Slack channels.** Suggested by name match between channel names and project or client names, from the channels Lance's bot can list.
- **SharePoint folders and repositories.** Entered by Dom on the Ontology page. No discovery in Phase 4.

How attribution uses it:

- A meeting carrying a confirmed `jamie_tag` gets a private `ABOUT` edge to the project.
- A thread whose external participants resolve to one Organisation gets a private `ABOUT` edge to it.
- A Notion task whose project relation matches a confirmed `notion_page` locator gets `ABOUT`. If the All Tasks database has no project relation, skip it and record the finding in the phase log.
- A commitment inherits `ABOUT` from the meeting or thread it was derived from.

How briefs use it: meeting prep for a meeting about a project lists its locators ("Plan in Notion, channel #chambers-delivery, folder on SharePoint"), so Dom and later agents look in the right place.

### 2.6 How the reference layer is read

Reference facts come through a port, so the source can change:

```ts
interface ReferenceSource {
  employees(select: EmployeeField[]): AsyncIterable<EmployeeRecord>;
  projects(select: ProjectField[]): AsyncIterable<ProjectRecord>;
  positions(select: PositionField[]): AsyncIterable<PositionRecord>;
  employee(id: string): Promise<EmployeeRecord | null>;
  project(id: string): Promise<ProjectRecord | null>;
}
```

`FoundryReferenceSource` in `packages/connectors/src/foundry` implements it against the Ontology REST API. A VIP implementation can replace it without touching the graph or the consumers.

Read-through rules:

- The daily sync (WP4.2) reads all three types, writes key nodes and reference edges, and nothing else.
- Briefs, detectors and pages call `ReferenceSource` for descriptive fields, through a cache in `packages/ontology` with a one-hour default time to live.
- If Foundry is unreachable, the cache serves its last value with a `stale_since` timestamp, the brief says so on the line it affects, and the `watcher_failed` alert fires as for any source. The cache is not an input to rebuild and nothing writes it except the read path.
- Every reference read is an `observed` ledger event with `source_system: 'foundry'`, the record id and its hash, so provenance on brief lines works as it does for mail and meetings.

### 2.7 How reads are scoped, and how shared writes happen

AGE stores vertices and edges in per-label tables inside the graph schema. Row-level security on those tables is possible but fragile, and AGE's own functions read them. So the graph is scoped in one place, `OntologyRepository`:

- Every public read method takes a `PrincipalScope`. Queries return reference and shared nodes, plus private nodes and edges whose `principal_id` equals the scope.
- `runCypher` and `sqlRunnerOf` become package-internal. An ESLint boundary rule stops any import of them outside `packages/ontology`.
- A test harness creates a second synthetic principal, writes private evidence for both, and asserts that no public method returns the other principal's nodes, edges or properties.

Writes to the shared layer that start from one principal's evidence are promotions: a confirmed domain, a confirmed locator, a `SAME_AS` merge on shared nodes, a type set by hand. Each is a proposal of action class `promote_to_shared`, decided on the Ontology page, executed by the executor as a graph mutation, and recorded like any other decision. Policy seeds the class at `propose` for every counterparty; it can never be `auto` in Phase 4 (a hard floor, tested). This is the same shape as a future handoff from Ian to Val: private evidence becomes shared context only through an approved, recorded step.

ADR 0017 records both decisions.

---

## 3. ADRs to write first

**0015. Principals and row-level security.** Add a `principals` table and a `principal_id` column to every table that holds a principal's data. Enable and force row-level security on each, with a policy on `current_setting('app.principal', true)`. `withPrincipal(db, principalId, fn)` in `@lance/db` opens a transaction and sets the value locally. A session without the setting sees no rows. Dom is the only principal; his row is created in the migration from the existing `users` row and reuses its id.

**0016. Reference data is read from Foundry through a port.** Employees, client organisations, projects and staffing are read from the Valliance ontology through `ReferenceSource`, with an explicit property allowlist. Lance stores keys and edges, not facts, and never writes to Foundry. Tasks stay in Notion (ADR 0009). Auth is OAuth authorisation code on behalf of the principal (section 10 Q1). A VIP implementation of the port can replace Foundry later.

**0017. The ontology has reference, shared and private layers.** As sections 2.1 and 2.7. Scoping lives in the repository because AGE tables do not take RLS reliably. Shared-layer writes from private evidence are `promote_to_shared` proposals, never automatic in Phase 4.

**0018. Deals are Projects of kind `presale`.** Foundry models presales as projects with HubSpot presale ids. A separate label would duplicate the node and split the timeline.

**0019. Policy evaluates in tiers.** Hard floors in code, then personal rules (`principal_id` set), then organisation defaults (`principal_id` null), then `propose`. Promotion proposals create personal rules only.

---

## 4. The principal seam in detail (WP4.1)

### 4.1 Schema

New table `principals`: `id` (ulid), `entra_oid` (unique), `upn` (unique), `slack_user_id`, `notion_user_id`, `foundry_employee_id`, `time_zone`, `status` (`active`, `paused`, `offboarded`), `created_at`, `updated_at`. No RLS on it; it is the lookup the resolvers use.

`users` stays for compatibility and is no longer written. New code reads `principals`. The rename of `config.dom`, `domUserId` and `assignedToDom` stays out of scope, per the CLAUDE.md gotcha; new code says `principal`.

`principal_id text NOT NULL REFERENCES principals(id)` on: `ledger_events`, `observations`, `proposals`, `policy_decisions`, `cursors`, `commitments`, `briefs`, `alerts`, `agent_runs`.

`principal_id` nullable on `policy_rules` (null is an organisation default) and `project_locators` (null is a shared locator).

`system_state` keeps its single-row CHECK and becomes the global row: global pause, global mode ceiling, the organisation cost ceiling. A new table `principal_state` (`principal_id` primary key, under RLS) holds each principal's pause, mode, quiet hours, push budget and cost ceiling. Dom's row is created in the migration from the current `system_state` values. The kill switch and the budget guard read both: the global row wins when it is stricter.

Unique keys that were global become per principal where two principals could legitimately collide: the ledger `idempotency_key`, `cursors (watcher, key)`, `alerts.dedupe_key`.

### 4.2 Migration against an immutable ledger

The ledger trigger rejects UPDATE. Adding a column does not run row triggers, so:

1. Insert Dom's `principals` row from `users`, reusing `users.id`.
2. In a `DO` block, read that id and `EXECUTE format('ALTER TABLE %I ADD COLUMN principal_id text NOT NULL DEFAULT %L', ...)` for each table.
3. `ALTER TABLE ... ALTER COLUMN principal_id DROP DEFAULT`, so new rows must name their principal.
4. Add the foreign keys, the per-principal unique indexes and the RLS policies.

Check the migration guard's pattern: `DROP DEFAULT` must not trip the `DROP COLUMN` rule. Run the migration as the non-superuser `lance_migrator` member in `migrate.nonsuperuser.test.ts` and once against dev before merge, per the Azure lessons in `.claude/notes/global.md`.

### 4.3 Policies

For each table: `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and one policy `USING (principal_id = current_setting('app.principal', true)) WITH CHECK (principal_id = current_setting('app.principal', true))`. For the two tables with nullable `principal_id`, `USING` also admits `principal_id IS NULL`, and `WITH CHECK` admits null only for a session that also sets `app.role = 'admin'`.

`lance_app` must not have `BYPASSRLS`. pg-boss tables are untouched.

Jobs that span principals (the scheduler, retention, the evidence export) read `principals` without a scope and then call `withPrincipal` once per principal. Nothing reads a principal-bearing table outside `withPrincipal`; a lint rule on the Drizzle client import enforces it, with an allowlist for `packages/db` itself.

### 4.4 Propagating the principal

- api, web: the principal comes from the verified Entra `oid`. The single-UPN allowlist becomes "the `oid` has an active `principals` row".
- api, Slack: the signed `user.id` resolves through `principals.slack_user_id`. No change in behaviour for Dom; the lookup replaces the constant.
- worker: every job payload carries `principalId`. The handler checks it against `principals` and runs inside `withPrincipal`. The scheduler enumerates active principals and enqueues one job per principal, watcher and partition. The Foundry sync is the one organisation-wide job: it writes reference nodes, which carry no principal, under `app.role = 'admin'`.
- agents: tool closures take the principal at construction, so a model call cannot name another principal.
- ledger: `LedgerWriter` takes the principal from the scoped transaction, never from a caller argument.

### 4.5 Tests

- A second synthetic principal writes one row to each table; a session scoped to Dom reads none of them, and an insert naming the other principal fails the `WITH CHECK`.
- A session with no `app.principal` reads zero rows from every principal-bearing table.
- The kill switch pauses one principal without pausing another, and the global row pauses both.
- The existing suites pass unchanged under Dom's scope.

### 4.6 Out of scope in Phase 4

Onboarding a second principal, `/lance login` account linking, per-principal private channels, Key Vault secrets per principal, admin roles beyond the `app.role` flag, offboarding, and any handoff to Val beyond the `promote_to_shared` pattern. `docs/plans/multi-user.md` covers all of them and starts once WP4.1 has merged.

---

## 5. Earned autonomy (the spec's Phase 4, with tiers)

The spec's scope stands: Policies page, shadow mode, promotion analyser, demotion path, executed cards with undo. Changes:

- `policy_rules` rows seeded in Phase 0 become organisation defaults (`principal_id` null) in the WP4.1 migration.
- Evaluation follows ADR 0019. `packages/policy` keeps 100% branch coverage; the property suite gains the cases that no personal rule lifts a hard floor or overrides a stricter organisation `forbid`, and that `promote_to_shared` never resolves to `auto`.
- The promotion analyser counts per principal and writes a personal rule on approval.
- Demotion affects the rule that authorised the execution, personal or organisation. Demoting an organisation default needs `app.role = 'admin'`; in v1 Dom holds it.
- Counterparty class now has data behind it. With reference Organisations typed, `client`, `prospect` and `internal` resolve for the first time. Shadow runs over the last 14 days will show cells moving out of `unknown`; the diff report states that separately from rule changes so the two effects are not confused.

---

## 6. Pages

`docs/design/README.md` says Alerts, Ontology, Policies and Agents wait for the next design pass. Build Ontology and Policies with the existing design system components; do not wait for a design package. Keep the layouts simple enough that a later design pass restyles rather than rebuilds.

**Ontology.**

- Search across Persons, Organisations and Projects, with a layer badge (Foundry, shared, mine).
- Entity page: properties with provenance links (reference fields show "from Foundry" and the read time), a timeline of the principal's own interactions, open commitments both ways, related tasks, staffing, and the project's locators.
- Review queues: `SAME_AS` candidates, domain candidates, suggested locators, unmapped Jamie tags. Each item shows the evidence and has confirm and dismiss; confirm creates the `promote_to_shared` proposal and decides it in one step.
- A reference node has no edit controls and says "Held in Foundry".

**Policies.**

- The cell matrix (action class by counterparty class, one tab per system) with the decision and tier in each cell.
- Rule history and the approvals behind each promotion.
- Shadow run form and diff report.
- Hard floors shown locked.

Slack gets no new message types except the `rule_change` proposal card and the executed card's undo control, both already in spec 9.1. Ontology review stays on the page, in line with the session's view that agents should not stream into Slack.

---

## 7. Work packages

| # | Package | Depends on | Size |
|---|---|---|---|
| WP4.1 | Principal seam: `principals`, columns, RLS, `withPrincipal`, propagation, isolation tests | none | 3 to 4 days |
| WP4.2 | `ReferenceSource` port, Foundry implementation, read-through cache, daily key sync, `foundry` source system, reconciliation of existing Persons | WP4.1 | 2 to 3 days |
| WP4.3 | Ontology layers: `layer` and `principal_id` on nodes and edges, repository scoping, `iCalUId` meeting key, Meeting content moved to `ATTENDED`, lint boundary, isolation harness, rebuild covers it all | WP4.1 | 2 days |
| WP4.4 | Attribution and context: `project_locators`, tag and channel suggestions, `ABOUT` edges, domain candidates, organisation types, `promote_to_shared`; golden sets; detectors re-tested against real types | WP4.2, WP4.3 | 2 to 3 days |
| WP4.5 | Ontology page and api | WP4.3, WP4.4 | 2 days |
| WP4.6 | Policy tiers, Policies page, shadow mode, promotion analyser, demotion, executed cards with undo | WP4.1 | 3 days |
| WP4.7 | Performance at 10k nodes, rebuild drill, VIP alignment note, phase review, deploy to dev | all | 1 to 2 days |

WP4.6 can run beside WP4.2 to WP4.5 once WP4.1 has merged.

### WP4.2 details

- `packages/connectors/src/foundry`: reads only, no `writes` module. Calls `GET /api/v2/ontologies/{ontologyRid}/objects/{objectType}` with `select` built from a hard-coded allowlist per type, and the single-object endpoint for read-through. A test fails if any allowlist contains `salary`, `dateOfBirth`, `gender`, `age`, `mobilePhone`, `contractedHours` or `productionTag`.
- Config: `FOUNDRY_BASE_URL`, `FOUNDRY_ONTOLOGY_RID` (default the rid in 1.4), the OAuth client id; secrets in Key Vault, added to the Bicep and the Key Vault runbook in dependency order.
- Watcher `foundry`: daily at 05:30 UK, before the morning brief; `/lance status` shows its age. Full read each run (30 employees, 443 projects, positions in the low hundreds); the idempotency key and content hash mean an unchanged run writes nothing. Opts out of triage, as agent-logs and notion do.
- A record that disappears from Foundry sets `active: false` on its key node; nothing is deleted.
- Dom's principal row gains his `foundry_employee_id` from the UPN match.
- Record the refresh token's lifetime on first consent. Raise a P1 alert seven days before it expires.

### WP4.3 details

- Existing nodes get `layer` by label: Person and Organisation `shared`, Meeting `shared`, Task `shared` when its source is Notion, the rest `private` with Dom's principal. Existing edges get `principal_id`.
- Meetings: backfill `ical_uid` from the calendar observations that share the Graph event id; move `graph_event_id`, `transcript_ref` and `tags` to the `ATTENDED` edge. Jamie's `externalId` resolves to an `iCalUId` through the principal's own calendar observations. A Jamie meeting with no matching calendar event keys on the Jamie id and stays resolvable by it.
- All backfills go through `apply` as recorded mutations, so `pnpm --filter @lance/ontology rebuild` reproduces them.
- Readers in `briefs/data.ts`, `debrief` and the detectors switch to the edge.

### WP4.4 details

Two new golden sets under `fixtures/evals`, scored in CI with the existing harness:

- Attribution: 40 of Dom's real meetings from the last 30 days, anonymised where they name external people, with the expected project or organisation for each.
- Resolution: the spec's 50-record entity-resolution set extended with the 30 employees, covering UPN, email alias and Slack id matches and two same-name cases.

---

## 8. Phase 4 acceptance criteria

Replaces the spec's Phase 4 line.

| Criterion | Evidence expected |
|---|---|
| Every principal-bearing table has a non-null `principal_id` under forced RLS | Isolation suite in `packages/db`: a second principal's rows are invisible and unwritable; an unscoped session reads nothing |
| The graph isolates private evidence by principal | Isolation harness in `packages/ontology` passes against every public repository method |
| The reference layer is populated and read through | In dev: 28 active employees as reference Persons with UPN, 24 with Slack ids; every Foundry project present with its `kind`; every client organisation typed; Dom's principal carries his employee id; a second sync writes nothing; a brief line built from a reference field carries a `foundry` provenance link |
| No reference facts are stored beyond keys | A test lists the properties on every reference node and fails on any outside the allowlist in 2.1 |
| Existing observed employees fold into reference nodes | Count of observed Persons with a valliance.ai email is zero after reconciliation; the mutations are in the ledger |
| One meeting is one node | A fixture with two principals' calendar events for one `iCalUId` produces one Meeting and two `ATTENDED` edges |
| Attribution works on real meetings | Attribution golden set scores at least 0.8 precision and 0.8 recall; in dev at least 80% of Dom's tagged Jamie meetings from the last 30 days carry an `ABOUT` edge |
| Every delivery project has its context | Each of the 14 delivery projects has a confirmed Notion locator and a confirmed or dismissed Slack suggestion |
| The client detectors fire on real data | `client_mail_unanswered` raises in a test built from a confirmed domain on a reference client; in dev the Ontology page shows the eleven delivery clients typed `client` |
| Shared writes are always approved | Property test: `promote_to_shared` never resolves to `auto`; every shared-layer mutation in the ledger has a decided proposal |
| Rebuild reproduces the graph | Rebuild into an empty graph in CI yields the same node and edge counts and the same `layer` and `principal_id` values |
| Meeting-prep query holds at scale | p95 under 500 ms at 10k nodes with a warm reference cache (spec 16 Q5). If it fails, the Neo4j revisit is triggered, not waived |
| Shadow run on 14 days of ledger produces a diff report | Spec criterion, with the counterparty reclassification reported apart from rule changes |
| A synthetic run of 10 approvals creates a `rule_change` proposal | Spec criterion; the proposed rule is personal |
| One reject on an auto cell demotes and alerts | Spec criterion |

---

## 9. How this lines up with VIP

WP4.7 writes `docs/design/vip-alignment.md`, one page, answering Dom's action from 22 Sep. It maps Lance against the current canon, `VallianceArchitecture_Concerns_v2.md` in Dom's Cowork folder under `outputs/valliance-enterprise-os/`, rather than the superseded eight-layer model. The substance:

- Lance consumes the Valliance ontology through a port and does not copy it. That is James's outside-in path: the consumer stands on Foundry now and on a VIP core later.
- The three layers map onto the personal and team boundary from the session. Reference and shared are team context; private is personal context; `promote_to_shared` is the approved step between them, and the shape a handoff to Val will take.
- The ledger, provenance on every claim, deterministic policy and the golden sets are the decision-tracing, observability and evaluation items on the framework scope list Tarek and Dom are drafting for the two-week workshop.
- Offered to the framework workshop as reusable pieces: the principal seam and its isolation tests, the tier model, the `ReferenceSource` port, and the `promote_to_shared` pattern.

---

## 10. Open questions and defaults

| # | Question | Default in force |
|---|---|---|
| Q1 | Foundry auth: OAuth on behalf of the principal, or a service identity with client credentials | On behalf of the principal, so Foundry markings match what Dom can see. If the refresh token lives less than 30 days (Tarek re-authenticates the Foundry MCP weekly), switch the daily key sync to a service identity scoped to the three object types and keep read-through on the principal's token. Record the choice in ADR 0016 |
| Q2 | Which Foundry project types to sync | All five. `planning` projects are most of the count and are where missions live |
| Q3 | Domain candidate threshold | 0.85 name similarity, or one co-occurrence with a confirmed tag; always confirmed by Dom |
| Q4 | Does the Notion All Tasks database carry a project relation | Check during WP4.4; skip task attribution if not |
| Q5 | Who holds `app.role = 'admin'` | Dom only, from config |
| Q6 | Should shared-layer merges need a second approver | No in v1. One admin approval, recorded |
| Q7 | Reference cache time to live | One hour; the morning brief forces a refresh of the entities it names |

---

## 11. Risks

- **RLS on a busy ledger.** The policy adds a predicate to every ledger query. Index `(principal_id, id)` on `ledger_events` and `observations` and check the Ledger page's own queries before and after, per the CLAUDE.md rule that a repair is verified through the consuming page.
- **Read-through latency.** Meeting prep now makes Foundry calls. The cache and the brief's forced refresh keep this off the critical path; the 500 ms criterion is measured with a warm cache and the cold figure is recorded next to it.
- **Foundry outages and token expiry.** A failed read serves the cached value marked stale and raises `watcher_failed`. Token expiry is alerted a week ahead. Lance never falls back to guessing an employee from a name.
- **Reference data that is wrong.** Lance cannot fix it. `reference_data_conflict` points at the Foundry record so its owner can.
- **Scope creep into multi-user.** Section 4.6 is the boundary. A second real principal waits for the framework workshop's multiplayer model.
- **Cost of first sync.** Small (a few hundred records, no triage), but the lesson from the Notion backfill applies: confirm the watcher opts out of triage before it first runs.
