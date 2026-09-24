# Lance data map

For Valliance's Data Protection Officer and ISO 27001 auditor. Written 24 September 2026, at package 5.6 of Phase 5, and kept current with every change that adds a table, a graph label or a secret.

## What Lance is

Lance is an internal assistant for Valliance staff. For each colleague who signs up (a "principal"), it reads their Microsoft 365 mailbox and calendar, their Jamie meeting transcripts and the shared Notion task list, and suggests actions (a reply draft, a task, a reminder) in their own private Slack channel. It acts only on what the colleague approves, and never sends email. Everything it reads and does is recorded in an append-only ledger.

## Whose data

- **Principals**: the Valliance colleagues who use Lance.
- **Third parties**: everyone who appears in a principal's mail, calendar and meetings: other colleagues, clients, suppliers, candidates. They have not signed up to Lance. The legitimate interests assessment ([lia.md](lia.md)) covers them.

## Lawful basis

Legitimate interests (UK GDPR Article 6(1)(f)) for everything below, on the assessment in [lia.md](lia.md). No special category data is sought; some will appear incidentally in mail and meetings (health, for example), and Lance has no feature that looks for it.

> **DPO decision needed:** confirm legitimate interests as the basis for principals' own data as well as third parties', or name another (for example the employment contract) for principals.

## How data is kept apart

- **Row-level security** (ADR 0015). Every table below marked "per principal" is filtered by Postgres to the principal a session acts for. A query that forgets its scope returns nothing.
- **Graph layers** (ADR 0017, ADR 0033). The knowledge graph has three layers: `private` (one principal's evidence, visible to them alone), `shared` (facts the organisation has learned, visible to every principal) and `reference` (keys for facts held in Foundry, from Phase 7).
- **Admins see health, never content** (ADR 0024). A Lance admin sees statuses, counts, ages and costs, and no principal's mail, meetings, drafts or briefs.

## Relational tables (Postgres, Azure UK South)

"Per principal" means the table has a `principal_id` under forced row-level security. Retention is in [retention.md](retention.md); "ledger window" means payloads are nulled at two years and the row kept.

| Table | Personal data held | Whose | Source | Purpose | Retention |
|---|---|---|---|---|---|
| `principals` | Name as UPN (email), Entra object id, Slack user id, Notion user id, Slack channel id, time zone, status, Lance roles | Principals | Entra sign-in, Slack link, Notion users list | Knowing who Lance works for and where to reach them | While the principal exists; the row stays after offboarding with status `offboarded` |
| `principal_state` (per principal) | Pause reason text, quiet hours, push budget, cost ceiling | Principals | The principal, in Settings | Their own run state | As `principals` |
| `users` | UPN, Slack user id, Notion user id, time zone of the first principal | Dom | Phase 0 set-up | Superseded by `principals`; nothing writes it | **DPO decision needed:** keep for history or clear |
| `slack_links` | Slack user and team id bound to a principal, when linked and revoked | Principals | `/lance login` | Proving which Slack user acts for which principal (ADR 0021) | Kept, revoked at offboarding |
| `slack_link_tokens` | Slack user and team id behind a login link | Principals | `/lance login` | Single-use link nonce | Five minutes, then pruned |
| `slack_request_nonces` | Signature of a Slack request (no personal data) | None | Slack | Replay protection | Ten minutes, then pruned |
| `system_state` | Global pause reason and who paused | Admins | Admins | Organisation kill switch | Current value only |
| `jobs` (per principal) | Which jobs a principal turned off, schedule overrides | Principals | The principal | Their job settings | As `principals` |
| `ledger_events` (per principal) | Everything Lance observed and did. `observed` payloads hold mail (sender, recipients, subject, body), calendar entries, meeting transcripts and summaries, Notion tasks, agent log lines. `resolved` payloads hold triage results (summaries, entities, commitments with evidence quotes). `proposed`, `decided`, `executed` hold draft text and decisions | Principals and third parties | Graph, Jamie, Notion, Slack, Lance itself | Audit trail: nothing Lance reads or does goes unrecorded (non-negotiable 1) | Mail bodies 90 days, transcripts 180, triage quotes at their source's window, model logs 30, everything else the ledger window. Rows are never deleted; the hash survives |
| `observations` (per principal) | A copy of each `observed` payload | As above | As above | Query convenience | Nulled with its ledger row |
| `proposals` (per principal) | The exact write proposed (a draft email's recipients and text, a task title), a preview, the rationale, provenance links | Principals and third parties | Planner and triage agents | Asking the principal to approve an action | **DPO decision needed:** no window yet; rows are kept |
| `policy_rules` | Who created a rule; rule conditions may name a counterparty class, never a person | Principals, admins | Principals and admins | What Lance may do without asking | Kept while the rule applies; superseded rules kept for audit |
| `policy_decisions` (per principal) | The inputs of each policy evaluation: action class, counterparty class, system, target id | Principals and third parties (by id) | Policy engine | Why an action was allowed, proposed or refused | **DPO decision needed:** no window yet |
| `cursors` (per principal) | Delta tokens and page cursors (no personal data) | None | Watchers | Resuming a read where it stopped | Current value only |
| `alerts` (per principal) | Alert title and body, which can name a counterparty and quote a subject line | Principals and third parties | Detectors | Telling the principal something needs attention | **DPO decision needed:** no window yet |
| `commitments` (per principal) | Who owes whom what, by when, with an evidence quote from the mail or transcript | Principals and third parties | Commitment extraction from mail and transcripts | Tracking promises made and owed | **DPO decision needed:** the evidence quote outlives its source; see [retention.md](retention.md) |
| `briefs` (per principal) | Morning briefs, boards, meeting preps, debriefs, weekly reviews: summaries naming people and meetings | Principals and third parties | Planner agent | The principal's daily briefings | **DPO decision needed:** no window yet |
| `agent_runs` (per principal) | Model, token counts, cost, and an error message that can quote model output | Principals | Every model call | Cost accounting | Error text nulled at 30 days; the row kept |
| `pgboss.*` | Job payloads naming a principal and a record id (no content) | Principals (by id) | The apps | Work queue | pg-boss deletes completed jobs after its default of 7 days |

## Knowledge graph (Apache AGE, graph `lance_ontology`)

Every node and edge carries a `layer` and, when private, the `principal_id` it belongs to. Nothing in the graph is readable except through `OntologyRepository`, which applies the layer rules.

| Label | Kind | Layer | Personal data held | Source |
|---|---|---|---|---|
| `Person` | Node | Shared, or private when seen with no exact key (ADR 0033) | Name, email address, Slack, Notion and Jamie ids | Mail headers, calendar attendees, transcripts, Notion |
| `Organisation` | Node | Shared | Company name and email domain | Mail and calendar |
| `Meeting` | Node | Shared | Title, start, end, organiser (no transcript) | Calendar, Jamie |
| `Project` | Node | Shared | Project name (Phase 7) | Foundry |
| `Task` | Node | Shared for Notion tasks, private for Jamie tasks | Title, assignee, due date | Notion, Jamie |
| `Thread` | Node | Private | Mail conversation subject and participants | Mail |
| `Commitment` | Node | Private | Description of a promise and who it is between | Mail, transcripts |
| `Document` | Node | Private | Document title and link | Mail, meetings |
| `Agent` | Node | Private | An agent's name (no personal data) | Agent logs |
| `ATTENDED`, `PARTICIPATED_IN`, `MENTIONS`, `OBSERVED` | Edges | Private | That a principal's sources showed a person at a meeting or in a thread, with the record id | Mail, calendar, Jamie |
| `OWES`, `OWED_TO`, `ASSIGNED_TO`, `DERIVED_FROM`, `ABOUT` | Edges | Private | Who owes a commitment, who a task is for, what it came from | Extraction |
| `WORKS_AT`, `ORGANISED`, `RELATES_TO`, `SAME_AS` | Edges | Shared | Who works where, who organised a meeting, which records are the same person | Exact-key resolution |

The shared layer means a person's name and email seen in one principal's mailbox become visible to other principals, with no record of whose mailbox or which message showed them (ADR 0033). The graph is kept indefinitely (spec Q3).

> **DPO decision needed:** confirm that shared Person and Organisation nodes may be kept indefinitely, and whether an offboarded principal's private graph evidence is removed (today it is kept, visible to nobody).

## Key Vault secrets

Two vaults in Azure UK South, both with purge protection and a 90-day soft-delete period (ADR 0022).

**Static vault** `kv-lance-<env>-<suffix>`, from [infra/secrets.json](../../infra/secrets.json). None holds personal data except as noted.

| Secret | What it is | Read by |
|---|---|---|
| `entra-tenant-id`, `entra-client-id`, `entra-client-secret` | The Lance app registration | web, api, worker |
| `auth-secret` | Web session encryption key | web |
| `slack-bot-token`, `slack-signing-secret` | The Lance Slack app | api, worker; api |
| `agent-log-ingest-secret` | Shared secret for the agent-log webhook | api |
| `evidence-signing-key` | Key that signs the ISO 27001 evidence export | api |
| `anthropic-api-key` | Model provider key | worker |
| `notion-token` | The organisation's Notion integration, shared with All Tasks only | worker |
| `jamie-api-key`, `graph-refresh-token` | Dom's credentials from before ADR 0022; personal to Dom; removed by a follow-up | worker |

**Principal vault** `kv-lance-p-<env>-<suffix>`: one secret per principal and connector, named with the principal's id. Each is a credential that acts as that principal.

| Secret | What it is | Written by | Read by |
|---|---|---|---|
| `graph-refresh-token--<principalId>` | Microsoft 365 refresh token (mail and calendar) | api at consent, worker at rotation | worker |
| `jamie-api-key--<principalId>` | Jamie API key | api at onboarding | worker |
| `foundry-refresh-token--<principalId>` | Foundry token (Phase 7; not written yet) | | |

Deleted at offboarding, then soft-deleted for 90 days.

## Outside Lance's own stores

| Where | What goes there | Retention | Notes |
|---|---|---|---|
| Anthropic API (model provider) | Mail headers and bodies for triage; meeting transcripts for debriefs and meeting preparation; graph summaries for briefs | Anthropic's API retention for the Valliance organisation | **DPO decision needed:** confirm the processor terms and retention with Anthropic, and record whether zero data retention applies |
| Slack (Valliance workspace) | Proposal cards (with draft previews), alerts and briefs in each principal's private channel | Valliance's Slack retention settings | Archived at offboarding, not deleted |
| Notion (All Tasks database) | Tasks Lance creates on a principal's approval, assigned to them | Valliance's Notion settings | The organisation's records |
| Microsoft 365 | Drafts and holds Lance creates on approval, in the principal's own mailbox | The principal's mailbox | Lance never sends mail |
| Application Insights and Log Analytics | Traces and structured logs; no mail or transcript content at `info` level (spec 13) | 30 days (`infra/modules/monitoring.bicep`) | |
| Postgres backups | Everything in the database | 35 days (`infra/modules/postgres.bicep`) | Nulled payloads remain in backups until the backups age out |
| Entra ID | Membership of `Lance Users` and `Lance Admins` | Entra | The access list ([iso27001-access-review.md](iso27001-access-review.md)) |
