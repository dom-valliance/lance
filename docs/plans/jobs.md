# Jobs plan: managing Lance's jobs and defining new ones

Date: 2026-09-23
For: Claude Code in the `lance` repository, alongside `docs/plans/ontology.md` and `docs/plans/multi-user.md`
Suggested home in the repo: `docs/plans/jobs.md`

---

## 0. What this plan adds, and when

Two capabilities:

1. **Job management.** Every scheduled thing Lance does (watchers, briefs, detectors, the digest, retention, the Foundry sync) appears in one registry. From the web app and Slack a principal can see it, pause it, run it now, change its schedule within limits, and read its run history.
2. **User-defined jobs.** A principal describes a job in plain words, attaches context and reference files, and Lance drafts a structured definition, modelled on a Claude skill. The principal previews one run, then activates it. From then on it runs inside normal Lance operation: same ledger, same policy engine, same approvals, same budgets, same kill switch. Jobs can be imported from Dom's Cowork skills and scheduled tasks.

Decisions Dom made on 23 September, which this plan follows:

- A job produces output (a report or brief in the web app and Slack) and may raise proposals. Proposals go through the policy engine exactly as triage's do. There is no new write path.
- A job reads Lance's own data, Foundry reference data, files attached to the job, and systems reached through MCP connections the principal configures.
- Jobs trigger on a schedule, on demand, and on events Lance already observes.
- Authoring is describe-then-draft, with import from Cowork as a starting point.

This is a third track, called J here, with work packages J1 to J8. It depends on Phase 4 WP4.1 (the principal seam), because jobs belong to principals. J1 to J5 can run beside the rest of Phase 4 and the multi-user track. J6 (MCP connections) carries the most risk and lands last, behind a feature flag.

The 22 September session asked for a federated jobs backlog: framework capabilities separate from individual jobs, with the wider team contributing jobs, prompts and connectors once the framework is defined. This plan is that separation in code. The framework is the job runtime; the backlog is job definitions.

Read `CLAUDE.md`, the spec, the phase log, the other two plans and this file before writing code. Write ADRs 0025 to 0030 (section 3) before the first migration. Record evidence against section 10 in a "Jobs track" section of `docs/adr/0000-phase-log.md`.

---

## 1. Where the code is today

- Schedules are hard-coded. `boss.schedule` is called in `apps/worker/src/main.ts` (expiry every 15 minutes, dry-run digest 17:00 weekdays, alert delivery every minute), `briefs/run.ts` (morning 06:30, board 16:00, meeting prep every 5 minutes 07:00 to 19:00), `briefs/weekly.ts`, `alerts/engine/run.ts` (one schedule per detector) and `watchers/runner.ts` (one per watcher).
- Nothing records which jobs exist except the code that schedules them. The Agents page shows watchers, agents, breakers and cost, read from runs after the fact.
- Model agents are built with `defineAgent` in `packages/agents` on the Anthropic SDK tool runner (ADR 0001). The only write tool a model holds is `create_proposal` (non-negotiable 2).
- There is no MCP client in the repository. `ACTION_CLASSES` and `SYSTEMS` in `packages/shared/src/enums.ts` are closed enums.
- Dom's Cowork already runs the kind of jobs this plan wants inside Lance: the morning brief, a weekly Valliance technology update, personal wins, a deliberately harsh weekly feedback report, one-to-one preparation, the Valliance themes scan, inbox triage and Jamie tagging. Those are the first import candidates.

---

## 2. The job definition

### 2.1 Shape

A job is a folder, the same shape as a Claude skill:

```
<job-slug>/
  JOB.md            frontmatter settings plus markdown instructions
  references/       attached files, converted to text at upload
  cases/            optional example runs used as evals
```

The folder is stored in Postgres, not on disk (section 4). Import and export use this layout so a job can move between Lance, Cowork and a git repository unchanged.

### 2.2 `JOB.md` frontmatter

```yaml
name: One-to-one preparation
slug: one-to-one-prep
description: Before each one-to-one, brief me on the person, what we agreed last time, what is open between us, and two things to raise.
version: 3                      # set by Lance, never by the author
triggers:
  - kind: event
    event: meeting.starting
    filter:
      title_matches: "(?i)\\b(1:1|121|one[- ]to[- ]one)\\b|/ Dom"
      attendee_count_max: 2
    lead_time: 30m
  - kind: manual
inputs:
  - source: meeting            # the triggering meeting
  - source: person_timeline    # the other attendee, last 90 days
    window: 90d
  - source: commitments        # open, both directions, with that person
  - source: tasks              # Notion tasks assigned to or involving that person
  - source: foundry.employee   # role, coach, projects they are staffed on
references:
  - references/feedback-principles.md
tools:
  lance: [search_ontology, get_source_record, list_meetings]
  mcp: []                      # section 2.5
output:
  kind: brief                  # brief | report | digest
  deliver: [web, slack_thread] # slack_thread posts under the principal's channel, within the push budget
  voice: principal             # principal | valliance_default
proposals:
  allowed: [create_task, draft_email]
model: standard                # fast | standard | deep, mapped to model ids in config (ADR 0002)
budget:
  per_run_gbp: 0.40
  per_day_gbp: 2.00
limits:
  max_iterations: 12
  max_runs_per_day: 8
respect_quiet_hours: true
```

Every field is validated by a Zod schema in `packages/shared/src/jobs.ts`. Unknown fields are rejected, so a typo cannot silently change behaviour.

### 2.3 `JOB.md` body

Plain markdown the author writes, in sections the drafting step always produces so jobs read alike:

- **Purpose.** One paragraph: what the job is for and who reads its output.
- **Context.** What the author knows that Lance does not: who matters, what "good" looks like, standing preferences.
- **Steps.** The order of work, in plain instructions.
- **Output.** The sections the result must have, with an example.
- **Quality bar.** Checks the critic applies before the output is delivered ("every claim about the person cites a meeting or an email").
- **Never.** Things the job must not do ("never raise performance concerns in a proposal").

### 2.4 Inputs, gathered by code first

Inputs are declarative. Before the model is called, deterministic code gathers each declared input for the principal's scope and puts it in the prompt with provenance ids. The model can then explore further with the read tools the job lists. Gathering first keeps runs cheap, repeatable and provenance-complete; the model is not left to search for what the job obviously needs.

Input sources in J2: `meeting`, `meetings` (window, tag, project, organisation filters), `person_timeline`, `organisation_timeline`, `project_timeline`, `commitments`, `tasks`, `mail_threads` (window, participant or organisation filters; bodies stripped unless the job declares `include_bodies` and the principal confirms it at activation), `briefs` (previous outputs of this or another job), `foundry.employee`, `foundry.project`, `job_runs` (this job's own earlier outputs, so a weekly report can compare with last week).

### 2.5 MCP tools

A job lists MCP tools by connection and name, for example `mcp: [{ connection: hubspot, tools: [search_crm_objects, get_crm_objects] }]`. Only tools the principal has classified as `read` on that connection (section 5) may appear here. Write tools never reach the model; a job that wants a write raises a proposal of class `mcp_write` naming the tool and arguments, and the executor makes the call after approval.

### 2.6 Cases

Optional files in `cases/`, each an input snapshot (fixture ids or a frozen gather) and a short rubric. The preview step runs the job on every case and the critic scores the output against the rubric. A job with cases shows its scores on the job page; a new version that scores lower than the last is flagged before activation. This is the "eval muscle" the 22 September session said the team lacks, applied per job.

---

## 3. ADRs to write first

**0025. Jobs are a registry, and schedules live in the database.** Code declares system jobs with defaults; the `jobs` table holds each principal's enabled flag, schedule override and state; a reconciler turns the table into pg-boss schedules keyed per principal and job. Every change is a `state_changed` ledger event with the old and new values.

**0026. User jobs are skill-shaped definitions run by one generic job agent.** A job is `JOB.md` plus references and cases, versioned immutably. One agent, `job-runner`, built with `defineAgent`, runs any job: a fixed harness system prompt (cached) plus the job's instructions (cached per version) plus the run's gathered inputs. Jobs cannot bring code; there is no code execution in this track.

**0027. Jobs hold no write power of their own.** A job's output is delivered by Lance's own surfaces. A job's side effects are proposals, limited to the classes its definition lists and evaluated by the policy engine like any other. Hard floors are unchanged. A job whose definition lists a new proposal class, a new MCP connection or mail bodies must be re-confirmed by the principal before the new version activates.

**0028. Event triggers are filters over the ledger.** An event trigger names an event type and a declarative filter. The matcher is deterministic code that reads `observed` and `resolved` events after triage and ontology resolution, so filters can use organisation type, project and tag. No model decides whether a job fires.

**0029. MCP connections go through Lance's own client.** Lance uses the MCP TypeScript SDK over Streamable HTTP to servers the principal registers. It does not use the Anthropic API's MCP connector, because that executes tool calls outside Lance, so they would miss the ledger and the write boundary. Each tool is classified read, write or forbidden by the principal; the classification is pinned to a hash of the tool's name, description and input schema, and any change to the hash disables the tool until the principal classifies it again.

**0030. Jobs are personal; a library shares them.** A job belongs to one principal and runs in their scope. A principal can publish a job version to the organisation library, which an admin approves (the `promote_to_shared` pattern from Phase 4). Installing a library job copies it into the installer's own jobs; it never runs in anyone else's scope.

---

## 4. Data model

All tables carry `principal_id` under forced row-level security (Phase 4 WP4.1), except where noted.

| Table | Purpose | Key columns |
|---|---|---|
| `jobs` | One row per job per principal, system or user | `id`, `principal_id`, `slug`, `origin` (`system`, `user`, `library`, `import`), `status` (`draft`, `preview`, `active`, `paused`, `retired`), `current_version_id`, `enabled`, `schedule_override`, `locked` (true for jobs a principal may not disable) |
| `job_versions` | Immutable definitions | `id`, `job_id`, `version`, `job_md`, `settings` (parsed frontmatter), `content_hash`, `created_by`, `created_at`, `confirmed_at` |
| `job_references` | Attached files as text | `version_id`, `name`, `media_type`, `text`, `sha256`, `bytes` |
| `job_cases` | Eval cases | `version_id`, `name`, `inputs` (jsonb), `rubric` |
| `job_triggers` | One row per trigger, derived from the version | `version_id`, `kind` (`schedule`, `event`, `manual`), `spec` (jsonb) |
| `job_runs` | One row per run | `id`, `job_id`, `version_id`, `trigger`, `trigger_event_id`, `status` (`queued`, `running`, `succeeded`, `failed`, `skipped`, `held`), `output` (jsonb), `agent_run_id`, `correlation_id`, `cost_gbp`, `started_at`, `finished_at` |
| `job_library` | Organisation library, `principal_id` null | `id`, `source_version_id`, `published_by`, `approved_by`, `status` |
| `mcp_connections` | Registered servers | `id`, `principal_id` (null for an organisation connection), `name`, `url`, `auth_kind` (`oauth`, `bearer`, `none`), `secret_name`, `status` |
| `mcp_tools` | Discovered tools and their classification | `connection_id`, `name`, `definition_hash`, `classification` (`read`, `write`, `forbidden`, `unclassified`), `annotations` (the server's hints), `classified_by`, `classified_at` |

Limits: references up to 200 KB of text each and 1 MB per job; PDF and Word files are converted to text at upload and the original is not kept. Ledger events use the existing kinds: `state_changed` for definitions, versions, activation and pausing; `observed` for MCP reads; `proposed`, `decided` and `executed` for proposals as today. A `job_run_id` in the payload ties them together. No new ledger kinds.

---

## 5. MCP connections (J6)

- **Registering.** Settings gains a Connections page. The principal enters a name and a server URL. Lance connects, runs the OAuth flow if the server asks for one (tokens in Key Vault as `mcp-<connectionId>--<principalId>`), and lists the tools.
- **Classifying.** Each tool starts `unclassified` and cannot be used. The principal marks it `read`, `write` or `forbidden`. The server's own annotations (`readOnlyHint`, `destructiveHint`) are shown as hints and preset the choice; a tool the server marks destructive can only be `forbidden`. Nothing is inferred from the tool's name.
- **Reading.** A `read` tool listed in a job's `tools.mcp` is exposed to the job's model. Every call is an `observed` ledger event with the connection, tool, argument hash and result hash. Results are untrusted data: the harness prompt says so, and the critic checks that no proposal's target came only from MCP output without the principal's own data behind it.
- **Writing.** A `write` tool is never exposed to a model. It becomes available as proposal class `mcp_write`, with `system` set to `mcp:<connection>`. Policy seeds `mcp_write` at `propose` for every connection. It can be promoted to `auto` per cell like any other class, except where the principal classified the tool with a destructive hint present, which is a hard floor at `forbid`.
- **Drift.** On every connect, Lance recomputes each tool's definition hash. A changed hash sets the tool back to `unclassified`, pauses every job that lists it, and raises a P1 alert. This stops a server changing what a tool does after the principal approved it.
- **Enum changes.** `SYSTEMS` in `packages/shared` gains a pattern for `mcp:<slug>`; the policy engine treats an unknown system as `propose`. `packages/policy` keeps 100% branch coverage.
- **Network.** Servers must be HTTPS. An organisation allowlist of hosts lives in config; a server outside it cannot be registered. Container Apps egress rules follow the allowlist.
- **Feature flag.** `FF_MCP_CONNECTIONS`, default off until J6's acceptance criteria pass.

---

## 6. How a run works

1. **Trigger.** The scheduler (schedule), the api (Run now, `/lance run <slug>`) or the event matcher (event) enqueues a `job-run` job with the principal, job, version and trigger event.
2. **Gates.** The worker checks, in order: the global and principal kill switch, the job's `enabled` flag and status, quiet hours if the job respects them, `max_runs_per_day`, and the job's and principal's budgets. A failed gate records a `skipped` run with the reason.
3. **Gather.** Code gathers the declared inputs inside `withPrincipal` and records what it read.
4. **Run.** `job-runner` runs with the harness prompt, the job's instructions and references, the gathered inputs, the job's read tools and `create_proposal` restricted to the job's allowed classes. Output is structured: title, summary, sections with provenance, and follow-ups. A schema failure retries once, as for every agent.
5. **Critic.** The critic checks the output against the job's quality bar, the principal's voice profile and the style hard rules, and checks every proposal as today. A failed output is stored and shown on the job page, not delivered.
6. **Deliver.** The output goes to the job page and the Today feed, and to Slack as a thread in the principal's channel when the job asks for it and the push budget allows. Proposals follow the normal routes.
7. **Record.** `job_runs` holds the result, cost and correlation id; the Ledger page follows the correlation end to end.

Three failed runs in a row pause the job and raise a P1 alert, the same breaker behaviour watchers have.

---

## 7. Authoring and import (J4, J5)

### 7.1 Describe, draft, preview, activate

1. The principal opens New job and writes what they want in plain words, optionally attaching files.
2. An Opus drafting agent turns it into a complete `JOB.md`: frontmatter chosen from what the description implies, and the six body sections. It asks up to three questions when the description leaves a trigger, an output or a scope open, and states its assumptions otherwise.
3. The principal edits the draft in a split view (settings form on one side, markdown on the other, both editing the same definition).
4. Preview runs the job once against real data in the principal's scope, with proposals held and nothing posted to Slack. The preview shows the output, the proposals it would raise, the inputs it read, and the cost. Cases, if any, run too.
5. Activate confirms the definition, including anything ADR 0027 says needs explicit confirmation, and sets the job to `active`. The first scheduled run after activation posts to Slack only if the preview was accepted.

Editing an active job creates a new version in `draft`; the active version keeps running until the new one is previewed and activated.

### 7.2 Import from Cowork

The import page accepts:

- A Cowork skill folder or its `SKILL.md` (with `references/`). Frontmatter `name` and `description` carry over; the body becomes the job's instructions, reorganised into the six sections by the drafting agent; references attach as files. A `scripts/` folder is listed as not imported, because jobs cannot run code.
- A Cowork scheduled task's prompt and cron expression. The drafting agent converts the prompt into a job and the cron into a schedule trigger in UTC, shown in London time.

For both, the importer maps the connectors the source names to Lance sources: Outlook mail and calendar to `mail_threads` and `meetings`, Jamie to `meetings` and transcripts, Notion to `tasks`, Foundry to `foundry.*`. Anything it cannot map (web search, HubSpot, Miro) is listed as needing an MCP connection or as unavailable. The imported job always starts in `draft` and goes through preview.

First imports to prove the path: one-to-one preparation, the weekly feedback report and the weekly Valliance technology update. The morning brief stays Lance's built-in job; importing Cowork's version would run two briefs.

---

## 8. Pages and Slack (J3, J7)

**Jobs page.**

- Three tabs: Mine, System, Library.
- A row per job: name, trigger summary in plain words ("weekdays at 06:30", "30 minutes before a one-to-one"), status, next run, last run outcome, cost over seven days, an enabled toggle, Run now.
- System jobs marked `locked` (alert delivery, the kill-switch tick, proposal expiry, retention) show their state with no toggle. Their schedules can be changed by an admin only, within bounds set in code.
- Schedule changes for system jobs use presets and bounds (for example, the morning brief between 05:30 and 08:30) instead of free cron, so a principal cannot schedule a watcher every minute.

**Job page.** The definition rendered, the version history with diffs, triggers, inputs, allowed proposals, MCP tools, cases and scores, and runs: each run's output, proposals, cost, and a link to its ledger trail.

**Editor and import.** As section 7.

**Connections page** under Settings. As section 5.

**Slack.** `/lance jobs` lists the principal's jobs with status and next run. `/lance run <slug>` runs one now. `/lance pause <slug>` and `/lance resume <slug>` do what they say. Job output posts as one parent message with the sections in a thread, within the push budget, the same pattern the briefs use.

---

## 9. Work packages

| # | Package | Depends on | Size |
|---|---|---|---|
| J1 | Registry: `jobs` table, system job declarations with defaults and bounds, schedule reconciler, pause and run now, ledger events | Phase 4 WP4.1 | 2 days |
| J2 | Definitions and runtime: `JOB.md` schema, versions, references, input gatherers, `job-runner` agent, harness prompt, output schema, critic hook, delivery, breaker | J1 | 3 days |
| J3 | Jobs page, job page, Slack commands | J1, J2 | 2 days |
| J4 | Authoring: drafting agent, split editor, preview, activation and re-confirmation rules, cases | J2 | 2 to 3 days |
| J5 | Event triggers: event catalogue, filter schema, matcher over the ledger, debounce, lead-time triggers from the calendar | J2 | 2 days |
| J6 | MCP connections: client, Connections page, OAuth, classification, hash pinning, `mcp_write` proposals, allowlist, flag | J2 | 3 days |
| J7 | Import from Cowork and the organisation library | J4 | 2 days |
| J8 | Three imported jobs live for Dom, load and cost check, phase review | all | 1 to 2 days |

J5 and J6 can run in parallel after J2.

### J5 event catalogue

| Event | Fires when | Filter fields |
|---|---|---|
| `meeting.starting` | A calendar event is `lead_time` away | title pattern, attendee count, organisation, organisation type, project, tag |
| `meeting.ended` | A calendar event has ended | as above |
| `transcript.ready` | Jamie has a transcript for a meeting the principal attended | tag, project, organisation, organisation type |
| `mail.received` | Triage has resolved a new inbound message | sender organisation, organisation type, label, importance above a threshold |
| `task.changed` | A Notion task assigned to the principal changes status or due date | status, project |
| `commitment.overdue` | An outbound commitment passes its due date | counterparty organisation |
| `alert.raised` | An alert of a kind is raised | alert kind, severity |
| `job.succeeded` | Another of the principal's jobs finishes | job slug (lets one job feed another) |

Every event trigger has a debounce (default 10 minutes per job and subject) and counts towards `max_runs_per_day`. A `job.succeeded` chain is limited to depth two, so jobs cannot loop.

---

## 10. Acceptance criteria

| Criterion | Evidence expected |
|---|---|
| Every scheduled job is in the registry | The Jobs page lists every schedule that `boss.schedule` registers in dev, with its next run; a test fails if code schedules a job the registry does not declare |
| System jobs are manageable within bounds | Pausing the digest from the UI and from Slack stops it; a schedule outside the declared bounds is refused; locked jobs cannot be disabled |
| A described job becomes a running job | Dom describes a job in plain words; the draft, preview and activation complete; it runs on schedule the next day and its run appears in the ledger trail |
| Cowork imports work | One-to-one preparation, the weekly feedback report and the weekly technology update imported from Cowork, previewed and active for Dom, each run at least once live |
| Event triggers fire on real events | A `transcript.ready` trigger filtered to a Chambers tag runs within ten minutes of the transcript arriving in dev |
| Jobs cannot exceed their grant | Tests: a job cannot raise a proposal class it did not list; a job without `include_bodies` never receives mail bodies; a run over its per-run budget stops and records why |
| MCP writes never reach a model | Test: no `write` or `forbidden` tool appears in any agent's tool list; `mcp_write` proposals execute only through the executor after a decision |
| Tool drift is caught | A fixture server that changes a tool's description sets it back to `unclassified`, pauses the jobs using it, and raises an alert |
| The kill switch stops jobs | The kill switch drill in CI covers `job-run`: no run starts and no proposal from a job executes after the flag flips |
| Failing jobs stop themselves | Three failed runs pause the job and alert |
| Principal isolation holds | A second synthetic principal's jobs, runs, references and connections are invisible to Dom's scope, and the reverse |

---

## 11. Open questions and defaults

| # | Question | Default in force |
|---|---|---|
| Q1 | Web search for jobs like the themes scan | Not built in. It arrives through an MCP connection if the principal registers one, so every read is on the ledger. Anthropic's server-side web search tool stays off |
| Q2 | Organisation MCP connections (one HubSpot connection for everyone) | Allowed with `principal_id` null, registered and classified by an admin; each principal still authenticates with their own account where the server supports it |
| Q3 | Default per-run budget | £0.40 for `standard`, £1.50 for `deep`, £0.10 for `fast`; per-day cap five times the per-run budget |
| Q4 | Can a job write to a Notion page or another Slack channel | Only through a proposal: existing Notion classes, or `mcp_write` against a Notion or Slack MCP connection |
| Q5 | Who approves library entries | Any `Lance.Admin` (multi-user plan, ADR 0020); Dom in v1 |
| Q6 | Maximum active jobs per principal | 20, in config |

---

## 12. Risks

- **Prompt injection through jobs.** A job's own instructions are trusted, because the principal wrote them, but its inputs are not: mail, transcripts and MCP results can carry instructions. The harness prompt marks gathered content as data, proposals stay limited to declared classes, and the critic checks targets against the principal's own data. The worst case is a bad proposal the principal declines, which is the design.
- **Cost creep.** Many small jobs add up. Per-run and per-day budgets, the principal's daily ceiling and the Agents page cost view cover it. The Phase 3 backfill incident is the reason budgets are checked before the run, not after.
- **Duplicate work with built-in jobs.** An imported morning brief would duplicate Lance's own. The importer warns when a job's triggers and outputs overlap a system job.
- **MCP servers as a supply-chain risk.** A server can change behind the principal's back. Hash pinning, the host allowlist, the write boundary and the `forbid` floor on destructive tools contain it; J6 ships behind a flag and its phase review looks at nothing else.
- **Scope creep into a workflow engine.** Jobs are one agent run with gathered inputs and proposals. Multi-step orchestration, branching and human-in-the-loop steps inside a run are out of scope; chaining through `job.succeeded` at depth two is the ceiling.
