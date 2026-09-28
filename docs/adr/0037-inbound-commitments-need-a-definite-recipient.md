# 0037. Inbound commitments need a definite recipient

Date: 2026-09-28
Status: Accepted

## Context

Spec 5.1 gives a commitment one of four statuses and a direction, and spec 7.2 asks the extractor for the direction only. On group calls the extractor tags as inbound a promise a client makes to whoever asked, which is often a colleague of the principal on the same call. The "Owed to me" tab fills with promises the principal is not waiting on, the chase job drafts emails for them, and the briefs list them under "waiting for". The golden set had no case of this: every inbound fixture is a one-to-one exchange.

## Decision

- **The model says who the promise was made to.** Each candidate carries `promisedTo`, the name of the person the promise was said or written to, and, for inbound only, `owedToPrincipal`: `definite`, `possible` or `not_principal`. The prompt defines them: definite when the promise answers the principal's own request, names or addresses the principal, or is one-to-one with them; possible when it is made to the room, to "you" where the addressee is unclear, or in mail where the principal is copied rather than addressed; not the principal when it is made to someone else.
- **Code holds the floor.** `settleOwedToPrincipal` in `@lance/agents` runs on every candidate from the extractor and from mail triage. A `definite` whose `promisedTo` does not name the principal becomes `possible`, a missing value becomes `possible`, and `not_principal` is discarded. The model can only make a commitment less certain than it says, never more.
- **Possible commitments wait in a new status, `unconfirmed`.** It is added to the `commitment_status` enum (migration 0023). The chase job, the overdue alert and both briefs read `open` and `chased` only, so an unconfirmed commitment is never chased, alerted on or listed as waiting. The Commitments list leaves it out unless it is asked for by name. It has its own tab, "Might be owed to me", where the principal moves each one to open ("Owed to me") or drops it ("Not mine").
- **A definite repeat confirms.** When a later source makes the same promise definitely, the recorder moves the unconfirmed row to open instead of recording a second one, and the ledger says why.
- **The golden set gains the failure.** Fixtures cover a client promising a colleague on a group call (nothing expected), a promise to the room (possible) and a principal accepting an offer on a group call (definite). Scoring matches inbound items on their certainty too.

## Consequences

Some real inbound commitments now wait for a click before they are chased. That is the intended trade: a missed chase costs one click from the triage tab, and a wrong chase is an email about a promise nobody made to the principal. Outbound commitments are unchanged. Commitments recorded before this change keep their status; the principal can send one back to triage from its page by moving it to Unconfirmed. The extractor's version moves to 0.2.0 so eval runs and agent runs before and after are told apart.
