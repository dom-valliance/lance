# Runbook: connect GitHub Actions to Azure

Run once per environment. After it, every merge to `main` deploys itself to dev through `.github/workflows/deploy.yml`, and every pull request's what-if in `.github/workflows/ci.yml` runs against the real subscription. ADR 0014 records the decision.

Run `deploy.md` steps 1 to 4 first: the resource group and the registry must exist, because the identities live in that group and their roles are scoped to it. Everything here runs from the repo root as Dom, signed in with `az login`. Dom is an Owner of the subscription, which the template needs: it creates two custom role definitions and grants Role Based Access Control Administrator, and only an Owner or User Access Administrator may do either.

## What gets created

`infra/deployer.bicep` (subscription scope) with `infra/params/deployer-dev.bicepparam` creates, in `rg-lance-dev`:

| Resource | Purpose |
| --- | --- |
| `id-lance-github-deploy-dev` managed identity | What `deploy.yml` runs as. Contributor on the group; Role Based Access Control Administrator on the group, limited by condition to the four roles `main.bicep` assigns (AcrPull, Key Vault Secrets User, Key Vault Secrets Officer, Log Analytics Reader); the custom `Lance deployment writer` role at subscription scope, which allows subscription deployments and nothing else. |
| Federated credential `github-environment-dev` on it | Trusts tokens from GitHub whose subject is `repo:dom-valliance@215853107/lance@1378678734:environment:dev`. No client secret exists. |
| `id-lance-github-plan-dev` managed identity | What the CI what-if runs as. Reader on the group and the custom `Lance deployment reader` role at subscription scope. |
| Federated credentials `github-pull-request` and `github-branch-main` on it | Subjects `repo:dom-valliance@215853107/lance@1378678734:pull_request` and `repo:dom-valliance@215853107/lance@1378678734:ref:refs/heads/main`, the two contexts `ci.yml` runs in. |

The numbers in the subjects are the owner id and the repository id. GitHub appends them to the names in every token it issues for this repository, and Entra compares the whole string, so a credential written without them never matches. Both ids are in `infra/params/deployer-dev.bicepparam`; if the repository is ever transferred or recreated, read the new ones from the `subject claim` line that azure/login prints on the failed run and redeploy step 1.

Nothing in `main.bicep` changes, and the template touches nothing that `main.bicep` owns. CI never deploys this template.

## 1. Deploy the identities

Read the plan, then deploy:

```
az deployment sub what-if \
  --location uksouth \
  --template-file infra/deployer.bicep \
  --parameters infra/params/deployer-dev.bicepparam

az deployment sub create \
  --name lance-deployer-dev \
  --location uksouth \
  --template-file infra/deployer.bicep \
  --parameters infra/params/deployer-dev.bicepparam
```

The what-if lists twelve creations and fifteen resources to ignore. Anything reported as a modification of an existing resource is a fault in the template; stop and read it.

## 2. Read the values GitHub needs

Three identifiers and none of them secret. Print them:

```
az deployment sub show -n lance-deployer-dev \
  --query "properties.outputs.{tenantId:tenantId.value, subscriptionId:subscriptionId.value, planClientId:planClientId.value, deployClientId:deployClientId.value}" \
  -o table
```

Known values:

| Name | Value |
| --- | --- |
| Tenant id | `ac995b50-b931-4d4b-b0ea-c0617e8141f9` |
| Subscription id | `d28312a1-6e66-4302-ac89-510f2d686a12` |
| GitHub owner id | `215853107` (in the parameter file; part of every OIDC subject) |
| GitHub repository id | `1378678734` (same) |
| Plan client id | From the command above (`planClientId`). Created by the deploy, so it is not known before step 1. |
| Deploy client id | From the command above (`deployClientId`). Same. |

The plan client id and the deploy client id are easy to confuse and both end up in a secret named `AZURE_CLIENT_ID`. The plan id goes at repository level; the deploy id goes in the `dev` environment. Swapping them fails loudly at the token exchange (`AADSTS700213`, no matching federated identity), because each identity trusts a different subject.

## 3. Configure the repository

In GitHub, `dom-valliance/lance`, Settings.

1. Environments, New environment, name `dev`.
   - Environment secrets: add `AZURE_CLIENT_ID` with the deploy client id.
   - Deployment branches and tags: choose "Selected branches and tags" and add `main`. This is the control that stops a manual run of the Deploy workflow from another branch reaching dev; the Azure side trusts the environment, not the branch.
   - Leave required reviewers off for dev. Prod gets one.
2. Secrets and variables, Actions, Repository secrets: add `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and `AZURE_CLIENT_ID` with the plan client id.

An environment secret with the same name as a repository secret wins inside a job that names that environment, which is how the two jobs of `deploy.yml` get the deploy identity while the CI what-if gets the plan identity.

## 4. First run

Role assignments take up to five minutes to propagate, so wait that long after step 1 before the first run.

1. Open a pull request. The `Bicep build, lint and what-if` job in CI now logs in as the plan identity and runs the what-if against dev, using the tag dev is running. Read the report in the job log; it should show the eleven modifications the what-if always reports (Postgres and Log Analytics properties the provider rewrites) and nothing under `Create` or `Delete`.
2. Merge. When `CI` finishes green on `main`, `Deploy` starts on its own: three `Build and push` jobs, then `Deploy, migrate and verify`. The environment `dev` in the repository's Environments page shows the deployment with the web hostname as its link.
3. Read the `Verify the deployment` step. It prints one `ok:` line per check: three revisions Running and Healthy on the new tag, the web page, both api probes, and the two console start-up lines.
4. Confirm from the other side once: `/lance status` in Slack, and the web app signed in as Dom.

If the run fails:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `AADSTS700213` or "No matching federated identity record found" at `Log in to Azure with OIDC` | The subject does not match: wrong client id at that level, the environment is not called `dev`, or the repository or its ids changed | Compare the `subject claim` line in the job log with the credentials (`az identity federated-credential list -g rg-lance-dev --identity-name id-lance-github-plan-dev`). Step 3 for the client id; for the subject, update `githubRepository`, `githubOwnerId` or `githubRepositoryId` in the parameter file and redeploy step 1 |
| `AuthorizationFailed` on a `Microsoft.Authorization/roleAssignments` write during `Deploy the environment` | `main.bicep` assigns a role that `assignableRoleIds` in `infra/deployer.bicep` does not list | Add the id, redeploy step 1, re-run the workflow. `scripts/check-deployer-roles.sh` in CI catches this on the pull request |
| `AuthorizationFailed` on anything else within five minutes of step 1 | Role assignments still propagating | Wait and re-run the workflow |
| `has no lance-web:<tag>` from `scripts/deploy.sh` | The push jobs did not complete for that tag | Read the `Build and push` job that failed |
| The migration job ends Failed | A migration the managed server refuses | The job log is in the step output; fix the migration and re-run |

## Redeploying by hand

The workflow and the runbook share `scripts/deploy.sh`, `scripts/run-migration-job.sh` and `scripts/verify-deploy.sh`, so `deploy.md` steps 5 to 10 remain the manual path and need only `LANCE_IMAGE_TAG` in the shell. A manual deploy and a workflow deploy never run at once: the workflow's concurrency group serialises its own runs, and a person checks the Actions tab before starting one.

## Removing the identities

Delete the role definitions last, since assignments reference them:

```
az identity delete -g rg-lance-dev -n id-lance-github-deploy-dev
az identity delete -g rg-lance-dev -n id-lance-github-plan-dev
az role definition delete --name "Lance deployment writer"
az role definition delete --name "Lance deployment reader"
```

Then remove the GitHub environment and the three secrets. Deleting an identity removes its role assignments with it.
