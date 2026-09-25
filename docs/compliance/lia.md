# Legitimate interests assessment: Lance

For Valliance's Data Protection Officer. Draft of 24 September 2026, prepared with the build team at package 5.6 of Phase 5. It must be reviewed and signed off by the DPO before a second colleague is onboarded (roadmap, Pilot gate). What Lance holds is listed in [data-map.md](data-map.md) and how long it keeps it in [retention.md](retention.md).

Items that need the DPO's judgement rather than a fact from the build are marked **DPO decision needed**. Nothing in those items has been decided on the DPO's behalf.

## 1. What the processing is

Lance is an assistant each participating colleague (a "principal") signs up to. With the principal's own sign-in, it reads their Microsoft 365 mail and calendar and their Jamie meeting recordings (transcripts, summaries, action items), and the shared Notion task list. A language model (Anthropic's Claude, reached through Anthropic's API) sorts incoming mail, spots promises and follow-ups, drafts replies and prepares briefings. Lance posts suggestions to the principal's own private Slack channel. It carries out an action only after the principal approves it, and only actions of a few kinds: creating a draft reply (never sending it), a calendar hold, a Notion task, a mail category. It never sends email: the permission to send is not requested from Microsoft at all (spec 4.1).

Two groups of people are affected:

- **Principals**: Valliance colleagues who choose to use Lance, after reading the data-processing notice ([packages/shared/content/data-processing-notice.md](../../packages/shared/content/data-processing-notice.md)) and accepting it at onboarding.
- **Third parties**: anyone in a principal's mail, calendar and meetings: other colleagues, clients, prospects, suppliers, candidates. They are not told individually and have not agreed to an assistant reading their correspondence.

## 2. Purpose test: is there a legitimate interest?

**The interests.** Valliance's interest, and each principal's, in:

1. Not missing client and colleague requests, and replying to them on time.
2. Keeping track of commitments made and owed in mail and meetings.
3. Arriving at meetings prepared, and turning meeting outcomes into tasks.
4. Reducing the time senior staff spend triaging mail.

These are ordinary business interests of a consultancy and of the people working in it. The third parties benefit too, in that their requests are answered and commitments to them kept.

**Is it lawful and clearly stated?** The purposes are stated in the specification (section 1) and in the notice each principal accepts. Lance is not used to monitor staff, assess performance or make decisions about anyone: there is no feature for any of these, and an admin cannot read a principal's content (section 5, safeguard S3).

> **DPO decision needed:** confirm the interests above are legitimate interests Valliance may rely on, and whether Valliance's staff policies need a line about an assistant reading work mail that a colleague has chosen to connect.

## 3. Necessity test: is the processing needed for the purpose?

- **Reading mail and meetings is the purpose.** The value is in noticing what a person would otherwise have to notice themselves. There is no way to spot an unanswered client request without reading the request.
- **Less intrusive options were considered.** Reading subject lines only was rejected because the request is usually in the body. A manual tool (a colleague forwards mail to Lance) would miss the point of not missing things. Reading only the principal's own sent mail would miss what is owed to them.
- **What the model is sent is limited to the task.** Triage receives a mail's headers and body; briefs receive graph summaries, not raw transcripts, except when preparing a specific meeting (spec 4.4). Lance does not send attachments to the model and does not read attachments at all.
- **What is kept is limited in time.** Raw mail is kept 90 days and transcripts 180, then emptied; what triage copied from them goes at the same point ([retention.md](retention.md)).
- **Only the people who opt in are read.** Lance reads the mailboxes of principals only, each with that person's own credentials (ADR 0022). It never reads a mailbox with an organisation-wide permission.

> **DPO decision needed:** whether 90 days for mail and 180 days for transcripts are the shortest periods that meet the purposes, or should be shorter.

## 4. Balancing test: do the individuals' interests override?

**Nature of the data.** Business correspondence and meeting discussion. It can include personal matters (a health mention, a family event), since people write about these at work. Lance does not look for special category data and has no feature that uses it, but cannot keep it out of what it reads.

**Reasonable expectations.** A colleague who connects their own mailbox expects it to be read by the tool they connected. Third parties writing to a Valliance address expect a Valliance person, and Valliance's systems (spam filtering, archiving, search), to process their mail; they may not expect an AI assistant to read and summarise it. This is the main point on which the balance turns.

**Likely impact.** Low for most correspondence: the effect of processing is that the principal replies sooner or is reminded of a promise. The risks are (a) exposure: one principal's mail reaching another person; (b) an action taken in the principal's name that they did not intend; (c) a third party's personal matter being summarised into a briefing; (d) data sent to the model provider.

**Safeguards that reduce the impact** (section 5) address each: (a) by S1 to S4 and S10, (b) by S5 to S7, (c) by S8 and S9, (d) by S11.

**Children and vulnerable people.** Lance is not aimed at either. Mail from candidates or clients about vulnerable people may appear incidentally.

> **DPO decision needed:** the balance itself: whether, with the safeguards below, third parties' interests are overridden, and whether they should be told (for example a line in Valliance's privacy notice and email footer) that Valliance uses an AI assistant on staff mailboxes.

> **DPO decision needed:** whether a data protection impact assessment is required, given the use of a new technology on correspondence of people who have not been told.

## 5. Safeguards Lance actually has

Each safeguard is named with the code or decision record that provides it, so it can be checked.

| # | Safeguard | Where it lives |
|---|---|---|
| S1 | Each principal's data is separated from every other principal's by the database itself, not only by the application. A query that forgets whose data it is returns nothing | Row-level security, ADR 0015; `packages/db/drizzle/0009_principals_and_rls.sql`; `packages/db/src/isolation.test.ts` |
| S2 | In the knowledge graph, what one principal's mail or meetings showed (who wrote to whom, what was said) is private to them. Only names and email addresses of people and organisations are shared, and with no record of which mailbox showed them | ADR 0017, ADR 0033; `packages/ontology/src/repository.isolation.test.ts` |
| S3 | Lance admins see health, never content: statuses, counts, ages and costs. There is no feature for an admin or manager to read a colleague's mail through Lance | ADR 0024; `apps/api/src/admin/store.ts`; the test that no admin response carries content, `apps/api/src/main.test.ts` |
| S4 | Each principal's suggestions go only to their own private Slack channel, and only they can approve them; anyone else's button press is refused and raises an alert | ADR 0023; `apps/api/src/slack/interactions.ts` |
| S5 | The language model cannot act. Model-backed agents can read and can propose; only deterministic code carries out an approved proposal | Non-negotiable 2; the import boundary in `eslint.config.js`; `apps/worker/src/executor` |
| S6 | Lance never sends email. The Microsoft permission to send is not requested, and a policy rule refuses the action whatever any other rule says | Spec 4.1; `packages/policy/src/hardFloors.ts` |
| S7 | New principals start in dry run: nothing is written anywhere for their first five working days, and each action type needs the principal's approval until they grant otherwise | ADR 0015; `packages/ledger/src/control.ts`; spec 6.3 |
| S8 | Mail and transcript copies are emptied after 90 and 180 days, triage copies with them, model logs after 30 days | [retention.md](retention.md); `packages/ledger/src/retention.ts` |
| S9 | Logs carry no mail or transcript content at the level production runs at | Spec 13; `packages/telemetry` |
| S10 | Access to Lance is controlled in Entra by two app roles, Lance.User and Lance.Admin, assigned to each person directly and reviewed in the ISO 27001 access review; a person whose roles are removed is paused the next night and offboarded a week later | ADR 0020; `apps/worker/src/roles/roleCheck.ts`; [iso27001-access-review.md](iso27001-access-review.md) |
| S11 | Credentials are held per person in a separate Key Vault that the web app cannot reach at all and the api can write but not read | ADR 0022; `infra/modules/principal-vault.bicep` |
| S12 | Every read and every action is recorded in an append-only ledger that no application can alter, with a signed export for audit | Non-negotiable 1; ADR 0011; `apps/api/src/admin/evidence.ts` |
| S13 | Offboarding deletes a principal's credentials, revokes their Slack link, archives their channel and empties their mail and transcript copies the same day | [offboard-principal.md](../runbooks/offboard-principal.md); `apps/worker/src/offboarding/offboard.ts` |
| S14 | Data stays in the UK: the database, vaults and apps run in Azure UK South | `infra/params/dev.bicepparam` (`location = 'uksouth'`) |

Safeguards that do not exist yet, and would strengthen the balance:

- No mechanism for a third party's objection or erasure request to reach Lance ([retention.md](retention.md), open decision 4).
- No filter that keeps special category data, or mail marked personal or private, out of what Lance reads.
- Content sent to the model provider leaves the UK.

> **DPO decision needed:** whether any of these must exist before the pilot, and the transfer basis for the model provider (Anthropic's data processing terms, the processing location and whether zero data retention is in place for Valliance's organisation).

## 6. Outcome

> **DPO decision needed:** the conclusion of this assessment, its date, the reviewer, and the date of its next review (suggested: at the end of the pilot, and whenever Lance starts reading a new source).
