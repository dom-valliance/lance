# Ian: Specification v1

Personal operating agent for Dom Selvon. Watches mail, calendar, meetings and tasks; keeps a ledger of everything it sees and does; proposes actions through Slack; executes only what policy allows; prepares the day. Built with the Anthropic Agent SDK in TypeScript on Azure Container Apps, backed by Postgres with a graph ontology, fronted by Next.js.

Ian is the personal half of the Val/Ian pair. Val (company-wide, own Entra identity) is out of scope for v1 and shares this substrate later. Every design choice below should survive a second agent identity being added without a rewrite.

---

## 0. How Claude Code should use this document

Read the whole file before writing code. Then:

1. Generate `CLAUDE.md` at the repo root from sections 0, 3, 16 and 17. It must state the non-negotiables in section 2 verbatim.
2. Build in the phase order of section 15. Do not start a phase until the previous phase's acceptance criteria pass in CI.
3. Record every architectural deviation from this spec as an ADR in `docs/adr/NNNN-title.md` before implementing it. Deviations without an ADR are bugs.
4. Where this spec says "default", implement the default and expose the value in configuration. Where it says "hard floor", the value is code, not configuration, and has a test proving it cannot be overridden.
5. Open questions in section 16 have stated defaults. Build the default; do not block.
6. All UI copy and log messages are British English. No em dashes anywhere in copy, code comments or docs. No emojis in UI copy.
7. Conventional commits. Feature flags for anything that touches an external system in write mode. Secrets never in the repo, never in container env at build time.

---

## 1. Purpose and scope

### 1.1 What Ian does

- Watches Outlook mail and calendar, Jamie meetings and tasks, Notion tasks and meeting notes, and the logs of other agents.
- Records every observation, proposal, decision and action in an append-only ledger.
- Resolves people, organisations, meetings, tasks and commitments into one ontology so the same person in four systems is one node.
- Proposes actions (draft a reply, create a task, tag a meeting, hold time) through a Slack bot and a web UI. Executes only proposals that policy resolves to `auto` or that Dom approves.
- Prepares the day at 06:30 and closes it at 16:00 with a board of what moved and what is waiting.
- Prepares each meeting and debriefs it when the transcript lands.
- Tracks commitments in both directions: what Dom owes and what others owe him.
- Raises alerts from agent logs, calendar, commitments and mail, within an interruption budget.
- Learns which action classes Dom always approves and proposes promoting them to autonomous, one cell at a time.

### 1.2 In scope for v1

- Single user (Dom), single tenant, delegated permissions only.
- Sources: Microsoft Graph (mail, calendar), Jamie, Notion, Ian's own telemetry, the existing inbox-agent Slack channel, a generic log-ingest webhook.
- Adjudication: Slack bot user posting into the existing `dom-claude-agent` channel (C0BU7P278N5), plus the Next.js UI.
- Write actions limited to: create Outlook draft, apply Outlook category, move mail to a folder Dom created, create or update Notion task, create Jamie task, apply Jamie tag, create calendar hold, post Slack message. Nothing else in v1.
- Azure: Container Apps, Azure Database for PostgreSQL Flexible Server with the `age` extension, Key Vault, Container Registry, Log Analytics and Application Insights.

### 1.3 Out of scope for v1

- HubSpot (v2, first Val-shared source).
- Sending email. Ian drafts; Dom sends. Hard floor in v1.
- Deleting anything in any external system. Hard floor, permanent.
- Teams as a surface.
- Multi-user, Val identity, Foundry Agent Service hosting.
- Mobile shell.

---

## 2. Non-negotiables

These are enforced in code and tested. They go into `CLAUDE.md` verbatim.

1. **Ledger first.** No external read or write happens without a ledger event. The ledger table accepts INSERT and SELECT only; the application role has no UPDATE or DELETE grant and a trigger rejects both.
2. **LLMs cannot write to external systems.** Model-backed agents have read tools and one write tool: `create_proposal`. The executor is deterministic code that runs approved proposals. There is no code path from a model response to a connector write.
3. **Policy is data, deletes are code.** Every action resolves through the policy engine to `forbid`, `propose` or `auto`. Delete actions and outbound email sends are hard floors at `forbid` in v1 and no rule can lift them.
4. **Autonomy is per cell.** A rule grants `auto` to one (action class, counterparty class, system) cell. One override by Dom on an `auto` cell demotes it to `propose` and raises an alert.
5. **Provenance on every claim.** Every alert, brief line and proposal carries the source system, record id, record hash and observed-at timestamp. The UI renders these as links.
6. **Idempotent ingestion.** Every watcher keeps a cursor; every observation has an idempotency key of `system:record_id:content_hash`. Re-running a watcher over the same window produces no new events.
7. **Kill switch.** One command pauses all watchers and the executor within one scheduler tick (default 30 s) and cancels queued proposals' execution. Reads may continue; writes stop.
8. **Non-destructive by construction.** Ian never overwrites content it did not create. Updates to Notion tasks touch only fields Ian set or Dom approved in the proposal preview.

---

## 3. Architecture

### 3.1 Layered view

```
┌─────────────────────────────────────────────────────────────────────┐
│ apps/web  Next.js 15 App Router, React 19, Tailwind, shadcn         │
│   Today · Proposals · Tasks · Commitments · Alerts · Ontology       │
│   Policies · Ledger · Agents · Settings                              │
└─────────────────────────────────────────────────────────────────────┘
                        ▲ tRPC over HTTPS + SSE for live updates
┌─────────────────────────────────────────────────────────────────────┐
│ apps/api  Fastify + tRPC                                            │
│   Auth (Entra), proposals, policy CRUD, ledger queries,             │
│   Slack events + interactivity endpoints, log-ingest webhook        │
└─────────────────────────────────────────────────────────────────────┘
                        ▲ pg-boss jobs (Postgres-backed queue)
┌─────────────────────────────────────────────────────────────────────┐
│ apps/worker  Node 22                                                │
│   Scheduler · Watchers · Triage · Planner · Critic · Executor       │
│   Promotion analyser · Retention jobs                               │
│   Model agents built on @anthropic-ai/claude-agent-sdk              │
└─────────────────────────────────────────────────────────────────────┘
                        ▲
┌─────────────────────────────────────────────────────────────────────┐
│ packages/                                                           │
│   ledger · policy · ontology (Apache AGE) · connectors              │
│   (graph, jamie, notion, slack) · agents · shared types · config    │
└─────────────────────────────────────────────────────────────────────┘
                        ▲
┌─────────────────────────────────────────────────────────────────────┐
│ Azure Database for PostgreSQL Flexible Server                       │
│   relational schema (section 5) + AGE graph `ian_ontology`          │
│   pgvector for embeddings                                           │
└─────────────────────────────────────────────────────────────────────┘
```

Three Container Apps: `web`, `api`, `worker`. One Postgres. One Key Vault. No Redis; pg-boss uses Postgres for the queue. Add Redis only if queue latency is measured as a problem.

### 3.2 Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x, Node 22 LTS | End to end. No Python. |
| Monorepo | pnpm workspaces + Turborepo | |
| Web | Next.js 15 App Router, React 19, Tailwind, shadcn/ui | Valliance internal brand: Satoshi type, soft radii. Dark mode first. |
| API | Fastify 5, tRPC 11, Zod | Shared types via `packages/shared`. |
| Queue and scheduler | pg-boss | Cron jobs and work queues in Postgres. |
| ORM | Drizzle | Relational schema. Migrations are forward-only; no down migrations that drop data. |
| Graph | Apache AGE on the same Postgres | Cypher via `SELECT * FROM cypher(...)`. Behind `OntologyRepository` interface so Neo4j can replace it if AGE performance or Cypher coverage fails. |
| Embeddings | pgvector | For semantic search over transcripts, mail bodies and documents. |
| Model agents | `@anthropic-ai/claude-agent-sdk` | Anthropic API direct by default. `ANTHROPIC_BASE_URL` configurable so the Foundry-hosted Claude endpoint can be swapped in without code change. |
| Models | Opus for planner and critic; Sonnet for triage; Haiku for watcher classification | Model ids in config, never in code. |
| Auth | Auth.js with Microsoft Entra ID provider | Allowlist of one UPN in v1. |
| Telemetry | OpenTelemetry → Application Insights | Traces, metrics, structured logs. |
| Infra | Bicep in `infra/` | Entra app registration is a documented manual step in `docs/runbooks/entra-setup.md`. |
| CI | GitHub Actions | Lint, typecheck, unit, policy tests, replay tests, Playwright e2e, Bicep what-if. |

### 3.3 Deployment topology

- Container Apps environment with internal ingress for `api` and `worker`, external ingress for `web` and for the `api` Slack and webhook routes only (path-scoped).
- Managed identity on each Container App. Key Vault references for secrets. Postgres auth via Entra managed identity where the driver supports it; password auth from Key Vault as fallback.
- `worker` runs as a single replica in v1. pg-boss handles job locking so a second replica is safe later.
- All outbound calls to Graph, Jamie, Notion, Slack and Anthropic go through `packages/connectors` with per-connector rate limits, retries with jitter, and circuit breakers. A tripped breaker is an alert (section 11), never a silent skip.

---

## 4. Identity, security and compliance

### 4.1 Ian's identity

One Entra app registration, `Ian (Valliance)`, single-tenant, delegated permissions only. Ian acts as Dom via OAuth 2.0 authorisation code with PKCE and refresh tokens. Tokens live in Key Vault, never in Postgres.

Graph scopes requested in v1:

| Scope | Why |
|---|---|
| `User.Read` | Identity. |
| `Mail.ReadWrite` | Read mail, create drafts, apply categories, move to folders. |
| `Calendars.ReadWrite` | Read events, create holds. Hold creation is `propose` by default. |
| `MailboxSettings.Read` | Time zone and working hours for the interruption budget. |
| `offline_access` | Refresh tokens. |

`Mail.Send` is not requested in v1. The absence of the scope is the second lock behind the policy hard floor.

Jamie: API token from Dom's account, stored in Key Vault. Notion: internal integration token, shared only with the databases and pages Ian needs. Slack: a new app `Ian` with a bot user; scopes `chat:write`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `reactions:read`, `reactions:write`, `commands`, `users:read`. Interactivity and events over HTTPS to `api`, signed-request verification on every call.

The Slack bot posts as `Ian`, never as Dom. This is what makes messages arrive unread.

### 4.2 Secrets and rotation

- All secrets in Key Vault. Container Apps read them as Key Vault references at start.
- Refresh tokens rotated on every use. Failure to refresh raises a P0 alert and pauses the affected watcher.
- A `docs/runbooks/rotate-secrets.md` runbook. Rotation is tested quarterly.

### 4.3 Kill switch

- `POST /admin/pause` (Entra-authenticated, Dom only), `/ian pause` in Slack, and a button in Settings. All three set `system_state.paused = true` with a reason and actor, recorded in the ledger.
- Scheduler checks the flag every tick. Watchers and executor exit early when paused. Queued executions are marked `held`, not cancelled; `resume` re-queues them after a fresh policy evaluation.
- A pause survives restarts because it lives in Postgres.

### 4.4 Data protection

Ian holds mail, transcripts and notes that name people who have not consented to an agent reading them. Requirements:

- Data map in `docs/compliance/data-map.md` listing every table, what personal data it holds, source, purpose, lawful basis (legitimate interests, with the LIA documented), retention.
- Retention defaults: raw mail bodies 90 days; transcripts 180 days; ontology facts indefinite; ledger 2 years; model prompt and response logs 30 days. Retention job runs nightly and writes a `retention_applied` ledger event with counts. Ledger rows are never deleted by the job; the raw payload column is nulled and the hash kept.
- Model calls do not include third-party personal data beyond what the task needs. Triage receives mail headers and body; planner receives ontology summaries, not raw transcripts, unless preparing a specific meeting.
- ISO 27001 evidence export: `GET /admin/evidence?from&to` produces a signed JSON bundle of ledger events, rule changes, access log and retention runs for the period.

---

## 5. Data model

### 5.1 Relational schema (Drizzle, Postgres)

Ids are ULIDs. Timestamps are `timestamptz`. All tables have `created_at`. Tables that represent mutable state have `updated_at`; the ledger does not.

**ledger_events** (append-only)

| Column | Type | Notes |
|---|---|---|
| id | ulid | |
| ts | timestamptz | Event time, not insert time. |
| actor | text | `agent:triage@1.4.0`, `agent:executor@1.4.0`, `user:dom`, `system:retention` |
| kind | enum | `observed`, `resolved`, `proposed`, `decided`, `executed`, `failed`, `alert_raised`, `alert_acked`, `rule_changed`, `state_changed`, `retention_applied`, `cost_recorded` |
| source_system | text nullable | `graph`, `jamie`, `notion`, `slack`, `ian`, `webhook` |
| source_record_id | text nullable | |
| source_record_hash | text nullable | SHA-256 of the canonicalised record. |
| idempotency_key | text unique nullable | `system:record_id:hash` for `observed`. |
| correlation_id | ulid | Ties an observation to its proposals, decisions and executions. |
| parent_event_id | ulid nullable | |
| policy_decision_id | ulid nullable | |
| payload | jsonb | Event-specific. Nulled by retention for raw content; structure kept. |
| payload_hash | text | Kept after retention. |

Grants: `ian_app` role has `SELECT, INSERT`. Trigger `ledger_immutable` raises on UPDATE or DELETE. A test in `packages/ledger` asserts both.

**observations**: normalised view of `observed` events for query convenience. Materialised from the ledger; rebuildable.

**proposals**

| Column | Notes |
|---|---|
| id, correlation_id | |
| action_class | enum, section 6.1 |
| counterparty_class | enum, section 6.1 |
| target_system, target_record_id | |
| reversibility | enum `reversible`, `compensatable`, `irreversible` |
| payload | jsonb, the exact write the executor will perform |
| preview | text, human-readable rendering shown in Slack and UI |
| rationale | text, one paragraph from the proposing agent, with provenance refs |
| provenance | jsonb array of `{system, record_id, hash, observed_at, url}` |
| policy_decision | enum `forbid`, `propose`, `auto` |
| policy_rule_id | nullable |
| status | enum `pending`, `approved`, `edited`, `rejected`, `expired`, `held`, `executing`, `executed`, `failed` |
| decided_by, decided_at, decision_note | |
| edited_payload | jsonb nullable, when Dom edits before approving |
| slack_channel, slack_ts | for updating the card |
| expires_at | default now + 48 h |
| execution_event_id | nullable |

**policy_rules**: section 6.2.

**policy_decisions**: every evaluation, with the matched rule id, inputs and result. Referenced by ledger.

**cursors**: `(watcher, key) → value, updated_at`. One row per watcher per partition (for example per mail folder).

**alerts**: id, severity, kind, dedupe_key, title, body, provenance, status (`open`, `acked`, `resolved`, `suppressed`), first_seen, last_seen, count, acked_by, acked_at, slack_ts.

**tasks_ian**: Ian-native tasks that have no home in Notion or Jamie. Everything else is read from source and referenced by ontology.

**commitments**: id, direction (`outbound` = Dom owes, `inbound` = owed to Dom), owner_person_id, counterparty_person_id, description, due_at (nullable), due_confidence, evidence_quote, source refs, status (`open`, `chased`, `done`, `dropped`), chase_count, next_chase_at.

**briefs**: generated morning briefs, afternoon boards, meeting preps and debriefs, weekly reviews. Content as structured JSON plus rendered markdown. Linked to the ledger correlation id.

**agent_runs**: one row per agent invocation: agent, version, model, started, finished, status, input tokens, output tokens, cache read tokens, estimated cost, trace id.

**system_state**: single row: paused, paused_reason, paused_by, mode (`live`, `dry_run`), quiet_hours, push_budget_per_hour.

**users**: one row in v1. UPN, Slack user id, time zone.

### 5.2 Graph ontology (Apache AGE, graph `ian_ontology`)

Node labels and required properties. Every node carries `id`, `created_at`, `updated_at`, `source_refs: [{system, id, url, observed_at}]`, `confidence`.

| Label | Properties |
|---|---|
| Person | display_name, emails[], slack_id, notion_user_id, jamie_participant_ids[], org_id, role, is_internal |
| Organisation | name, domains[], type (`client`, `prospect`, `partner`, `vendor`, `internal`, `unknown`) |
| Meeting | title, start, end, jamie_id, graph_event_id, transcript_ref, tags[] |
| Task | title, status, due, source (`notion`, `jamie`, `ian`), source_id, assignee_id |
| Commitment | mirrors `commitments` row id; graph holds relationships only |
| Thread | graph_conversation_id, subject, last_message_at, participants |
| Document | title, url, system, last_modified |
| Project | name, notion_page_id, client_org_id, status. Valliance calls these missions; keep both names in `aliases[]`. |
| Agent | name, version, owner. Ian's own agents and external agents whose logs it watches. |

Edges: `WORKS_AT`, `ATTENDED`, `ORGANISED`, `MENTIONS`, `ASSIGNED_TO`, `OWES` (Commitment → Person), `OWED_TO` (Commitment → Person), `ABOUT` (Commitment/Task/Meeting → Project or Organisation), `DERIVED_FROM` (Commitment/Task → Meeting or Thread), `PARTICIPATED_IN` (Person → Thread), `RELATES_TO`, `SAME_AS` (candidate identity merge, with `confidence`, `status`).

All graph mutations go through `OntologyRepository` and emit a `resolved` ledger event with the Cypher delta. The graph is rebuildable from the ledger; a `pnpm ontology:rebuild` script proves it and CI runs it against fixtures.

### 5.3 Entity resolution

Deterministic first, probabilistic second, human third.

1. Exact keys: email address → Person; email domain → Organisation (excluding public providers list); Notion user id; Jamie participant email; Slack user id. Merge automatically at confidence 1.0.
2. Name plus organisation match with normalised strings (case, diacritics, honorifics stripped). Above 0.95 merge automatically and record; 0.75 to 0.95 create a `SAME_AS` candidate for review in the UI Ontology page. Below 0.75 no candidate.
3. Never auto-merge two Persons who have both appeared as distinct attendees in the same meeting.
4. Merges are reversible: `SAME_AS` with `status = merged` records the prior ids; an unmerge restores them. Both are ledger events.

Identity candidates go to the UI, not Slack. They are not urgent.

---

## 6. Policy engine (`packages/policy`)

Pure TypeScript. No model calls. Deterministic. 100% branch coverage required in CI.

### 6.1 Dimensions

**action_class**: `read`, `classify`, `draft_email`, `apply_category`, `move_mail`, `create_task`, `update_task`, `complete_task`, `create_tag`, `apply_tag`, `create_calendar_hold`, `post_slack`, `send_email`, `delete`.

**counterparty_class**: `self`, `internal`, `client`, `prospect`, `partner`, `vendor`, `unknown`. Derived from the ontology: the Organisation type of the most external participant. `unknown` when any participant cannot be resolved.

**system**: `graph`, `jamie`, `notion`, `slack`, `ian`.

**reversibility**: `reversible` (a category, a tag, an Ian-native task), `compensatable` (a Notion task that can be marked cancelled, a draft that can be discarded), `irreversible` (a sent email, a delete). Assigned per action class in code.

### 6.2 Rules

```ts
type Decision = 'forbid' | 'propose' | 'auto';

interface PolicyRule {
  id: string;
  version: number;
  active: boolean;
  actionClass: ActionClass | '*';
  counterpartyClass: CounterpartyClass | '*';
  system: System | '*';
  decision: Decision;
  conditions?: {
    withinWorkingHours?: boolean;
    maxPerDay?: number;
    maxPerHour?: number;
    requireCriticPass?: boolean;   // default true for auto
    minConfidence?: number;        // proposing agent's confidence
  };
  createdBy: 'user:dom' | 'agent:promotion-analyser';
  createdAt: string;
  rationale: string;
}
```

Evaluation order:

1. Hard floors. `delete` → `forbid`. `send_email` → `forbid`. Not consultable, not overridable. A test asserts that a rule with `decision: 'auto'` on either class is rejected at write time with a validation error.
2. Most specific active rule wins: exact match on all three dimensions beats two, beats one, beats wildcard. Ties broken by newest version.
3. No rule → `propose`.
4. Conditions unmet on an `auto` rule → downgrade to `propose` with a reason, never to `forbid`.
5. Result written to `policy_decisions` and referenced by the ledger.

Seed rules for v1 (`packages/policy/seed.ts`):

| action_class | counterparty | system | decision |
|---|---|---|---|
| read, classify | * | * | auto |
| apply_category | * | graph | auto (newsletters, notifications only, by classifier label) |
| move_mail | * | graph | auto for `Newsletters` and `Notifications` labels into the `AI-Filed` folder; propose otherwise |
| apply_tag | * | jamie | auto for existing tags; propose for `create_tag` |
| create_task | self, internal | notion, ian | propose |
| create_task | client, prospect, partner, vendor, unknown | * | propose |
| update_task, complete_task | * | notion | propose |
| draft_email | * | graph | propose |
| create_calendar_hold | * | graph | propose |
| post_slack | self | slack | auto (Ian's own channel only) |

### 6.3 Modes

- `live`: decisions execute according to policy.
- `dry_run`: everything runs, ledger fills, proposals are created with `status = held`, nothing is written externally, Slack receives a single daily digest of what would have happened. First five working days after any new watcher goes live are dry run by default.
- `shadow`: offline. `pnpm policy:shadow --rules candidate.json --from 2026-09-01 --to 2026-09-14` replays `observed` events from the ledger through the candidate ruleset and prints a diff against actual decisions: what would have gone auto that was proposed, what would have been forbidden, counts per cell. Also exposed in the Policies UI.

### 6.4 Earned autonomy

The promotion analyser runs nightly as deterministic code.

- For each (action_class, counterparty_class, system) cell currently at `propose`, count consecutive proposals that Dom approved without edit. Defaults: threshold 10 consecutive, minimum span 14 days, zero rejections or edits in the window.
- When met, create a proposal of action class `rule_change` (internal, `propose` always) with the evidence: the list of approved proposal ids, span, and the candidate rule. Dom approves in Slack or the UI. Approval writes the rule and a `rule_changed` event.
- Demotion is immediate and automatic: one rejection or edit of an `auto` execution's outcome (Dom reacts with the reject control on the executed card, or edits the created artefact within 24 h in a way the watcher observes) sets the rule inactive, writes `rule_changed`, raises a P1 alert.
- `rule_change` itself can never be `auto`. Hard floor.

---

## 7. Agents (`packages/agents`, run by `apps/worker`)

Six roles. Add a seventh only with an ADR showing one of these is measurably overloaded.

Model-backed agents use the Anthropic Agent SDK with a fixed toolset. Tools available to model agents are read tools over the ontology, ledger and source records, plus `create_proposal`. No connector write function is registered as a tool. Structured outputs enforced with Zod schemas; a schema failure is a `failed` event and a retry with the validation error in context, once.

Every agent run records an `agent_runs` row and an OpenTelemetry span with the correlation id.

### 7.1 Watchers (deterministic, Haiku for labelling only)

One per source. Each implements:

```ts
interface Watcher {
  name: string;
  schedule: string;                  // cron
  partitions(): Promise<string[]>;   // e.g. mail folders
  poll(partition: string, cursor: Cursor | null): Promise<{ records: SourceRecord[]; nextCursor: Cursor }>;
  normalise(record: SourceRecord): Observation;
}
```

The runner handles cursors, idempotency keys, ledger writes, ontology upserts of raw references, and enqueues triage jobs. Watchers never call models except a single Haiku label call in `normalise` where stated.

| Watcher | Schedule | Cursor | Notes |
|---|---|---|---|
| `graph-mail` | every 10 min 07:00 to 19:00 UK weekdays, hourly otherwise | Graph delta token per folder | Inbox and Sent. Haiku labels each message into the existing taxonomy (Deals, Internal, Action, Calendar, Alerts, Newsletters, Priority). Sent mail feeds commitment extraction. |
| `graph-calendar` | every 15 min | delta token | Next 14 days. Detects new, moved, cancelled events and attendee changes. |
| `jamie` | every 15 min | last meeting updated_at | Meetings, transcripts when ready, tasks assigned to Dom, tags. Uses Jamie's API or MCP endpoint per section 16 Q1. |
| `notion` | every 15 min | last_edited_time | All Tasks DB (`20257534-6e48-81fe-b4b5-000b69ecace6`, Dom's user id `1fdd872b-594c-8146-b22f-00028f1f5a41`), Meetings DB, project pages Ian is shared on. |
| `agent-logs` | continuous | per stream | Three streams: Ian's own OTel spans via App Insights query; the `dom-claude-agent` Slack channel history (the inbox agent's digests and watermark lines); `POST /ingest/agent-log` webhook for any other agent with a shared secret. Emits `observed` with `kind: agent_log`. |

Watcher failures: three consecutive failures on a partition trip the circuit breaker, raise a P1 alert with the last error, and stop that partition until reset or until the next successful health probe. Never skip silently.

### 7.2 Triage (Sonnet)

Input: a batch of new observations for one correlation id (a mail thread, a meeting, a task change, a log line).

Output (Zod-validated):

```ts
{
  importance: 0..1,
  urgency: 0..1,
  summary: string,               // one sentence
  entities: EntityRef[],         // resolved or candidate people/orgs/projects
  commitments: CommitmentCandidate[],
  taskCandidates: TaskCandidate[],
  proposals: ProposalDraft[],    // action_class, target, payload, preview, rationale, confidence
  alertCandidates: AlertCandidate[]
}
```

Rules in the system prompt: cite provenance for every commitment and task candidate with a verbatim quote; never propose `send_email` or `delete`; draft replies must follow `docs/voice/writing-style.md` (copied from Dom's `aboutme/writing-style.md`, hard rules section only); prefer no proposal over a weak one.

Triage submits proposals through `create_proposal`, which runs the policy engine and routes: `forbid` → ledger only; `propose` → Slack card and UI; `auto` → Critic then Executor.

### 7.3 Planner (Opus)

Scheduled and event-driven. Produces briefs (section 10). Reads ontology summaries, open commitments, tasks across sources, calendar, alerts, agent health. Proposes calendar holds and tasks through `create_proposal`. Never receives raw mail bodies except for the meeting it is preparing.

### 7.4 Critic (Sonnet by default, Opus for `draft_email`)

Runs before any `auto` execution and before any `draft_email` proposal is shown to Dom.

Checks: target record in payload matches the proposal's provenance; action class matches the rule that authorised it; draft text passes the style hard rules (no em dashes, no correlative conjunctions, British spelling, none of the banned phrases list); no personal data of a third party is being written into a system where it did not already exist; for Notion updates, only permitted fields change.

A failed check on an `auto` path downgrades the proposal to `propose` with the critic's note attached. A failed check on a `propose` path attaches the note to the card. The critic never approves anything into execution; it can only hold.

### 7.5 Executor (deterministic)

Consumes `approved` and `auto` proposals from the queue. For each:

1. Re-evaluate policy at execution time (rules may have changed; system may be paused).
2. Fetch the target record fresh and compare its hash with the one in provenance. Mismatch → `held` with reason `target_changed`, card updated, no write.
3. Perform the single connector write. One proposal, one write. Compound actions are multiple proposals sharing a correlation id.
4. Write `executed` or `failed`. Update the Slack card and UI.
5. For `compensatable` actions, store the compensation payload (for example, the Notion task id to mark cancelled) on the proposal.

### 7.6 Promotion analyser (deterministic)

Section 6.4. Nightly at 02:00 UK.

---

## 8. Connectors (`packages/connectors`)

Each connector exposes typed read and write functions, its own rate limiter, retry policy and circuit breaker, and records every call as an OTel span with request hash and response status. Write functions are callable only from `apps/worker/executor`; an ESLint rule enforces the import boundary.

| Connector | Reads | Writes (v1) |
|---|---|---|
| `graph` | messages (delta), events (delta), mail folders, categories, mailbox settings | create draft, create reply draft, apply categories, move message, create event (hold) |
| `jamie` | meetings, transcripts, tasks, tags, participants | create task, create tag, add tag to meetings |
| `notion` | data sources (All Tasks, Meetings), pages, comments | create page in data source, update permitted properties, add comment |
| `slack` | channel history (for agent-logs watcher), reactions | post message, update message, open modal, ephemeral message |

Fixtures: every connector ships recorded responses under `__fixtures__` and tests run against them with `msw`. Live tests behind `LIVE_CONNECTOR_TESTS=1`.

---

## 9. Slack protocol

Bot user `Ian`. Channel `dom-claude-agent` (C0BU7P278N5) for v1; migrate the inbox agent's posting into Ian by the end of Phase 1 so the channel has one voice. Everything Ian posts in Slack is also in the UI, and vice versa; the proposal id is the join.

### 9.1 Message types

**Proposal card** (Block Kit). Header with action class and counterparty class chips. Preview (the draft, the task, the hold). Rationale, one paragraph. Provenance links. Buttons: `Approve`, `Edit`, `Reject`, `Snooze 4h`. Footer: proposal id, expires-at, policy cell. Edit opens a modal pre-filled with the payload's editable fields; submitting sets `status = edited` with `edited_payload`, then executes. Reject opens an optional reason field; the reason is training data for the promotion analyser (a reject with reason `wrong_target` weighs differently from `not_now`).

**Executed card**. Posted for `auto` executions. Contains what was done, the link, and a single `Undo / flag` button. Pressing it triggers demotion (section 6.4) and, for compensatable actions, queues the compensation as a new proposal.

**Alert**. Severity chip, title, body, provenance, `Ack` and `Mute 24h` buttons. Repeat alerts with the same dedupe key update the existing message and increment the count rather than posting again.

**Morning brief** 06:30 UK weekdays, **afternoon board** 16:00, **weekly review** Friday 16:30. Posted as a parent message with sections in a thread so the channel stays scannable. Content in section 10.

**Meeting prep** posted 30 minutes before each external meeting and 10 minutes before internal ones, as a thread reply under the morning brief's entry for that meeting.

**Debrief** posted when a transcript lands, as a new card with its proposals threaded beneath it.

### 9.2 Commands

`/ian task <text>` creates an Ian-native task (auto) and, if the text names a project or person the ontology resolves, proposes a Notion task instead. `/ian brief` regenerates the morning brief now. `/ian status` prints paused state, mode, watcher cursors and last-run ages, today's cost. `/ian pause [reason]` and `/ian resume`. `/ian chase <commitment id>` drafts a chase email as a proposal.

### 9.3 Free text

A thread reply under a proposal or brief is routed to the Planner as an instruction with the parent's correlation id. The Planner may reply in thread, create proposals, or update a commitment. It cannot execute.

### 9.4 Interruption budget

- Quiet hours default 19:00 to 07:00 UK and all weekend. Configurable in Settings.
- P0 pierces quiet hours and posts immediately. P1 posts within the hour during working hours, otherwise at 07:00. P2 appears only in the next brief or board.
- Push budget default 3 unsolicited posts per hour. Overflow batches into a single "and 4 more" post with a UI link. Proposal cards count as pushes; brief and board do not.

---

## 10. Briefs

Generated by the Planner, stored in `briefs`, rendered to Slack and to the Today page. Every line has provenance.

### 10.1 Morning brief (06:30)

1. Day shape: first and last meeting, total meeting hours, longest free block. Proposed holds if free time is under a configurable minimum (default 2 h).
2. Meetings, in order. For each: attendees resolved to Person nodes with organisation, last three interactions with each (mail, meetings), open commitments in both directions with those people or that organisation, documents and transcripts referenced in the last 30 days, and two suggested objectives. Unknown attendees flagged.
3. Tasks: due today or overdue across Notion, Jamie and Ian-native, deduplicated by ontology, source badge on each. Top five by the Planner's ranking with a one-line reason each.
4. Waiting for: inbound commitments past their chase date, with a `Chase` button that creates a `draft_email` proposal.
5. Overnight: alerts raised, proposals awaiting decision (count and the top three), what executed automatically.
6. Agent health: one line. Watcher ages, breaker states, yesterday's cost.

### 10.2 Afternoon board (16:00)

What moved since the brief: tasks completed, proposals decided, commitments closed. What is still pending decision. Tomorrow's first meeting and whether prep exists. Nothing else.

### 10.3 Meeting prep

The meeting section from 10.1 in full, plus the last transcript with the same organisation summarised to five lines, plus open Notion tasks tagged to the project.

### 10.4 Debrief

Triggered by a Jamie transcript arriving for a meeting Dom attended. Triage extracts decisions, action items, commitments (direction tagged), and open questions, each with a verbatim quote. Planner turns them into proposals: Notion tasks for actions assigned to Dom or to Valliance people, Jamie tags for the meeting, commitments recorded, one follow-up email draft in Dom's voice to the external attendees if any. All `propose` in v1.

### 10.5 Weekly review (Friday 16:30)

Commitments ageing table both directions. Task completion by source. Proposals by cell: counts of approved, edited, rejected, auto. Promotion candidates. Cost by agent. Alerts by kind. Three questions the Planner wants Dom to answer to improve next week's ranking, asked in thread.

---

## 11. Alerts

| Kind | Source | Default severity | Dedupe key |
|---|---|---|---|
| `watcher_failed` | runner | P1 | watcher:partition |
| `breaker_open` | connectors | P1 | connector |
| `token_refresh_failed` | auth | P0 | connector |
| `agent_step_skipped` | agent-logs watcher | P1 | agent:step |
| `stale_watermark` | agent-logs watcher (inbox agent digests) | P1 | agent |
| `cost_spike` | agent_runs (day > 2× trailing 7-day mean) | P1 | date |
| `calendar_conflict` | graph-calendar | P1 | event pair |
| `external_meeting_unknown_attendee` | graph-calendar + ontology | P2 | event |
| `commitment_overdue_outbound` | commitments | P1 | commitment |
| `client_mail_unanswered` | graph-mail (client domain, no reply in 3 working days) | P1 | thread |
| `risk_language_in_client_mail` | triage (Haiku label: complaint, escalation, contract, legal) | P0 | thread |
| `auto_rule_demoted` | promotion analyser | P1 | rule |
| `proposal_expiring` | proposals (6 h before expiry, only for client counterparty) | P2 | proposal |

Alerts carry provenance and a suggested action where one exists. Ack resolves the Slack card and the UI row. Mute suppresses the dedupe key for the period and is itself a ledger event.

---

## 12. Web UI (`apps/web`)

Entra sign-in; one allowed UPN. Server components by default; SSE from `api` for live proposal and alert updates. Valliance internal styling: Satoshi, soft radii, dark first, British copy, no emojis.

| Page | Purpose |
|---|---|
| Today | Rendered morning brief with live state; regenerate button; afternoon board below it after 16:00. |
| Proposals | Queue with the same four actions as Slack. Filters by cell, status, system. Diff view for edited proposals. |
| Tasks | Aggregated across Notion, Jamie, Ian-native. Source badges. Create task → proposal (or Ian-native auto). Complete → proposal for Notion, auto for Ian-native. Jamie has no completion endpoint; show as read-only with a link. |
| Commitments | Two tabs: I owe, owed to me. Ageing, chase button, mark done, drop with reason. |
| Alerts | Open, acked, muted. Ack, mute, link to provenance. |
| Ontology | Search; entity pages (Person, Organisation, Project) with timeline of interactions, open commitments, related tasks; `SAME_AS` review queue with merge and dismiss. |
| Policies | Matrix of cells with current decision; click a cell for its rule history and evidence; rule editor with validation (hard floors shown as locked); shadow run form with diff output. |
| Ledger | Filter by kind, actor, system, date; follow a correlation id end to end; export range. |
| Agents | Each agent and watcher: last run, age, cursor, breaker state, error tail, cost today and 7 days, token chart. Global cost chart. |
| Settings | Quiet hours, push budget, mode (live, dry run), retention windows, kill switch with reason, connector health, re-authorise buttons. |

Accessibility to WCAG 2.2 AA. Keyboard-complete proposal handling.

---

## 13. Observability and cost

- OpenTelemetry SDK in all three apps. Traces to Application Insights. Correlation id and proposal id as span attributes everywhere.
- Every model call records model, input, output and cache tokens, latency, and estimated cost from a price table in config. Aggregated in `agent_runs` and surfaced in the Agents page and the weekly review.
- Prompt caching for stable system prompts and the ontology summary. Target cache hit rate above 60% on triage; report it.
- Structured logs (pino) with no raw mail or transcript content at `info` level. Content only at `debug`, off in production.
- Budget guard: a daily spend ceiling (default £15). Crossing 80% raises P1; crossing 100% pauses model-backed agents (watchers continue) and raises P0.

---

## 14. Testing

- `packages/policy`: 100% branch coverage; property-based tests that no rule combination lifts a hard floor; specificity ordering tests.
- `packages/ledger`: immutability tests against a real Postgres in CI (testcontainers); idempotency tests.
- `packages/ontology`: rebuild-from-ledger test; entity resolution golden set (50 person records across sources, expected merges and non-merges).
- `packages/connectors`: fixture tests; contract tests against live systems behind a flag.
- Agents: eval set of 100 emails and 20 transcripts (anonymised, stored in a private fixtures repo) with expected commitments, tasks and importance bands; run nightly; regression threshold on F1 per extraction type.
- Replay harness: `pnpm replay --from --to --mode dry_run` reruns watchers from stored raw observations through triage and policy, producing a report. Used before enabling any new `auto` rule.
- Playwright e2e: sign in, approve a proposal, see it execute against a mocked connector, see the ledger trail.
- Kill switch drill: an integration test that pauses mid-execution and asserts no write occurs after the flag flips.

---

## 15. Phases and acceptance criteria

**Phase 0. Foundations.** Monorepo, Bicep, Postgres with AGE and pgvector, Drizzle schema, ledger with immutability, policy engine with seed rules and hard floors, pg-boss scheduler, Entra sign-in to a blank web shell, Slack app with `/ian status`, OTel wired. Accept when: CI green; ledger UPDATE and DELETE fail in test; policy tests at 100%; `/ian status` answers from production.

**Phase 1. Mail and calendar, dry run then live.** `graph-mail` and `graph-calendar` watchers, triage, proposal cards in Slack, executor for `apply_category`, `move_mail`, `draft_email`, `create_calendar_hold`, critic on drafts. Five working days dry run. Accept when: zero duplicate observations across a full re-poll; every proposal in Slack resolves to a ledger trail in the UI Ledger page; Dom has approved at least 20 proposals live; inbox agent's Slack posting is retired in favour of Ian.

**Phase 2. Jamie and Notion, commitments, debrief.** Both watchers, task aggregation, commitment extraction from transcripts and sent mail, debrief flow, Tasks and Commitments pages. Accept when: eval F1 for commitment extraction above 0.8 on the golden set; a real meeting produces a debrief card with at least one approved Notion task within one hour of transcript arrival.

**Phase 3. Briefs and alerts.** Morning brief, afternoon board, meeting prep, agent-logs watcher with all three streams, alert kinds in section 11, interruption budget, Today and Alerts pages. Accept when: five consecutive weekday briefs delivered by 06:35 with no missing meeting; stale watermark in the inbox agent's channel raises an alert in test; push budget test passes.

**Phase 4. Ontology and autonomy.** Ontology page, `SAME_AS` review, Policies page, shadow mode, promotion analyser, demotion path, executed cards with undo. Accept when: shadow run on 14 days of ledger produces a diff report; a synthetic run of 10 approvals creates a `rule_change` proposal; one reject on an auto cell demotes and alerts.

**Phase 5. Hardening.** Retention jobs, data map, LIA, evidence export, secret rotation runbook and drill, cost guard, kill switch drill in CI, accessibility audit, load test of watchers at 10× volume. Accept when: all runbooks executed once for real and recorded in the ledger.

**v2 candidates.** HubSpot watcher and deal signals; Val identity on the same substrate; Teams surface; Foundry-hosted Claude endpoint; Neo4j if AGE limits are hit.

---

## 16. Open questions and defaults

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | Jamie access: REST API with token, or its MCP server? Does it offer webhooks for transcript-ready? | Poll every 15 min via whichever the connector team can authenticate first; MCP through the SDK's MCP client if REST is unavailable. |
| Q2 | Which agents beyond Ian and the inbox agent should the agent-logs watcher cover in v1? | Only those two plus the webhook. Client-project agents are v2. |
| Q3 | Retention windows (section 4.4). | As stated. |
| Q4 | Anthropic direct or Foundry-hosted Claude? | Anthropic direct. Base URL configurable. |
| Q5 | Apache AGE or Neo4j? | AGE, behind the repository interface. Revisit if p95 of the meeting-prep query exceeds 500 ms at 10k nodes. |
| Q6 | New Slack channel or reuse `dom-claude-agent`? | Reuse, bot user posts. Migrate the inbox agent by end of Phase 1. |
| Q7 | Notion databases beyond All Tasks and Meetings? | None in v1. Add via config. |

---

## 17. Repository layout and conventions

```
ian/
  apps/
    web/            Next.js
    api/            Fastify + tRPC, Slack endpoints, webhooks
    worker/         scheduler, watchers, agents, executor
  packages/
    shared/         types, Zod schemas, config loader
    ledger/
    policy/
    ontology/       AGE repository, entity resolution
    connectors/     graph, jamie, notion, slack
    agents/         SDK agent definitions, prompts, tools
  infra/            Bicep, parameter files per environment
  docs/
    adr/
    runbooks/       entra-setup, rotate-secrets, kill-switch, restore
    compliance/     data-map, lia, retention
    voice/          writing-style hard rules for drafts
  fixtures/         connector recordings, eval sets (private submodule)
  CLAUDE.md
```

Conventions: strict TypeScript; ESLint with import-boundary rules (connector writes only from executor; no model SDK import outside `packages/agents`); Zod at every boundary; forward-only migrations; feature flags via `packages/shared/config`; all times stored UTC, displayed Europe/London; no `any`; tests beside source; British English in copy, comments and docs; no em dashes anywhere.
