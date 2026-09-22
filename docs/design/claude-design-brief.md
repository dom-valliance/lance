# Lance web UI: design brief for Claude Design

Prepared 21 September 2026 from the repository at branch `feat/phase-2-meetings`, the specification (`Ian-Assistant_Spec_v1.md`, section 12) and the current `apps/web` build. Paste or attach this whole file into Claude Design. Everything Claude Design needs is here; it does not need repository access.

## 1. What Lance is

Lance is a personal operating agent for one person, Dom Selvon, at Valliance, an AI consultancy. It watches Dom's mail, calendar, meeting transcripts (Jamie) and tasks (Notion), keeps an immutable ledger of everything it sees and does, proposes actions in Slack and in this web UI, executes only what policy allows, and prepares the working day.

The web UI is the second surface. Slack is where most decisions happen on the move; the web UI is where Dom reviews the queue in depth, follows the audit trail, tunes policy and watches the agents. Anything posted in Slack also exists here; the proposal id is the join.

There is one user. Sign-in is Microsoft Entra with one allowed account. No onboarding, no team features, no marketing pages.

## 2. What we are asking for

Design the complete web UI: a token set, a component sheet and every page listed in section 7, each in its default, empty, loading and failure states, plus an interactive prototype of the proposal decision flow. Desktop first, phone width supported. Dark theme only.

Five pages are built and seven are placeholders. For the built pages, improve on what exists without changing the information architecture unless there is a clear reason. For the placeholders, the spec text in section 7 is the requirement.

## 3. Design principles

1. **Provenance on every claim.** Every alert line, brief line, proposal and commitment carries where it came from: the source system, the record id, the time it was observed, and a link. The UI renders these as links, never buries them in a tooltip. If a reader cannot see where a fact came from, the design is wrong.
2. **Decisions are safe.** Approve, edit, reject and snooze are the four decisions. Reject and drop need a reason. Nothing destructive is possible: Lance cannot send email or delete anything, and the UI must never imply it can. Hard floors in the policy matrix appear locked, not disabled.
3. **A working tool, not a dashboard.** Dense, scannable, calm. Tables over cards for lists. No hero numbers, no decorative charts, no gradients. Charts appear only on the Agents page and only where a number changes what Dom does.
4. **Dark first, and only.** The shell is dark with no light theme. Contrast to WCAG 2.2 AA everywhere.
5. **Keyboard complete.** Every proposal decision can be taken without a mouse. Focus order follows reading order. Filter controls are real links or real forms and work without JavaScript.
6. **British copy, plain words.** Sentence case. No emojis. No em dashes anywhere in copy. Status text is a sentence, not a code: "Approved and waiting for the executor", not "APPROVED". Times display in Europe/London as "21 Sept 2026, 14:05".

## 4. The existing visual system

Keep these unless you have a strong reason to change them, and say so if you do.

**Typography.** Satoshi variable (Fontshare), weights 300 to 900, with italic. Fallback `system-ui, sans-serif`. Body 14px, table header labels 12px muted, page title 24px semibold. One family for headings and body.

**Component library.** shadcn on Tailwind 4 and Radix. Existing primitives: Button (default, outline, ghost, destructive; size sm), Badge (default, secondary, outline, destructive), Card with header and description, Separator. Native `select`, `input`, `textarea` styled to match. Anything you design should be buildable from shadcn primitives.

**Radii.** Base radius 0.75rem. Cards and inputs use it; badges are fully rounded pills.

**Palette today.** Neutral oklch greys with no hue:

| Token | Value | Use |
|---|---|---|
| background | oklch(0.145 0 0) | page |
| card, popover, sidebar | oklch(0.205 0 0) | surfaces |
| secondary, muted, accent | oklch(0.269 0 0) | fills |
| border | white at 10% | hairlines |
| input | white at 15% | field borders |
| muted-foreground | oklch(0.708 0 0) | labels, secondary text |
| foreground | oklch(0.985 0 0) | text |
| primary | oklch(0.922 0 0) | filled buttons, active pills |
| destructive | oklch(0.704 0.191 22.2) | reject, drop, failures |

There is no brand accent yet. The shadcn default blue in the sidebar token is unused.

**Logo.** A wordmark "Lance" in a geometric sans with the "a" replaced by a four-point star. Supplied black on white. The UI needs a reversed (light on dark) version and a star-only mark for the collapsed sidebar and favicon. Do not add a strapline.

**Shell.** Fixed left sidebar, 224px, surface colour, wordmark at the top, ten navigation items as a vertical list, "Sign out" outline button at the bottom. Main content has 32px padding. Navigation order: Today, Proposals, Tasks, Commitments, Alerts, Ontology, Policies, Ledger, Agents, Settings.

## 5. What to add to the system

**One accent.** Propose a single accent for links, active states and focus rings. It must reach AA on the card surface and read as Valliance rather than generic SaaS.

**Semantic colour sets.** Each set needs a fill, a text colour and a hairline that all pass AA on the card surface. Colour is never the only signal; every value also has a text label.

| Set | Values |
|---|---|
| Proposal status | pending, held, approved, edited, executing, executed, rejected, expired, failed |
| Alert severity | P0, P1, P2 |
| Policy decision | forbid, propose, auto |
| Source system | graph (Microsoft 365), jamie, notion, slack, lance, webhook |
| Commitment state | open, chased, done, dropped, overdue |
| Watcher health | healthy, stale, breaker open, paused |

**Components not yet designed.** Filter pill row (links, one active, styled as pressed). Filter form (row of labelled selects and date inputs with Apply and Clear). Provenance link (system, record id, observed time, external link icon). Ageing label ("overdue by 3 days", "due today", "done yesterday"). Empty state (one sentence plus a Clear link; no illustration). Inline failure under a form (`role="alert"`, destructive text, never a toast that disappears). Key-value grid for detail pages. Status timeline for ledger trails. Policy matrix cell. Locked cell. Diff table (field, originally, after the edit). Sparkline for token spend. Mobile navigation (sidebar collapses to a top bar with a menu).

## 6. Layout and responsiveness

Primary viewport is a 14-inch laptop, 1440 wide. Content column has no maximum width; tables use the full width. At tablet width the sidebar becomes a drawer. At phone width (360 wide) the pages Dom reaches from a Slack link must still work: the proposal detail page and its Decide card above all. Tables at phone width become stacked rows, not horizontal scroll, for Proposals and Commitments; the Ledger may scroll horizontally.

## 7. The pages

Each entry gives the purpose, the content and controls, the states, the current build status, and the data the page shows. Enumerations referred to below are in section 8.

### 7.1 Today

**Purpose.** Dom's first screen of the day. A rendered morning brief with live state, a Regenerate button, and after 16:00 an afternoon board beneath it.

**Content.** The brief has six sections in order:

1. Day shape: first and last meeting, total meeting hours, longest free block, and any proposed calendar holds when free time is under two hours.
2. Meetings in order. Each: title and time, attendees resolved to people with their organisation, the last three interactions with each, open commitments in both directions, documents and transcripts referenced in the last 30 days, two suggested objectives. Unknown attendees flagged. Thirty minutes before an external meeting this section expands to the full meeting prep.
3. Tasks due today or overdue across Notion and Jamie, deduplicated, source badge on each, top five ranked with a one-line reason.
4. Waiting for: inbound commitments past their chase date, each with a Chase button that creates a draft-email proposal.
5. Overnight: alerts raised, proposals awaiting decision (count and the top three), what executed automatically.
6. Agent health in one line: watcher ages, breaker states, yesterday's cost.

The afternoon board lists what moved since the brief (tasks completed, proposals decided, commitments closed), what is still pending decision, and tomorrow's first meeting with whether prep exists.

Every line carries provenance. Items that are proposals link to their detail page; items that are commitments or tasks link to their pages.

**Controls.** Regenerate (secondary; shows generating state and the time of the last generation). Chase per waiting-for row. Live updates arrive without reload.

**States.** Before 06:30 with no brief yet ("Today's brief arrives at 06:30. Regenerate to build it now."). Brief present. Brief present with board. Generating. Brief generation failed with the reason.

**Build status.** Placeholder. Arrives in Phase 3.

### 7.2 Proposals

**Purpose.** The queue of everything Lance wants to do and is waiting for Dom to decide, with the history of what has been decided.

**Content.** Filter form: Status, Action class, System, each a select with "Any", plus Apply filters and Clear. A table, newest first: Preview (link to the detail), Action class, Counterparty, System, Status (badge), Expires. Pending rows are visually distinct from decided rows. Consider a count of pending items in the sidebar item and at the top of the page.

**States.** Rows. No rows for these filters ("No proposals match these filters. Clear them to see the whole queue."). Loading. API unreachable.

**Live.** Server-sent events refresh the list when a decision lands in Slack.

**Build status.** Built. Improve legibility: the action class and counterparty are raw enum values (`draft_email`, `client`) and want humanising and colour; expiry wants a relative form ("in 3 h") with the absolute time on hover or beneath.

### 7.3 Proposal detail

**Purpose.** Everything about one proposal and the place to decide it. This is the most important page in the product and the one most likely to be opened on a phone from Slack.

**Content, top to bottom.**

- Back link to the queue.
- Header card: the preview as the title (for a draft email this is the subject and the first line; for a task it is the task title; for a calendar hold it is the hold title and time). Badge row: action class, counterparty class, system, status. Rationale paragraph in muted text. Key-value grid: Policy cell (action class / counterparty / system), Policy decision, Expires, Correlation id (links to the ledger trail). Provenance list: each reference as "system:recordId, seen 21 Sept 2026, 09:14", linked where a URL exists.
- Payload preview. The current build shows the payload only through the edit form. Design a proper read view per action class: a draft email rendered as an email (to, subject, body); a Notion task as its fields; a calendar hold on a small timeline; a category or move as before and after.
- "What the edit changed" card, shown only after an edit: table of Field, Originally, After the edit.
- Decide card. When the status is pending: Approve (primary), Snooze 4h (outline), then an Edit section with one textarea per editable string field and "Save the edit and execute" (outline), then a Reject section with a required Reason select (Wrong target, Not right now, Draft needs work, Other), an optional Note and a destructive Reject button. When held (dry-run mode): same without Snooze. For any other status the card shows one sentence instead ("Approved and waiting for the executor.", "Executing now.", "Executed.", "Rejected.", "Expired before it was decided.", "Execution failed. Check the status history below."). A failed action shows its message inline beneath the form it came from.
- Status history card: the ledger trail for this correlation id, oldest first: When, Kind, Actor, Detail.

**States.** Pending, held, approved, executing, executed, failed, rejected, expired. Not found. Each decision button has a pending state while the server action runs.

**Build status.** Built. Wants a payload read view, a clearer hierarchy between reading and deciding, and a phone layout where Approve is reachable without scrolling past the whole payload.

### 7.4 Tasks

**Purpose.** Every open task across Notion and Jamie in one list. Notion is the single home for tasks under Dom's name; Jamie tasks are read-only here because Jamie has no completion endpoint.

**Content.** Two filter pill rows: Source (All, Notion, Jamie) and Status (Open, Done, All). One sentence explaining that Jamie tasks are completed in Jamie. Table: Title with the source's own status beneath, Source badge, Due, Assignee ("you" for Dom, a name, or "unassigned"), Meeting (the meeting a Jamie task came from), Link ("Open in Notion", "Open in Jamie").

**Coming later, design for it now.** A Create task control that opens a small form and results in a proposal. A Complete control per Notion row that creates a complete-task proposal, with a state showing a proposal is already pending for that task.

**States.** Rows. Empty for these filters. Loading. Failure.

**Build status.** Built without Create and Complete.

### 7.5 Commitments

**Purpose.** Promises extracted from sent mail and transcripts, in both directions: what Dom owes and what is owed to Dom.

**Content.** Direction as two tabs (I owe, Owed to me), then a Status pill row (Open, Chased, Done, Dropped, All). Table sorted overdue first, then soonest due, then oldest: Description with the verbatim evidence quote beneath in quotation marks; Counterparty; Due date with the ageing label beneath ("overdue by 2 days", "due in 3 days", "due today", "no date", "done yesterday"); Chased (count, and next chase time where set); Provenance links; Actions.

**Actions.** Open rows: Mark done (small primary), Drop with a required reason field and a small destructive Drop button. On the Owed to me tab an additional Chase (small outline) that queues a draft-email proposal. Closed rows show a sentence instead ("No actions: this commitment is done."). Failures appear inline under the row's form. The row-level Drop reason input is crowded in the current build; consider a confirm step or an inline expansion.

**States.** Rows. Empty for these filters. Loading. Failure. Overdue rows stand out without relying on colour alone.

**Build status.** Built.

### 7.6 Alerts

**Purpose.** Open, acknowledged and muted alerts with a way to acknowledge, mute for 24 hours or follow the provenance.

**Content.** Status pill row (Open, Acknowledged, Muted, All) and a Severity filter (P0, P1, P2). A list, most severe and newest first. Each row: severity chip, kind in plain words (see section 8 for the thirteen kinds), title, body, count when the same alert has repeated, first and last seen, provenance links, a suggested action where one exists, and Ack and Mute 24h buttons. Muting is itself recorded in the ledger; the muted row shows until when.

**States.** Open alerts present. Nothing open ("Nothing needs attention."). Muted list. Loading. Failure. Live updates when a new alert arrives.

**Build status.** Placeholder. Phase 3.

### 7.7 Ontology

**Purpose.** The people, organisations and projects Lance knows, and a queue of suspected duplicates to merge or dismiss.

**Content.** Three views.

- Search: one search field across people, organisations and projects with type-ahead results grouped by type, each result showing name, type, organisation for a person, and last interaction.
- Entity page: header with name, type, organisation or domain, aliases and source references. Timeline of interactions (mail, meetings, transcripts) newest first with provenance. Open commitments in both directions. Related tasks. Related people for an organisation or project.
- SAME_AS review queue: pairs of records the resolver thinks are the same entity, side by side with the fields that matched and the fields that differ, a confidence, and Merge and Dismiss buttons. A merged pair records which record survived.

**States.** Search with no query, with results, with none. Entity with a full timeline and an entity Lance has only seen once. Empty review queue.

**Build status.** Placeholder. Phase 4.

### 7.8 Policies

**Purpose.** What Lance may do on its own, what it must propose, and what is forbidden, as a matrix Dom can read and edit safely.

**Content.**

- Matrix: rows are action classes, columns are counterparty classes, with a system selector above (graph, jamie, notion, slack, lance, or all). Each cell shows the effective decision (forbid, propose, auto) and whether it comes from a specific rule or a wildcard. Hard floors (send_email and delete forbidden everywhere; rule_change never auto) render locked with a lock glyph and cannot be clicked into edit.
- Cell detail (drawer or side panel): the rule that decides the cell with its rationale, version and author (Dom or the promotion analyser); rule history; evidence: recent proposals in that cell with their outcomes, and consecutive approvals without edit towards the promotion threshold (default 10 over 14 days).
- Rule editor: action class, counterparty class, system (each with wildcard), decision, conditions (within working hours, max per day, max per hour, require critic pass, minimum confidence), rationale. Validation messages are sentences. Saving records a ledger event.
- Shadow run: choose a candidate rule set and a date range, run, and see a diff against actual decisions: what would have gone auto that was proposed, what would have been forbidden, counts per cell.

**States.** Matrix with seed rules. Cell with no specific rule (falls back to propose). Locked cell. Editor with a validation error. Shadow run in progress and with a diff.

**Build status.** Placeholder. Phase 4.

### 7.9 Ledger

**Purpose.** The immutable record of everything Lance observed, proposed, decided and executed. Read-only. The place to answer "why did that happen".

**Content.** Filter form: Kind (select), Actor (text, for example `user:dom` or `agent:triage`), Source system (select), From and To dates, Apply filters, Clear. Add an export control for the current range (CSV). Table newest first: When, Kind, Actor, Source system, Correlation id (link).

**Correlation trail page** (`/ledger/<correlationId>`): back link, title "Correlation <id>", then every event with that id oldest first: When, Kind, Actor, Source system, Proposal (link where the payload names one). Design this as a vertical timeline rather than a bare table; it is the audit story of one thing from observation to execution.

**States.** Rows. Empty for these filters. Unknown correlation id ("No events carry that correlation id. Check the id and try again."). Loading. Failure.

**Build status.** Both built as plain tables. Export not built.

### 7.10 Agents

**Purpose.** Health and cost of every watcher and model agent.

**Content.** A row or card per component. Watchers: graph-mail, graph-calendar, jamie, notion, agent-logs. Agents: triage, planner, critic, executor, promotion analyser. Each shows last run and its age, cursor position, circuit breaker state, the last error (tail, expandable), cost today and over seven days, and a small token sparkline. A global cost chart over 30 days with the daily ceiling (default £15) drawn as a line and the 80% warning band. Prompt cache hit rate for triage.

Charts are muted and monochrome with the accent for the current series. Numbers are formatted in pounds with two decimals.

**States.** All healthy. One breaker open. One watcher stale. Paused by the kill switch. No cost yet today.

**Build status.** Placeholder. Phase 3 and 5.

### 7.11 Settings

**Purpose.** The few knobs Dom owns.

**Content, in cards.**

- Mode: live or dry run, with a sentence explaining what dry run does (everything runs, proposals are held, nothing is written externally).
- Kill switch: a Pause control with a required reason, showing paused-since and by whom when active, and Resume. This must look deliberate, not like a toggle that can be flipped by accident.
- Quiet hours (default 19:00 to 07:00 and weekends) and push budget (default 3 unsolicited posts per hour).
- Retention windows, read-only display of the defaults (mail bodies 90 days, transcripts 180, ledger 2 years, model logs 30 days).
- Connectors: Microsoft 365, Jamie, Notion, Slack. Each shows health, last successful call, and a Connect or Re-authorise button. Microsoft 365 is built: a card with explanatory copy and a "Connect Microsoft 365" button.

**States.** Live and healthy. Dry run. Paused. A connector disconnected with the sentence telling Dom to connect again.

**Build status.** Partly built: heading and the Microsoft 365 connect card.

### 7.12 Sign-in and not found

Sign-in is a redirect to Microsoft; design only the interstitial page a signed-out visitor sees ("Sign in with your Valliance account") and the refusal for a non-allowed account. Not found is one sentence and a link back to Today.

## 8. Enumerations and copy

**Proposal status.** pending, held, approved, edited, executing, executed, rejected, expired, failed.

**Action classes.** read, classify, draft_email, apply_category, move_mail, create_task, update_task, complete_task, create_tag, apply_tag, create_calendar_hold, post_slack, send_email, delete, rule_change. Humanise in the UI: "Draft email", "Apply category", "Create calendar hold".

**Counterparty classes.** self, internal, client, prospect, partner, vendor, unknown.

**Systems.** graph (show as "Microsoft 365"), jamie, notion, slack, lance, webhook.

**Ledger kinds.** observed, resolved, proposed, decided, executed, failed, alert_raised, alert_acked, rule_changed, state_changed, retention_applied, cost_recorded.

**Alert kinds and default severity.** token_refresh_failed P0; risk_language_in_client_mail P0; watcher_failed P1; breaker_open P1; agent_step_skipped P1; stale_watermark P1; cost_spike P1; calendar_conflict P1; commitment_overdue_outbound P1; client_mail_unanswered P1; auto_rule_demoted P1; external_meeting_unknown_attendee P2; proposal_expiring P2.

**Reject reasons.** Wrong target, Not right now, Draft needs work, Other.

**Actors.** `user:dom`, `agent:triage`, `agent:planner`, `agent:critic`, `agent:executor`, `agent:promotion-analyser`, `watcher:<name>`.

**Copy rules.** British spelling. Sentence case for everything including buttons and table headers. No emojis. No em dashes; use commas or full stops. No exclamation marks. Empty states are one sentence that says what to do. Failure messages say what happened and what to do next. Times as "21 Sept 2026, 14:05" in Europe/London. Relative ages as "3 h ago", "2 days".

## 9. Deliverables

1. Token sheet: colours (base, accent, six semantic sets), type scale, spacing, radii, focus ring, for a dark theme, as CSS custom properties compatible with the shadcn variable names in section 4.
2. Component sheet covering section 5 in default, hover, focus, pressed, disabled and loading.
3. All pages in section 7 at 1440 and 360 wide, in every state listed.
4. Interactive prototype: Proposals list, open a pending proposal, approve, see the status history update; then the same for edit and reject.
5. Reversed wordmark and star mark.

## 10. Out of scope

Slack Block Kit cards (a separate brief). A light theme. Marketing or public pages. Anything for a second user. Illustrations.

## 11. Constraints for buildability

Every design must map to Next.js server components with shadcn primitives and Tailwind utilities. Filters are links or GET forms so the URL holds the state. Decisions are POST forms with failure rendered beside the form. No component may depend on client-side state for its first render except the live-refresh and SSE islands. Icons from Lucide only.
