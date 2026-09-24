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

### [2026-09-23] Say where you are working before leaving the repo root

**Context**: Committing the roadmap to a new `docs/roadmap` branch while Dom's tree sat on `feat/github-deploy` with his uncommitted spec rename and new briefings. Claude created a git worktree in the session scratchpad and ran the commits there without saying so.
**Correction**: Dom stopped a command and asked why git was running in a tmp folder.
**Rule**: When the working tree holds Dom's uncommitted changes and the work needs another branch, ask how he wants those changes handled (commit, stash, move, or a worktree) before acting. If a worktree is the answer, say what it is, its path and why before the first command in it, and remove it when done.
**Applies to**: global, any branch work while the tree is dirty

### [2026-09-23] End a hand-over with numbered actions for Dom

**Context**: After deleting the untracked copies, Claude closed with a description of branch state and a suggestion ("ready for you to push", "I'd add the notes entry as a second commit") instead of saying what Dom should do.
**Correction**: Dom said it was not clear what Claude wanted him to do next.
**Rule**: Close any hand-over with a numbered list of Dom's actions, each with the exact command where one exists, followed by what Claude will do and what it is waiting on. State of branches goes above that list, not in place of it.
**Applies to**: global, every hand-over message

### [2026-09-24] Create worktrees for subagents by hand, from the working branch

**Context**: Launching three Phase 5 agents with the Agent tool's worktree isolation.
**Correction**: None from Dom; the agents stopped themselves. The tool cut each worktree from local `main`, which lags `origin/main` on this machine because `git fetch` fails over SSH, so none held the Phase 5 base. It also deleted each worktree and its branch as soon as the agent stopped unchanged, so a resumed agent had nowhere to work.
**Rule**: For parallel agents, create each worktree with `git worktree add ../lance-worktrees/<name> -b <branch> <working branch>` before launching, tell Dom the paths and branches, and pin each agent to its path in the prompt. Check the base commit before the agent starts.
**Applies to**: global, parallel subagent work

### [2026-09-24] A failing target is fixed at the cause, not by loosening the target

**Context**: The Phase 5 load test failed queue latency p95 (about two hours against 60 seconds for Monday mail at 30 principals). Claude recommended option D, amending the acceptance target, first.
**Correction**: Dom: "Isn't that just making the NFRs more tolerant?" The user-facing problem, a two-hour mail backlog, would have remained.
**Rule**: When an acceptance target fails, recommend the change that fixes the cause. Propose changing a target only when the target measures the wrong thing, say plainly that it loosens the requirement and what the user would then experience, and never lead with it.
**Applies to**: global, NFRs and acceptance criteria

### [2026-09-24] Cap long-running agent work in runs and wall time

**Context**: The load-test agent was briefed to measure, tune and rerun with no limit. One run took most of an hour, so it ran for over four hours and spent many tokens; Claude had estimated 45 to 90 minutes without knowing a run's length.
**Correction**: Dom asked why the load test was touching four hours and whether it used tokens.
**Rule**: Brief any long-running agent job with an explicit cap on runs and on wall time, and with "report and stop" when a target still fails. Find out how long one run takes before estimating. Check on an agent that passes its estimate rather than waiting.
**Applies to**: global, subagent briefs
