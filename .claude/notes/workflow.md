# Workflow notes

Append-only. Lessons from corrections during the Lance build.

## 2026-09-19: GitHub is Dom's, git is Claude's

Correction: Dom rejected `brew install gh` with "No. just use git. I'll do the github stuff."

Lesson: use plain git for branches and commits. Do not install or use the `gh` CLI, do not open PRs. Hand over branch names and commit ranges. ADR 0007 updated.

### [2026-09-23] Bulk data changes need a second look even after a yes

**Context**: 219 noisy commitments had been extracted into the dev database. Claude proposed one SQL statement marking every open row dropped; Dom said yes; the statement ran (242 rows by then). Dom then asked for them back so he could resolve each one on the Commitments page.
**Correction**: "This drop was a bit too aggressive. I'd like them back so I can go through them and mark them as done or dropped manually."
**Rule**: Before a bulk change to rows Dom would otherwise handle one at a time, say the count, name the per-row alternative the UI already offers, and prefer a form that can be undone (a status change stamped with one `updated_at`, never a delete). A raw SQL change also skips the `resolved` ledger events the UI writes, so say that too. A yes to the plan is not a yes to the scale.
**Applies to**: global; any statement over the dev or prod database that touches more than a handful of rows.
