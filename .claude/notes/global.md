# Project Learnings

### [2026-09-19] GitHub is Dom's, git is Claude's

**Context**: Setting up Phase 0 tooling; Claude started `brew install gh` so PRs could be opened from the terminal.
**Correction**: Dom rejected it: "No. just use git. I'll do the github stuff."
**Rule**: Use plain git only for branches, commits and pushes. Never install or use the `gh` CLI, never open PRs. Hand over branch names and commit ranges; Dom creates the remote, PRs and merges.
**Applies to**: global
