# Project Learnings

### [2026-09-19] GitHub is Dom's, git is Claude's

**Context**: Setting up Phase 0 tooling; Claude started `brew install gh` so PRs could be opened from the terminal.
**Correction**: Dom rejected it: "No. just use git. I'll do the github stuff."
**Rule**: Use plain git only for branches, commits and pushes. Never install or use the `gh` CLI, never open PRs. Hand over branch names and commit ranges; Dom creates the remote, PRs and merges.
**Applies to**: global

### [2026-09-21] Runbooks must follow the dependency order

**Context**: The Entra and Slack runbooks told Dom to store secrets in Key Vault and to paste the api hostname into the Slack manifest before the deployment that creates both had run.
**Correction**: Dom: "Problems with entra setup. Where is the key vault setup?" and "There's a race condition on slack creds as well."
**Rule**: Before writing a runbook, list what each step reads and what produces it, and order the steps so nothing is consumed before it exists. Say up front which other runbook must run first. Values that are identifiers, not secrets (tenant id, client id, UPN, object id, Slack user id), go straight into the parameter files and the runbook's known-values table so Dom is never asked for them twice.
**Applies to**: global
