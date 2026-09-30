# 0036. Commitments are edited, reopened and annotated by hand

Date: 2026-09-26
Status: Accepted

## Context

Spec section 12 gives the Commitments page four actions: the two tabs, ageing, a chase button, mark done and drop with reason. The api treated done and dropped as final, and only the worker changed a commitment's description or due date. In use, the extracted description is sometimes wrong or vague, the due date moves after a conversation, a commitment marked done turns out not to be, and the principal has nowhere to keep what they learn about a commitment between its source and its close. The page also showed provenance as a record id only, so checking a commitment against its source meant leaving Lance.

## Decision

Each commitment has its own page, `/commitments/<id>`, reached from the list.

- **Status.** Any status moves to any other, including back from done or dropped. Dropping still needs a reason. `chased` is refused for a commitment never chased. Every move appends a `commitment_status` ledger event with the from and to statuses and any reason.
- **Edits.** The principal may change the description and the due date. The evidence quote and the source refs are never edited, so the claim can always be checked against the record (non-negotiable 5). A typed date is a day, read as 17:00 in `config.timeZone`, with due confidence 1. Changing the due date of a running inbound commitment moves its next chase to two days after the new date (the same grace the recorder uses, now `CHASE_GRACE_DAYS` in `@lance/shared`). An edit appends a `commitment_edited` event with each field's old and new value, and is refused if the row changed after it was read.
- **Notes.** A new table, `commitment_notes`, holds the principal's commentary. It is append-only as the ledger is: `lance_app` has SELECT and INSERT only, and row-level security is forced under the principal's scope (migration 0022). Every note is also a `commitment_note_added` ledger event, appended before the row.
- **Source context.** The page shows each cited source record from its newest observation that was not a removal: subject, sender and recipients for mail, title and participants for a meeting, and the passage around the evidence quote. It reads `observations` only and never calls a source system. Once retention has nulled the payload, the page says so and links to the source.

## Consequences

The status is no longer a one-way trail, so "done" on the page means done as of the last change, and the ledger is where the history lives. An edited description no longer matches the recorder's duplicate check (same direction, counterparty and description while open), so a later source repeating the same promise may record a second commitment; the principal drops one. The direction and the counterparty are not editable here, because either change moves `OWES` and `OWED_TO` edges in the ontology and the api does not write the graph; a mis-directed commitment is dropped with that reason. Notes are kept as long as the commitment and are not covered by a retention window; offboarding leaves them, as it leaves commitments.
