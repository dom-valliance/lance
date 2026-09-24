# Lance retention schedule

For Valliance's Data Protection Officer and ISO 27001 auditor. What Lance keeps, for how long, and how the limit is enforced. The tables and secrets themselves are described in [data-map.md](data-map.md).

## The schedule

The windows are the defaults the specification set (spec 4.4 and Q3). Each can be changed per environment with the setting named, without a code change.

| What | Kept for | Setting | What happens at the end |
|---|---|---|---|
| Mail bodies: the copy of each message Lance read (sender, recipients, subject, body) | 90 days | `RETENTION_MAIL_BODIES_DAYS` | The copy is emptied in the ledger and in `observations`; the record that Lance read it stays |
| Meeting transcripts: each Jamie meeting Lance read (transcript, summary, action items) | 180 days | `RETENTION_TRANSCRIPTS_DAYS` | As above |
| What triage copied from a mail or transcript (its summary, the people named, evidence quotes) | The window of the mail or transcript it came from: 90 or 180 days | as above | The triage result is emptied at the same point as its source, so a quote never outlives the text it was taken from |
| Model logs: a model answer Lance rejected, and the error text of a failed model call | 30 days | `RETENTION_MODEL_LOGS_DAYS` | Emptied |
| Everything else in the ledger (decisions, approvals, state changes, calendar entries, Notion tasks) | 2 years | `RETENTION_LEDGER_DAYS` | Emptied, except the graph's recorded changes (below) |
| The knowledge graph and its recorded changes | Indefinitely | none | Kept; the graph is rebuilt from them |
| Application logs and traces | 30 days | `infra/modules/monitoring.bicep` | Deleted by Log Analytics |
| Database backups | 35 days | `infra/modules/postgres.bicep` | Deleted by Azure. An emptied record is still in backups taken before it was emptied, until they age out |
| A principal's credentials | Until offboarding, then 90 days soft-deleted | Key Vault | Deleted at offboarding; recoverable by a Key Vault administrator for 90 days; purged by Azure after that |

"Emptied" means the ledger row stays and its content is set to nothing. The row keeps when it happened, who or what did it, the source record's identifier and a fingerprint (a SHA-256 hash) of the content, so the audit trail still proves what was recorded without holding it. No ledger row is ever deleted (ADR 0011).

Ages are counted from when Lance recorded the item, not from the date on the source. A two-year-old email that Lance first reads today is kept for 90 days from today.

## How it is enforced

- **A nightly job.** At 03:00 UK time the retention job runs once for every principal, whatever their status: a paused or offboarded principal's data ages out on the same schedule as anyone's. It is a locked job; no principal or admin can turn it off (`apps/worker/src/jobs/registry.ts`).
- **One principal at a time.** Each run reads and changes only that principal's rows. The database enforces this with row-level security, not only the code.
- **A separate database role.** The job acts as `lance_retention`, a role that may do one thing: empty the content column. A database trigger refuses every other change to the ledger, including any delete, by anyone. The applications' ordinary role, `lance_app`, cannot empty content at all; the worker takes on `lance_retention` only inside the retention job's own transaction (`packages/ledger/src/retention.ts`, ADR 0011).
- **A record of every run.** Each run writes a `retention_applied` event to the principal's ledger with the windows it applied and how many items it emptied of each kind. The Settings page shows the last run; the ISO 27001 evidence export includes every run in its period.
- **Offboarding.** When a principal is offboarded ([offboard-principal.md](../runbooks/offboard-principal.md)), the same job runs at once for them with a window of zero days for mail bodies, transcripts, triage copies and model logs, so all of those are emptied that day. Their other ledger entries follow the two-year window.
- **Tests.** The behaviour is tested against a real database with the real roles: `packages/ledger/src/retention.test.ts` (each window, the other principal left alone, the refusal when the role is missing), `packages/db/src/migrate.nonsuperuser.test.ts` (the role grant as Azure makes it), and `packages/db/src/migrate.test.ts` (the trigger).

## Decisions recorded

- **Evidence quotes in triage results.** The Phase 2 review found that quotes copied into triage results would outlive the transcript they came from (two years against 180 days). The choice made: a triage result is emptied at the window of the source it was built from. The database only allows content to be emptied whole, so the whole triage result goes, not only the quote. Recorded in ADR 0011's amendment.
- **The graph's recorded changes are kept indefinitely.** They are what the knowledge graph is rebuilt from, and the specification keeps graph facts indefinitely. Emptying them at two years would make the graph impossible to rebuild.

## Open decisions for the DPO

> **DPO decision needed** on each of these. Until decided, Lance keeps the data as described.

1. **Proposals, briefs, alerts and policy evaluations** have no window. Proposals hold draft email text; briefs hold summaries naming people and meetings; alerts can quote a subject line.
2. **Commitments** keep the evidence quote (a sentence from a mail or transcript) for as long as the commitment exists, which can be longer than the source's 90 or 180 days.
3. **An offboarded principal's private graph evidence and table rows** (proposals, briefs, commitments, alerts) are kept, readable by nobody, since only the principal's own scope can read them. Whether they should be deleted at offboarding or after a period.
4. **Shared people and organisations in the graph** are kept indefinitely. Whether a person who asks to be forgotten should be removed, and how that request reaches Lance.
5. **Anthropic's retention** of the mail and transcripts sent for analysis, under Valliance's agreement with Anthropic.
6. **Whether the windows above are right** for Valliance's purposes, in particular 180 days for transcripts and two years for the ledger.
