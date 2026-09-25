# 0035. Principal identity per context, and who may change shared facts

Date: 2026-09-25
Status: Accepted

## Context

The Phase 5 review found that several paths still assumed one principal. Every job context passed `config.dom` (Dom's name and email) as the person Lance acts for, so a second principal's triage upserted Dom's Person node, overwrote its Notion user id, and named Dom in the commitment prompts over her transcripts. The ADR 0017 backfill ran in every principal's context and took every unlayered item to be the scope's. ADR 0017 keys a meeting with no calendar event on its Jamie id and puts it in the shared layer, although only one principal's recording knows of it. Any principal's Jamie observation rewrote a shared Meeting's title and times, `mergeMeeting` checked and deleted in separate transactions, one principal's sighting rewrote a shared Person's organisation and role, and any principal could decide another's `SAME_AS` candidate.

## Decision

**Identity.** Each principal context builds a `PrincipalIdentity` (`@lance/shared`) once: the UPN as the email, the Notion user id from the principal's credential or row, and a display name. `principals` carries no name yet, so the legacy owner (the principal whose UPN is `config.dom.email`) keeps `config.dom.name` and anyone else is named from the local part of their UPN. The identity replaces `config.dom` wherever it meant the person Lance acts for: triage, commitments, the debrief, the detectors, the briefs, the api's ontology. `config.dom` stays where it means Dom: the legacy credentials, his Slack channel before his link, the admin until roles, `DOM_EMAIL` checks.

**Legacy backfill.** `backfillLayers` takes the legacy owner's id and does nothing in any other scope. The worker runs it once at boot, in the owner's scope, before any job handler or principal context exists. Shared `SAME_AS` candidates on the legacy graph become the owner's.

**Meetings.** A meeting keyed only on a Jamie id is private to the principal whose Jamie saw it. When their calendar supplies the iCalUId it becomes shared and keeps its title, start and end, the facts ADR 0017 lists for a shared Meeting, and loses its Jamie id to the principal's edge. On a shared Meeting a Jamie observation fills only a missing fact; a calendar (`graph`) observation may change them. `mergeMeeting` runs its scan, copies and delete in one transaction holding an advisory lock on the node, which every write that attaches an edge to or changes a Meeting also takes, and checks again for another principal's edge just before the delete.

**Persons and candidates.** On an existing Person, the Slack id, Notion user id, organisation, role and internal flag keep the held value and are filled only where empty. The fields a principal's sighting filled on a shared Person are listed in `set_fields` on that principal's private `OBSERVED` edge. A `SAME_AS` edge with status `candidate` is private to the principal who wrote it, and `setSameAsStatus` changes only the scope's own edge.

## Consequences

A second principal's jobs speak for her and write only her own Person. A meeting Jamie recorded for one principal is invisible to others until a calendar makes it a shared fact. Nothing writes Meetings from the calendar watcher yet, so in practice the first sighting's title stands on a shared Meeting until one does; that is the intended precedence, and a principal's Jamie can no longer rename it. A shared Person's first known organisation and role stand until corrected deliberately; there is no correction path yet beyond a recorded mutation. The UPN-derived display name is an interim until the principal row carries a name (M6).
