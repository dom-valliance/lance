# 0009. Tasks have one home in Notion

Date: 2026-09-19
Status: Accepted

## Context

Spec section 5.1 defines `tasks_ian` for tasks with no home in Notion or Jamie, and section 9.2 has `/ian task` create such a task automatically. Section 12 aggregates tasks across Notion, Jamie and Ian-native with source badges. Dom's instruction on 2026-09-19: tasks are aggregated into the Notion All Tasks DB under his name. Jamie tasks allocated to someone else also go into that DB under his name, with the delegated person's name in brackets in the task title.

The All Tasks DB (database `20257534-6e48-8190-9ebb-cfb6997b3bb4`, data source `20257534-6e48-81fe-b4b5-000b69ecace6`) has these properties Lance can set: Title, Status (Not Started, In Progress, On hold, Done, Cancelled, Archived), Assignee, Contributors, Due, Priority (Low, Medium, High, Critical Milestone), Project, Type, Sub-type, Description, Notes. It also has formulas, rollups, Hubspot Task ID, Leads and Opportunities, Thread Sessions, Files and media, and a `Delegate to Ian` checkbox. Dom's Notion user id is `1fdd872b-594c-8146-b22f-00028f1f5a41`. Jamie's REST API cannot create tasks (ADR 0005).

## Decision

The Notion All Tasks DB is the system of record for every task Lance creates. `tasks_ian` is not built. `/lance task <text>` always produces a Notion `create_task` proposal. Jamie action items become Notion `create_task` proposals with Dom as Assignee. When the Jamie item is assigned to someone other than Dom, the title ends with the delegate's name in round brackets, for example `Send revised SOW (Alice Smith)`, and the delegate is added to Contributors when they resolve to a Notion user. Mail-derived task candidates from triage take the same path, so the Notion task connector is built in Phase 1.

The ontology `Task` node is the aggregation index: one node per task with `source_refs` for the Jamie item, the Notion page and any mail thread. A Jamie item whose node already carries a Notion ref is not proposed again.

Lance writes only the eleven properties named above. It never writes Hubspot Task ID, formulas, rollups, Leads and Opportunities, Thread Sessions or Files and media, and it never changes the database schema. Updates touch only properties Lance set or Dom approved in the proposal preview, per non-negotiable 8. The `Delegate to Ian` checkbox is read and surfaced in the brief; acting on it is a v2 candidate.

## Consequences

One place to look for everything Dom owes and everything he has delegated. The Tasks page reads ontology `Task` nodes with source badges and offers `Mirror to Notion` for Jamie items not yet mirrored. `create_task` for `self` and `internal` counterparties stays at `propose` per the seed rules; a promotion can move it to `auto` later. The permitted-properties list lives in config and the critic checks it before any Notion write.
