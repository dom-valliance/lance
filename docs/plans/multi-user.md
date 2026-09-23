# Multi-user plan: from one principal to the Lance Users group

Date: 2026-09-23
For: Claude Code in the `lance` repository, alongside `docs/plans/ontology.md`
Source design: frame 8, "Multi-user modification", on the Lance architecture board in Miro, and the Cowork conversation of 21 September behind it
Suggested home in the repo: `docs/plans/multi-user.md`

---

## 0. How this plan relates to Phase 4

The Phase 4 plan builds the seam: `principals`, `principal_id` on every table, forced row-level security, `withPrincipal`, principal propagation through api, worker and agents, the reference, shared and private ontology layers, and the policy tiers. That is WP4.1, WP4.3 and WP4.6 there. This plan does not repeat them.

This plan builds everything that turns the seam into a product a colleague can sign in to: identity and roles, onboarding, connector credentials per principal, Slack account linking and private channels, fan-out, budgets, the admin view, offboarding, and the compliance work. It is a separate track, called M here, with work packages M1 to M8.

Order:

1. Phase 4 WP4.1 merges first. Nothing in this plan starts before it.
2. M1 to M7 can run beside the rest of Phase 4.
3. M8, the first real second principal in dev, waits for two things: Phase 4 acceptance, and the framework workshop Tarek and Dom are running in the week of 6 October. The workshop is where the team agrees what multiplayer looks like; the 22 September session said design must come before the backlog is federated. If the workshop changes the model, amend this plan before M8.

Read `CLAUDE.md`, the spec, the phase log, the Phase 4 plan and this file before writing code. Write ADRs 0020 to 0024 (section 3) before the first migration of this track. Record evidence against section 8 in a new "Multi-user track" section of `docs/adr/0000-phase-log.md`.

---

## 1. Where the code is today

Read from the tree at `ea60797`:

| Area | Today | File |
|---|---|---|
| Web sign-in | Auth.js with Entra; one UPN from `ALLOWED_UPN` | `apps/web/src/auth.ts` |
| api bearer check | The token's UPN must equal `allowedUpn` | `apps/api/src/auth/entra.ts` |
| Slack commands and buttons | `mayControl` and `mayDecide` compare the signed `user_id` with `users.slack_user_id`; an unset id refuses everyone | `apps/api/src/slack/routes.ts`, `interactions.ts` |
| Slack replay protection | Five-minute timestamp window, no nonce store (deferred in the Phase 0 review) | `apps/api/src/slack/verify.ts` |
| Graph credentials | One refresh token in Key Vault secret `graph-refresh-token`, rotated on every use; Settings has a Connect Microsoft 365 button | `packages/connectors/src/graph/tokenStore.ts`, `apps/web/src/app/api/graph/connect` |
| Jamie credentials | One API key, `JAMIE_API_KEY` | `apps/worker/src/main.ts` |
| Notion credentials | One internal integration token, `NOTION_TOKEN`, from the integration "Dom's Lance", shared with All Tasks | `apps/worker/src/main.ts` |
| Slack bot | One bot token; one channel from config, `C0BU7P278N5`; bot scopes `chat:write`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `reactions:read`, `reactions:write`, `commands`, `users:read` | `docs/runbooks/slack-app-manifest.json` |
| Who Lance works for | `config.dom` (name, email) and `config.notion.domUserId` | `packages/shared/src/config.ts` |
| Run state | `system_state`, a single row enforced by a CHECK on `id = 1` | `packages/db/src/schema/system-state.ts` |
| Drafting voice | `docs/voice/writing-style.md`, Dom's style | `docs/voice/` |
| Key Vault access | Role assignments are vault-wide, so the web identity can read worker secrets (deferred to Phase 5; must land before `live`) | `infra/` |

Three of these are safe only while there is one person: the vault-wide Key Vault access, the missing Slack nonce store, and drafting every email in Dom's voice. Each becomes a defect the day a second principal exists. M2, M4 and M6 fix them.

---

## 2. Target shape

```
Entra ID
  enterprise app "Lance (Valliance)", assignment required
  app roles: Lance.User, Lance.Admin   <- assigned to groups "Lance Users", "Lance Admins"
        |
        | id token: oid, upn, roles
        v
web (Auth.js) ------ api ------------------------- worker
  sign-in gate         principal from oid              scheduler: one job per
  onboarding           or from linked Slack user       (principal, watcher, partition)
  admin page           withPrincipal on every call     withPrincipal per job
        |                    |                               |
        |                    v                               v
        |              Postgres (RLS on principal_id)  Key Vault
        |              principals, principal_state,    secrets named per principal:
        |              slack_links, ...                graph-refresh-token--<id>
        |                                              jamie-api-key--<id>
        v                                              foundry-refresh-token--<id>
Slack: one bot, one private channel per principal, /lance login binds Slack user to oid
```

---

## 3. ADRs to write first

**0020. Access is granted by Entra app roles.** The Lance enterprise application requires assignment. Two app roles, `Lance.User` and `Lance.Admin`, are assigned to the security groups `Lance Users` and `Lance Admins`. The `roles` claim in the id token gates sign-in and admin actions. App roles avoid the groups-claim overage that affects users in many groups, and they keep the access list in Entra, where the ISO 27001 access review already looks. `ALLOWED_UPN` is retired.

**0021. Slack identity is bound to Entra once, by the user.** `/lance login` issues a signed, single-use link bound to the Slack user id, team id and a five-minute expiry. The user follows it, signs in with Entra, and the callback records the binding. Lance never binds a Slack user from a directory match alone, even where Foundry holds a `slackUserId`: the binding has to be proven by the person who holds both accounts. Foundry's value is used only to warn when the proven binding disagrees with it.

**0022. Connector credentials are per principal, except Notion.** Graph, Jamie and Foundry credentials belong to one person and live in Key Vault under a per-principal secret name. Notion stays one organisation integration, because the All Tasks database is shared: reads filter on the principal's Notion user id, and writes set that principal as the assignee. The integration is renamed from "Dom's Lance" to "Lance".

**0023. Each principal has a private surface.** Each principal gets a private Slack channel holding only them and the bot. Proposal cards, alerts and briefs for a principal go to that channel alone. A button press is honoured only when the pressing Slack user resolves to the proposal's own principal. Dom keeps `dom-claude-agent` as his channel.

**0024. Admins see health, never content.** The admin role can see principals, status, connector health, cost, rules and alerts about the system. It cannot read another principal's proposals, briefs, commitments, ledger payloads or graph evidence. There is no delegated-review feature in this track.

---

## 4. Work packages

### M1. Identity and roles

- Entra: add the two app roles to the app registration manifest, set "assignment required", create the two groups, assign Dom to both. Script it with `az` and record every identifier in the runbook's known-values table, per the CLAUDE.md gotcha: never ask Dom for a value the CLI can read.
- Web: the sign-in callback admits a user whose token carries `Lance.User` or `Lance.Admin`. First sign-in creates a `principals` row with `status: 'onboarding'`. A user with no role sees the sign-in page's own refusal copy, through the existing `error=AccessDenied` path.
- api: `require-entra` checks the role instead of the UPN and resolves the principal from `oid`. Admin procedures require `Lance.Admin` and set `app.role = 'admin'` inside `withPrincipal`.
- A user removed from the group stops at the next sign-in. The worker also checks each active principal's role nightly through Graph (`/servicePrincipals/{id}/appRoleAssignedTo`, read with the api's own identity) and marks a principal who has lost it as `paused`, with a P1 alert to admins.

### M2. Credentials per principal

- Secret names: `graph-refresh-token--<principalId>`, `jamie-api-key--<principalId>`, `foundry-refresh-token--<principalId>`. Key Vault names allow letters, digits and hyphens; ULIDs fit.
- `TokenStore` takes the principal id. The Graph connect flow in Settings writes the caller's own secret. A Jamie key entered in onboarding goes from the web form to the api to Key Vault and never touches Postgres or a log line.
- Key Vault scoping, which the Phase 0 review deferred: the web identity gets no secret access at all; the api identity may set secrets (onboarding writes) but not read them; the worker identity may read and set. Two vaults if per-secret role assignments cannot be templated before the secrets exist; one vault with per-secret assignments if they can. Settle it in the ADR for M2 and fix the template, not the portal.
- Refresh token rotation takes a per-principal Postgres advisory lock, which closes the "no cross-process lock" item accepted in Phase 1 before a second worker replica is ever allowed.
- Notion: rename the integration, keep one `NOTION_TOKEN`, and add `notion_user_id` resolution per principal from the Notion users list by email at onboarding.

### M3. Onboarding

A checklist page shown to a principal whose status is `onboarding`. Each step is idempotent and records a `state_changed` ledger event.

1. Read and accept the data-processing notice (text from M7).
2. Connect Microsoft 365 (the existing consent flow, now per principal).
3. Enter a Jamie API key, with a test call before it is saved.
4. Connect Foundry (Phase 4, ADR 0016).
5. Link Slack with `/lance login` (M4).
6. Confirm quiet hours and time zone, prefilled from the mailbox settings.

When every step is done, status becomes `active` and `principal_state.mode` is `dry_run`. A new principal runs five working days in dry run before they can switch to live, the same rule every new watcher followed in Phase 1. The first poll for a new principal uses the backfill limits already in place and opts the Notion and agent-logs watchers out of triage, so the cost of joining is bounded.

### M4. Slack linking and private surfaces

- Manifest: add `groups:write` so the bot can create a private channel and invite the principal.
- `slack_links` table: `slack_user_id` (primary key), `slack_team_id`, `principal_id`, `linked_at`, `revoked_at`. `principals.slack_user_id` is filled from it for the existing lookups.
- `/lance login`: an ephemeral reply with a link to `/link/slack?state=<token>`. The token is an HMAC over Slack user id, team id, nonce and expiry, with the nonce stored so the link works once. The web route signs the user in with Entra and binds the ids. Both steps write ledger events.
- Private channel: created on first link as `lance-<first-name>` (falling back to a suffix on collision), with the principal invited. Its id goes to `principals.slack_channel_id`. Delivery code reads the channel from the principal, never from config.
- Every command and every interaction resolves the principal from the signed Slack user id through `slack_links`. An unlinked user gets one ephemeral reply pointing at `/lance login`. A button press whose user does not resolve to the proposal's principal is refused with an ephemeral message and raises a P1 `foreign_decision_attempt` alert.
- Replay protection, deferred since Phase 0: a nonce store keyed on the request signature, with entries kept for the replay window. It must land in this package because approve buttons become reachable by more than one person.

### M5. Fan-out, state and budgets

- Scheduler: enumerate `principals` where status is `active` and enqueue one job per principal, watcher and partition. The Foundry key sync stays one organisation-wide job.
- `principal_state` (from Phase 4 v3) carries each principal's pause, mode, quiet hours, push budget and cost ceiling. `system_state` stays global. The kill switch gains a scope: `/lance pause` pauses the caller; `/lance pause all` requires `Lance.Admin` and sets the global row. The global row always wins when it is stricter.
- Budgets: each principal has a daily ceiling (default £15, as today). `system_state.cost_ceiling_gbp` becomes the organisation ceiling across all principals (default £15 multiplied by the number of active principals, set by an admin). Crossing a principal's ceiling pauses that principal's model-backed agents; crossing the organisation ceiling pauses all of them and raises a P0 to admins.
- Rate limits: model calls go through one per-process limiter keyed on the Anthropic organisation, with a fair share per principal, so one principal's backfill cannot starve another's morning brief.
- Concurrency: pg-boss team size and the worker's replica count are set for 30 principals in M8's load test. The worker stays at one replica until the advisory lock from M2 has merged.

### M6. Per-principal behaviour

- Voice: `docs/voice/writing-style.md` becomes Dom's voice profile. A `voice_profiles` table (principal, profile text, updated_at) holds each principal's own. A principal without one drafts in the Valliance brand voice, from a default profile checked into `docs/voice/valliance-default.md`. The critic's style checks read the principal's profile; the British English and no-em-dash rules apply to everyone.
- Briefs, meeting prep and the weekly review run per principal and read only that principal's scope plus the reference and shared layers.
- Meeting actions shared across principals: two principals at one meeting would each propose the same Notion task. Before proposing a Notion task from a meeting, the debrief checks the shared Meeting node (keyed on `iCalUId`, Phase 4) for a task already created from it by any principal's Lance, through a shared-layer `ACTIONED_AS` edge the executor writes after it creates a Notion task. A match becomes a "task already exists" note on the card instead of a second proposal. This is the duplicate-actions problem Tarek raised on 22 September, solved for tasks only; transcripts stay with each principal.

### M7. Admin view and compliance

- Admin page (`Lance.Admin` only): principals with status, onboarding progress, connector health, last run per watcher, cost today and this week, rule changes to organisation defaults, and system alerts. No content from any principal.
- Offboarding, triggered by an admin or by M1's nightly role check: set status `offboarded`; pause the principal; delete their Key Vault secrets; revoke the Slack link and archive their channel; run retention for that principal with a zero-day window over cached mail bodies, transcripts and model logs; keep ledger rows with payloads nulled (ADR 0011). A runbook, `docs/runbooks/offboard-principal.md`, executed once in dev with a synthetic principal.
- Compliance documents in `docs/compliance/`: the data map per table with the personal data each holds; a legitimate interests assessment covering colleagues' data and the correspondents in their mailboxes; the data-processing notice shown in onboarding; retention per principal. Add Lance to the ISO 27001 access review, with the two Entra groups as the evidence.
- Evidence export takes a principal filter and an admin export covers system events only.

### M8. Pilot

- One colleague, chosen by Dom and Tarek after the framework workshop, onboarded in dev.
- Two weeks in dry run, then live for their own mailbox.
- A load test before the pilot: 30 synthetic principals with fixture connectors, measuring morning brief delivery time, queue latency and database load.
- Opening the `Lance Users` group to more people is a decision for after the pilot, recorded in the phase log.

---

## 5. What stays single-user on purpose

- Val. Company-wide agents, group channels, proposals owned by a team and role-based approver sets are the framework workshop's subject. The only cross-principal mechanisms in this track are the `promote_to_shared` pattern from Phase 4 and `ACTIONED_AS` deduplication.
- The inbox triage agent. It is Dom's Cowork scheduled task, outside this repository.
- Delegated review of another person's content by an admin or a manager. ADR 0024 rules it out for this track.
- Jamie workspace views. Jamie told Valliance on 22 September that organisation-level sharing is coming. Revisit when it ships; until then each principal's Jamie key sees only their own meetings.

---

## 6. Sizing

| Package | Size |
|---|---|
| M1 Identity and roles | 1 to 2 days |
| M2 Credentials per principal, Key Vault scoping, advisory lock | 2 days |
| M3 Onboarding | 2 days |
| M4 Slack linking, private channels, nonce store | 2 days |
| M5 Fan-out, state, budgets, rate limits | 2 days |
| M6 Voice profiles, per-principal briefs, action deduplication | 2 days |
| M7 Admin view, offboarding, compliance documents | 2 to 3 days |
| M8 Load test and pilot set-up | 1 day, then two weeks elapsed |

With Phase 4 WP4.1 this is close to the two weeks of dedicated time Dom estimated on 22 September, spread over more elapsed time because it runs as a secondary stream.

---

## 7. Tests that must exist

- Sign-in: a token without either role is refused; `Lance.User` reaches onboarding; `Lance.Admin` reaches the admin page; a user without `Lance.Admin` gets 403 from every admin procedure.
- Slack: an unlinked user gets the login prompt and nothing else; a link token works once and expires after five minutes; a replayed request inside the window is refused by the nonce store; a button pressed by a different linked principal is refused and alerts.
- Credentials: each principal's connectors read only their own secrets; the web identity cannot read any secret (checked against the deployed vault, not only in unit tests).
- Fan-out: two principals' watchers run with their own cursors; pausing one leaves the other running; the global pause stops both.
- Budgets: one principal crossing their ceiling pauses only their model-backed agents; the organisation ceiling pauses all.
- Voice: a draft for a principal with no profile passes the default profile's checks and is not checked against Dom's.
- Deduplication: a meeting with two principals produces one Notion task proposal; the second principal's card shows the existing task.
- Offboarding: after the runbook, the synthetic principal has no secrets, no Slack link, no cached content, and their ledger rows remain with payloads nulled.

---

## 8. Acceptance criteria for the multi-user track

| Criterion | Evidence expected |
|---|---|
| Access is controlled from Entra | In dev, removing a test user from `Lance Users` stops their next sign-in and pauses them within a day; the ledger holds both events |
| A second principal can onboard without Dom's help | A synthetic principal completes all six onboarding steps in dev, with no hand edits to Key Vault, Postgres or Slack |
| Slack identity is proven and scoped | `/lance login` binds a second Slack user; their cards reach only their channel; Dom's buttons cannot decide their proposals, and the reverse |
| Secrets are isolated | The web identity has no secret access in the deployed vault; each principal's secrets are read only by the worker |
| Fan-out holds at 30 principals | Load test: every synthetic principal's morning brief is stored by 06:35 and posted within the push budget; queue latency p95 under 60 seconds |
| Budgets are per principal and organisation-wide | Budget tests pass; the admin page shows cost per principal |
| Drafts use the principal's own voice | Voice test passes; Dom's profile is not applied to anyone else |
| Shared meeting actions are not duplicated | Deduplication test passes, and a real two-person meeting in the pilot produces one task |
| Offboarding is defined and exercised | `offboard-principal.md` executed once in dev and recorded in the ledger |
| Compliance documents exist | Data map, LIA, data-processing notice and retention schedule merged under `docs/compliance/`, and Lance listed in the ISO 27001 access review |
| The pilot runs | One colleague live for their own mailbox after two weeks of dry run, with no cross-principal leak found in the phase review |

---

## 9. Open questions and defaults

| # | Question | Default in force |
|---|---|---|
| Q1 | App roles or group claims | App roles assigned to groups (ADR 0020) |
| Q2 | Private channel or direct message per principal | Private channel, because the agent-logs watcher and the audit trail read channel history the same way for everyone |
| Q3 | Default daily cost ceiling for a new principal | £15, as for Dom; the organisation ceiling is the sum unless an admin sets it lower |
| Q4 | Who approves changes to organisation-default rules | Any `Lance.Admin`; Dom only in the pilot |
| Q5 | Should Notion stay one organisation integration | Yes (ADR 0022). Revisit if a principal needs Lance to read private Notion pages |
| Q6 | Pilot colleague | Chosen by Dom and Tarek after the framework workshop |
| Q7 | Dry-run length for a new principal | Five working days, as for a new watcher |

---

## 10. Risks

- **Building ahead of the workshop.** The framework workshop may define multiplayer differently, for example by putting team approvals first. M1 to M5 are needed under any model the session discussed; M6 and M8 are the parts most likely to change, and M8 is gated on the workshop for that reason.
- **A leak through a path RLS does not cover.** The graph is scoped in the repository, not by Postgres (Phase 4, ADR 0017), and Key Vault, Slack and the model context are outside the database altogether. The phase review for this track reviews every path by which one principal's data could reach another: SQL, Cypher, Slack delivery, Key Vault reads, model prompts, logs and the admin page.
- **Cost of new joiners.** Each principal's first poll triages a mailbox's worth of mail. The dev backfill in Phase 3 cost about USD 40 in 18 hours for one mailbox. Keep the backfill limits, and set the first-day ceiling for a new principal at the per-principal default so a backfill pauses rather than spends.
- **Consent from correspondents.** Colleagues' mailboxes hold mail from people who never agreed to an agent reading it. The LIA in M7 must exist before the pilot goes live, not after.
