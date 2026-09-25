# 0033. Shared nodes carry no private provenance

Date: 2026-09-24
Status: Accepted

## Context

ADR 0017 puts observed Persons, Organisations and Meetings in the shared layer, justified by exact keys. The Phase 4 review (`docs/adr/0000-phase-log.md`, 2026-09-23) found four ways the shared layer still carries one principal's evidence: shared nodes keep `source_refs` naming the mailbox message or Jamie meeting that showed them; a transcript's name-only attendee becomes a shared Person with no exact key; a shared Meeting keeps the observing principal's `jamie_id` once it has an `iCalUId`; and a meeting Jamie saw before the principal's calendar did stays behind as a Jamie-keyed Meeting beside the `iCalUId` one. Each is harmless with one principal and a leak or a duplicate with two.

## Decision

A shared node's `source_refs` carry only `system` and `observedAt`; the record id and URL of a sighting live on the principal's private edges to it (`ATTENDED`, `PARTICIPATED_IN`, `MENTIONS`), as a meeting's Jamie id already does. A Person seen with no exact key (no email, Slack id, Notion user id or Jamie participant id) is created in the principal's private layer, and joins the shared layer only by a later exact-key match or a `promote_to_shared` decision. A shared Meeting keeps no `jamie_id` once it has an `iCalUId`. When a principal's calendar supplies the `iCalUId` for a meeting that principal's Jamie observation keyed on its Jamie id, the two nodes merge into the `iCalUId` one as a recorded mutation. A backfill applies all four to the existing graph, idempotently, as recorded mutations.

## Consequences

Another principal can see that a person exists and when Lance first learnt of them, and not whose mailbox showed them or in which message. Provenance for briefs and alerts is unchanged, because they cite observations, not graph refs. Name-only attendees stop polluting the shared directory. This must land before the pilot's first principal is onboarded (roadmap, Pilot).
