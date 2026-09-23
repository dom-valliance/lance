# 0014. Continuous deployment to dev from GitHub Actions

Date: 2026-09-23
Status: Accepted

## Context

Spec section 3.2 names GitHub Actions for CI and the Bicep what-if, and says nothing about how a build reaches an environment. Since the first dev deploy on 2026-09-21, steps 5, 6, 8 and 10 of `docs/runbooks/deploy.md` have been run by hand after every merge: three `az acr build` runs, an edit to `containerImageTag` in `infra/params/dev.bicepparam`, a subscription deployment, a manual start of the migration job, then a round of probes. The phase log records three deploys that reached a Running revision and were wrong anyway (an image that did not start, a job that was never run, failures visible only in `pgboss.job`), and the notes record a deploy reported from memory rather than from the log. Every one of those is a step a machine does the same way each time.

ADR 0007 keeps GitHub in Dom's hands: Claude uses plain git, and repository settings, environments and secrets are Dom's to set. The subscription already carries the Valliance pattern for this: an `sp-<project>-github-deploy` principal with Contributor and Role Based Access Control Administrator on the project's resource group, an `sp-<project>-github-plan` principal with Reader, both trusting GitHub's OIDC issuer through federated credentials rather than a client secret.

## Decision

A `Deploy` workflow (`.github/workflows/deploy.yml`) deploys `main` to dev. It runs after the `CI` workflow completes green on `main` (`workflow_run`) and by hand from the Actions tab (`workflow_dispatch`). It builds the three images in the runner from the same Dockerfiles and with the same smoke test the CI images job uses, pushes them to the environment's registry tagged with the short commit SHA, deploys `infra/main.bicep`, starts the migration job and waits for it, then verifies the result. The deploy, migrate and verify steps are the scripts `scripts/deploy.sh`, `scripts/run-migration-job.sh` and `scripts/verify-deploy.sh`, so the runbook's manual path and the workflow run identical code.

The image tag leaves the parameter files. `containerImageTag` is `readEnvironmentVariable('LANCE_IMAGE_TAG')` with no default in both `dev.bicepparam` and `prod.bicepparam`, so a deployment without the variable refuses to compile and no deploy ever edits a committed file.

The workflow runs as one user-assigned managed identity per environment, declared in `infra/deployer.bicep` and deployed by Dom, never by CI, because a deployment cannot grant its own identity the rights it is about to use. `id-lance-github-deploy-<env>` trusts the OIDC subject of the GitHub environment of the same name (the subject names the owner and repository with their numeric ids, as GitHub presents them) and holds Contributor on the resource group, Role Based Access Control Administrator on the group with an ABAC condition that limits it to the four roles `main.bicep` assigns, and a custom `Lance deployment writer` role at subscription scope that permits subscription-scope deployments, their what-if and nothing else. The identity has no secret.

The what-if runs in the deploy workflow, under that identity, immediately before the deployment, and the CI job on a pull request does not log in to Azure. The first design had a second, read-only identity for a what-if on every pull request; the first run showed that a what-if performs the same authorisation pre-flight as a deployment and reports `Authorization failed` for every resource a Reader cannot write. A pull request what-if would therefore need deploy rights on a `pull_request` token, which is the wrong trade.

The migration job runs as part of every automated deploy. This changes the rule in `infra/modules/migrate-job.bicep` and `deploy.md` that the job never runs as part of a deploy. Migrations are forward-only (CI rejects `DROP TABLE` and `DROP COLUMN`), Drizzle skips applied ones, the seed is idempotent, and the failure the notes record is the job not being run, not the job being run.

## Consequences

A merge to `main` reaches dev in about ten minutes with a verified result, and `dev.bicepparam` stops changing per deploy. The GitHub environment `dev` is the control point: its `AZURE_CLIENT_ID` secret names the deploy identity, and a branch restriction there is what stops a manual dispatch from another branch.

A pull request that changes `infra/` is reviewed on its diff, its Bicep build and lint, and the role guard; the what-if for it appears in the deploy log after the merge, not before. Spec 3.2's "Bicep what-if" in CI is met there.

The apps move to the new image before the migration job runs, a window of about a minute in which an app that needs a new table fails at its first use of it. Additive migrations make that benign; a migration that must precede its code needs a two-step deploy and this ADR revisited.

Any new role assignment in `main.bicep` needs its role id added to `assignableRoleIds` in `infra/deployer.bicep` and that template redeployed before the deploy identity can create it. `scripts/check-deployer-roles.sh` fails CI when the two lists disagree.

What the pipeline cannot see from outside stays a manual read after any deploy that changes the worker: failed rows in `pgboss.job` and failed `agent_runs` (`docs/runbooks/observing.md`).

Prod is not wired. It needs `infra/params/deployer-prod.bicepparam`, a GitHub environment `prod` with a required reviewer, and a second deploy job in the workflow that runs on dispatch only and deploys a tag dev has already run.
