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

### [2026-09-21] Never fix infra by hand that the template will later own

**Context**: To unblock Dom on Key Vault I created a Secrets Officer role assignment from the CLI, then added the same assignment to the Bicep. The next deploy failed with RoleAssignmentExists because Azure keys assignments by name and the template's deterministic name differed from the hand-made one.
**Correction**: Dom pasted the failed deployment.
**Rule**: When a gap is found in the template, fix the template and redeploy; the deploy is the unblock. If a hand-made change is unavoidable, record it as a step to undo before the next deploy and put that in the runbook at the same time.
**Applies to**: infra/

### [2026-09-21] Probe deployed endpoints, not just revision state

**Context**: After the image flip the api revision showed Running. A curl of the web app showed the sign-in callback pointing at 0.0.0.0:3000 because AUTH_URL was never set and no AUTH_SECRET was bound; a local image start had shown the same and I had not read the redirect target.
**Correction**: Found while checking Dom's step 6 output.
**Rule**: A Running revision proves the process started, nothing more. After every deploy, request each public endpoint and read the full response, redirect targets included, and compare against what a user would do next (sign in, run a command). Framework env that only matters in production (AUTH_URL, secrets the framework reads implicitly) belongs in the Bicep bindings from the first draft; check the framework's production checklist when writing the template.
**Applies to**: global

### [2026-09-21] A runbook step that connects from Dom's machine needs the network path templated

**Context**: Deploy step 7 asked Dom to run psql against the Flexible Server from his Mac. The template's firewall admits Azure services only, so the connection timed out. The Bicep comment even said "Dom adds his own client IP by hand", which contradicts the rule recorded earlier the same day.
**Correction**: Dom pasted the psql timeout.
**Rule**: Any runbook step run from outside Azure must have its network path (firewall rule, private endpoint, or a jump host) declared in the template, fed from an environment variable at deploy time when the value is personal or changes, and removed by redeploying without it. Read the template's own comments for "by hand" and treat each one as a gap to close.
**Applies to**: infra/

### [2026-09-21] Azure Flexible Server differs from the local image in ways only a real run shows

**Context**: The migration job failed on Azure with "access to library age is not allowed" because migration 0000 ran LOAD 'age'; Azure preloads restricted libraries through shared_preload_libraries and forbids LOAD. The pgaadauth_* functions also live only in the postgres maintenance database, not in lance. Both passed locally and in the container suites.
**Correction**: Found from the failed job log and Dom's psql error.
**Rule**: Before the first migration against a managed Postgres, list every statement that touches server internals (LOAD, extensions, roles, ownership, search_path) and check each against the provider's documented restrictions; set preload parameters in the template and note that static parameters need a restart. Runbook steps that use provider admin functions say which database to connect to.
**Applies to**: infra/, packages/db/drizzle/

### [2026-09-21] First deployment day, consolidated

**Context**: Seven error reports from Dom during the first dev deployment, each recorded above: git-less `prepare` script, missing `.dockerignore`, unbuilt web image, hand-made role assignment colliding with the template, missing `AUTH_URL` and `AUTH_SECRET`, Postgres firewall blocking psql, and Azure rejecting `LOAD 'age'` with the `pgaadauth_*` functions living only in the `postgres` database.
**Correction**: All seven were error pastes, not instructions; every one was a gap between what passed locally and what the managed platform does.
**Rule**: Treat the first deployment of any environment as a test run to be driven end to end by Claude before Dom touches it: build every image, deploy, restart for static parameters, run the job, probe every endpoint, and sign in. Each provider restriction found goes into the template and the runbook the same day.
**Applies to**: global

### [2026-09-21] Superuser tests hide privilege checks, and the migrator hides the error

**Context**: Migration 0002 reassigns table ownership to lance_migrator. On Azure the migrate identity is not a superuser, so Postgres enforced that the new owner must hold CREATE on the schema, which lance_migrator did not. The local suites run as the container superuser and never exercised that check. The drizzle migrator reported the failure only as "Connection terminated unexpectedly" from a checked-out client, and I spent a round chasing tokens and TLS before bisecting the migrations statement by statement against the real server.
**Correction**: Found by probing after Dom's job failures; no user instruction.
**Rule**: Run at least one integration test of the migrations as a non-superuser member of lance_migrator so ownership and grant checks are exercised. When a managed platform reports only a dropped connection, bisect the actual statements against it before theorising about the transport. The migrator now prints the underlying query error.
**Applies to**: packages/db/

### [2026-09-21] Libraries that self-install need privileges the runtime role may lack

**Context**: The worker failed to start on Azure with "permission denied for database lance": pg-boss runs CREATE SCHEMA IF NOT EXISTS on every start, and Postgres checks CREATE on the database before it checks whether the schema exists. Locally the worker test runs as the superuser.
**Correction**: Found in the worker log after the first successful migration.
**Rule**: For any library that manages its own schema at runtime (pg-boss, drizzle, OTel exporters), read what it executes on start and grant exactly that in a migration. Run the integration suites as the roles the platform will use, not as the superuser.
**Applies to**: packages/db/, apps/worker/

### [2026-09-21] Two public hostnames invite the wrong one in a manifest

**Context**: `/lance status` in Slack returned the web app's sign-in page. The Slack app had been created with the web hostname in the slash command URL; the manifest placeholder said `<api-hostname>` but nothing made the two hostnames hard to confuse.
**Correction**: Dom pasted the HTML reply.
**Rule**: When a runbook has a placeholder that could be filled with the wrong one of two similar values, print the exact command that produces the right value directly above it and say which value is wrong. Verify a third-party integration end to end from the third party's side (send the real command) before declaring the surface ready, and record the fix path for an app already created with the wrong value.
**Applies to**: docs/runbooks/

### [2026-09-21] The first CI run must be exercised with the tools CI uses

**Context**: The first GitHub Actions run failed twice. The workflow calls the standalone `bicep` CLI, which takes the file positionally, but every local check had used `az bicep build --file`, a wrapper with different arguments. And `next.config.ts`, outside the `src` globs, had no Node globals, so a `URL` call I added after the last full lint failed only in CI.
**Correction**: Dom pasted the CI log.
**Rule**: Before the first push, run the exact commands in the workflow with the exact binaries it installs (the standalone CLI, not the `az` wrapper), and run the full root lint after every edit, not the package filter. A file that ESLint parses without a matching config block is a gap; every `.ts` file gets the same globals.
**Applies to**: .github/, eslint.config.js

### [2026-09-21] Rebuild every image whenever a workspace dependency changes

**Context**: The first registry build after the Phase 1 merge failed. Each Dockerfile copies an explicit list of workspace sources; Phase 1 added @lance/connectors to the api, @lance/agents, @lance/connectors and @lance/policy to the worker, and an api type import to the web app, and none of the three Dockerfiles was updated or rebuilt. CI was green because it never builds an image.
**Correction**: Dom pasted the `az acr build` log.
**Rule**: A Dockerfile that enumerates sources is coupled to every `workspace:*` dependency and every cross-app type import; when either changes, update the Dockerfile and build the image locally before the phase is called done. Image builds are part of every phase's verification, not only the deploy runbook, and CI builds all three Dockerfiles on every pull request so the gap cannot recur silently.
**Applies to**: apps/*/Dockerfile, .github/workflows/ci.yml

### [2026-09-21] Run the worker's boot path against real pg-boss before deploying

**Context**: The first Phase 1 worker start in Azure crashed: pg-boss rejects a colon in a queue name or schedule key, and the watcher queues were named `watcher:<name>`. Every unit test passed because none registered a watcher with pg-boss; only `main.ts` did, and `main.ts` had never run with Graph configured.
**Correction**: Dom reported that nothing new appeared after the deploy; the worker log showed the assertion.
**Rule**: Every registration `main.ts` performs (queues, schedules, workers) has a test that performs it against real pg-boss in a container. When a boot path only runs with credentials that are absent locally, stub the credentials and run it anyway. After a deploy, read each container's console log, not only its revision state.
**Applies to**: apps/worker/src/main.ts, apps/worker/src/watchers/

### [2026-09-21] Chain every Flexible Server child resource in series

**Context**: The redeploy after the Phase 1 merge failed on the `log_connections` configuration with ServerIsBusy. The template had two resources depending on the same parent (the database and the `shared_preload_libraries` write, then the firewall rules and `log_connections`), so ARM started them in parallel and Flexible Server, which accepts one management operation at a time, refused the second. The first deploy had passed by timing.
**Correction**: Dom pasted the deployment error.
**Rule**: On a Postgres Flexible Server, every child resource (administrator, configuration, database, firewall rule) depends on the one before it, forming one chain, never a fan-out from the parent. Treat any ServerIsBusy as a template ordering fault, not a transient to retry.
**Applies to**: infra/modules/postgres.bicep

### [2026-09-21] Verification output is read by exit code, never by grep

**Context**: The consent button branch failed CI lint on two unused parameters. The local check had piped eslint through `grep -E "error|✖"` and printed "checks done" regardless of the exit code, and the lines that mattered were lost.
**Correction**: Dom pasted the CI log.
**Rule**: A verification command is judged by its exit code, with its last lines shown unfiltered. Never pipe lint, typecheck or test output through a grep that can drop the failure, and never print a success message after a pipeline whose exit status was not checked.
**Applies to**: global

### [2026-09-21] Every control needs a caller and every setting a reader

**Context**: Dom ran pause and resume in dry run and the proposals stayed held, as designed, but nothing outside the tests called `SystemControl.setMode`, so dry run could never end, and the three write feature flags were parsed from the environment but read by nothing. Both were listed as done in the plan because the code and the config existed.
**Correction**: Dom asked what happens next and whether more had to be built.
**Rule**: A control (mode, kill switch, flag) is only done when the path Dom uses to work it exists (Slack command, admin route or page) and the code that must obey it reads it. Grep for the reader before calling a config value done; a value with no reader is a gap, not a feature. The going-live sequence in the deploy runbook is the checklist.
**Applies to**: apps/api/src/slack, apps/api/src/routes/admin.ts, apps/worker/src/executor

### [2026-09-21] Say what a deployment contains from the log, never from memory

**Context**: I built and deployed main at 0978615 and told Dom it carried the shared role fix and the inline error handling. Those were on `fix/pgboss-shared-role`, which had not been merged; the merged branch was the mode switch. Dom found out when the runbook step named a script that did not exist on main.
**Correction**: Dom: "There is no scripts/psql-admin.sh".
**Rule**: Before building or deploying, run `git log main..<branch>` for every branch handed over that day and list, in the message to Dom, exactly which commits the tag contains and which are still unmerged. A deployment report names the SHA and what is in it; it never assumes a branch was merged because a merge happened.

### [2026-09-21] Runtime database objects belong to the shared role, never to one identity

**Context**: The first approval in the web app failed with "permission denied for table version". pg-boss had created its tables under the worker's Container App identity, and the api's identity, a member of the same `lance_app` role, could not read them. Membership grants a role's privileges, not ownership of what a member creates.
**Correction**: Dom reported the failed approval.
**Rule**: Every app session starts as the shared role (`PG_ROLE=lance_app`, applied by the db client through the connection options) so anything created at runtime is owned by `lance_app`. Anything else that creates objects at runtime gets the same treatment. An environment that predates the setting is repaired once with `REASSIGN OWNED BY "<identity>" TO lance_app`, and the runbook records it.
**Applies to**: packages/db/src/client.ts, infra/modules/containerapps.bicep, docs/runbooks/deploy.md

### [2026-09-21] A failure message never travels in a URL

**Context**: The proposal decision actions redirected back to the page with the failure in an `error` query parameter, so the message landed in access logs, browser history and bookmarks and reappeared on every refresh.
**Correction**: Dom: "errors should not be passed in as query string params".
**Rule**: A server action answers `useActionState` with its failure and the form renders it from React state. No redirect carries a message, an error or anything user-facing in the query string.
**Applies to**: apps/web

### [2026-09-21] The admin firewall rule is one address and goes stale with the network

**Context**: psql to the dev server timed out for Dom and for me. The `AllowAdminClient` rule still held the morning's public IP; the address had changed during the day.
**Correction**: Dom pasted the timeout.
**Rule**: A psql timeout against Flexible Server is checked first against the current public IP and the `AllowAdminClient` rule. The fix is `export LANCE_ADMIN_CLIENT_IP=$(curl -s https://api.ipify.org)` and a redeploy, never a hand-edited rule. The runbook says to take the value from `curl` every time.
**Applies to**: docs/runbooks/deploy.md, infra/modules/postgres.bicep

### [2026-09-21] The template owns no client firewall rule

**Context**: The single-address rule from `LANCE_ADMIN_CLIENT_IP` went stale within a day because Dom moves between home, work and elsewhere. Supersedes the entry above about refreshing the variable.
**Correction**: Dom: "I will not always be on the same IP as I move between work and home".
**Rule**: Access for a laptop is opened per session by `scripts/psql-admin.sh`, which adds a rule for the current address, waits for it, runs psql with an Entra token, and removes the rule on exit. The template's only firewall rule is the Azure services one. Anything tied to where a person happens to be is never a deployment parameter.
**Applies to**: scripts/psql-admin.sh, infra/modules/postgres.bicep, docs/runbooks/deploy.md

### [2026-09-22] An image that builds is not an image that starts

**Context**: The Phase 2 deploy at 7bd63f5 succeeded, then the api and worker crashed at start with ERR_MODULE_NOT_FOUND on @lance/ontology: the new package was never added to the two Dockerfiles' source lists. CI's image job built all three images green, because a Dockerfile that omits a source directory still builds; the failure only exists at start-up.
**Correction**: Found by reading the worker console log after the deploy, as the gotcha says; Dom saw nothing new.
**Rule**: CI runs every image it builds: the api and worker import their entry module inside the container (`scripts/smoke-image.sh`), the web image is started and asked for a page. A new `workspace:*` dependency is not done until that step passes. The migration job is started by hand after a deploy that adds a migration; the deploy alone never runs it.
**Applies to**: .github/workflows/ci.yml, scripts/smoke-image.sh, apps/*/Dockerfile, docs/runbooks/deploy.md

### [2026-09-22] The verification set is every CI step, formatting included

**Context**: The web design branch passed root lint, typecheck, test and build locally and then failed CI on `pnpm format:check`: nine files written by heredoc and by subagents had never been through Prettier.
**Correction**: Dom pasted the CI log.
**Rule**: Before calling a branch done, run every command the workflow runs, read from `.github/workflows/ci.yml` rather than from memory; today that is lint, format:check, typecheck, test, build and the image builds. A subagent's "prettier was run over my files" is not evidence; the root `pnpm format:check` is.
**Applies to**: global

### [2026-09-22] Built-in role ids come from the CLI, never from memory

**Context**: The first Phase 3 deploy failed with RoleDefinitionDoesNotExist: the Log Analytics Reader role assignment in containerapps.bicep carried a GUID recalled from memory, right in its first segment and wrong after that. The three apps had already moved to the new image when the assignment failed, so the deploy left dev half applied until the template was fixed and rerun.
**Correction**: Self-found on reading the deployment error; fixed in the template and redeployed rather than assigning the role by hand.
**Rule**: Every built-in role definition id in Bicep is read with `az role definition list --name "<role>"` at the time it is written, and the command that yields it goes in the comment above the variable. Role assignments come last in a module, so a failing one does not strand the apps on a new image while the rest of the deploy is unverified.
**Applies to**: infra/modules/*.bicep
### [2026-09-22] A deploy is verified by the jobs it runs, not by the start-up line

**Context**: Phase 3 went to dev with the worker's start-up block clean and every endpoint answering. Within the hour every Slack post was failing, every detector job was failing after writing its alert, the Haiku labeller had failed 15,000 times and the spend ceiling had been reached. None of it reached the console log because pg-boss keeps job failures on the job row.
**Correction**: Dom asked how to track what was going on and why a brief never arrived.
**Rule**: After a deploy, query `pgboss.job` for failed states and `agent_runs` for failed runs before calling it verified, and fire one real instance of each new surface (an alert card, a brief) from the deployed system. Every queue handler logs its failure. A model id that a request feature does not support (adaptive thinking on Haiku) is a 400 on every call, so a new agent's first live run is checked in `agent_runs` the same day.
**Applies to**: apps/worker, docs/runbooks/observing.md, docs/runbooks/deploy.md
