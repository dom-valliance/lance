# 0017. The ontology has reference, shared and private layers

Date: 2026-09-23
Status: Accepted

## Context

Spec section 5.2 describes one graph for one person. With more than one principal, the same graph holds facts everyone may see (an external person's name, a meeting's title and time) next to evidence only one person's mailbox or transcripts showed (who emailed whom, what was tagged, what was promised). The Phase 4 briefing (`docs/plans/ontology.md`, sections 2.1 and 2.7) splits the graph into three layers. ADR 0015 puts the relational tables under row-level security, but AGE stores vertices and edges in per-label tables that AGE's own functions read, so RLS on them is fragile. At `ea60797` meetings key on `graph_event_id`, which is specific to one mailbox, so two principals at one meeting would produce two Meeting nodes.

## Decision

Every node and edge carries a `layer` property, one of `reference`, `shared` or `private`, and a `principal_id` that is null except on `private`.

- `reference`: facts held elsewhere (Foundry, ADR 0016). Lance holds key nodes and the edges between them. The layer is declared now and populated in Phase 7.
- `shared`: what the organisation has learned. Persons and Organisations Lance has observed, Meetings as facts (title, start, end, organiser), Tasks from the Notion All Tasks database, which the whole team can see.
- `private`: one principal's evidence. Threads, Commitments, Documents, Jamie Tasks, and every edge that records an observation (`ATTENDED`, `MENTIONS`, `PARTICIPATED_IN`, `DERIVED_FROM`, `ABOUT`, `OWES`, `OWED_TO`, `ASSIGNED_TO`).

A Meeting is keyed on the calendar `iCalUId`, which every attendee's mailbox shares, so one meeting is one shared node. The per-mailbox `graph_event_id`, the Jamie transcript reference and the Jamie tags move to the principal's `ATTENDED` edge. A Jamie meeting with no matching calendar event keys on its Jamie id.

Scoping lives in `OntologyRepository`. It is constructed with a `PrincipalScope`. Every read returns reference and shared nodes plus private nodes, edges and properties whose `principal_id` equals the scope. Every write stamps the scope's principal on private nodes and edges; a caller cannot name another principal. `runCypher` and `sqlRunnerOf` become internal to `packages/ontology`, and an ESLint rule stops any import of them from outside. An isolation harness writes private evidence for two principals and asserts that no public method returns the other's.

A write to the shared layer that starts from one principal's evidence is a promotion: action class `promote_to_shared`, decided by a person, executed as a recorded graph mutation. Its hard floor is `propose`: no rule can make it `auto` (ADR 0019). A write the executor makes as part of an approved proposal, such as the `ACTIONED_AS` edge after a Notion task is created (Phase 5), already traces to a decided proposal and needs no second one. Observed Persons and Organisations are written to the shared layer directly by resolution, as today, because they come from exact keys, not from one principal's judgement.

## Consequences

One principal's mailbox cannot leak into another's briefs through the graph, provided every graph read goes through the repository, which the lint rule enforces. Readers of `graph_event_id`, `transcript_ref` and `tags` (briefs, debrief, detectors) move to the edge. The backfill that sets `layer`, `principal_id` and `ical_uid` on existing nodes runs as recorded mutations so rebuild reproduces it. Shared Persons carry no principal, so a name and an email seen in one mailbox become visible to other principals; that is the intended shared layer and is listed in the data map (Phase 5, M7).
