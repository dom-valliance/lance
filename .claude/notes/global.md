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

### [2026-09-21] Name managed resources by what creates them, and read identifiers yourself

**Context**: The Entra runbook said "Postgres Flexible Server" and "Key Vault" as if Dom would recognise and create them, and asked him for his UPN, object id and Slack user id.
**Correction**: Dom: "What is the allowed-upn value? Where can I find that? What is the Flexible Server for PostGres?"
**Rule**: In a runbook, the first mention of an Azure resource says which template creates it and whether Dom does anything by hand. Any identifier Claude can read from a logged-in CLI or connector (`az account show`, `az ad signed-in-user show`, the Slack session user id) is read by Claude and written into the parameter files and the runbook's known-values table, never delegated to Dom.
**Applies to**: global

### [2026-09-21] Exercise every runbook step before handover

**Context**: The deploy runbook's step 5 built three images and step 6 asked for "the short SHA used in step 5", which was hidden inside a command substitution. Dom: "There doesn't appear to be a short SHA in step 5." Pulling on it found the worker Dockerfile did not exist, the api image lacked the telemetry source it imports, the migration job invoked pnpm which the runtime image does not carry, and the Postgres principals were created after the job that needed them.
**Correction**: Dom's one observation; the rest were latent failures he would have hit in sequence.
**Rule**: Before handing over a runbook, run each step that names a file or command: build every image it references and start it far enough to fail only on the missing dependency, run every command in a throwaway container, and trace what each step consumes back to the step that produces it. A value a later step reuses is captured once in a named variable and echoed, never left inside a substitution. Subagent-written infra and runbooks get the same treatment before the phase closes; a validated template is not a validated deployment.
**Applies to**: global

### [2026-09-21] Build every image the way Azure builds it, not just some of them

**Context**: `az acr build` for the web image failed on the root `prepare` script (`git config` in a container with no git), uploaded 413 MiB because there was no `.dockerignore`, and the web Dockerfile had never been built at all. The day before I had built the api and worker images and stopped there.
**Correction**: Dom pasted the failing build log.
**Rule**: "Exercise every runbook step" means every image, not a sample. Root lifecycle scripts (`prepare`, `postinstall`) must tolerate a container with no git and no repository. Every repo with a Dockerfile gets a root `.dockerignore` before the first remote build. A local `docker build` is the minimum; when the remote builder differs (ACR packs the context itself), check the context size it reports too.
**Applies to**: global
