# Runbook: connect GitHub Actions to Azure

Run once per environment. After it, every merge to `main` deploys itself to dev through `.github/workflows/deploy.yml`. ADR 0014 records the decision.

Run `deploy.md` steps 1 to 4 first: the resource group and the registry must exist, because the identity lives in that group and its roles are scoped to it. Everything here runs from the repo root as Dom, signed in with `az login`. Dom is an Owner of the subscription, which the template needs: it creates a custom role definition and grants Role Based Access Control Administrator, and only an Owner or User Access Administrator may do either.

## What gets created

`infra/deployer.bicep` (subscription scope) with `infra/params/deployer-dev.bicepparam` creates, in `rg-lance-dev`:

| Resource | Purpose |
| --- | --- |
| `id-lance-github-deploy-dev` managed identity | What `deploy.yml` runs as. Contributor on the group; Role Based Access Control Administrator on the group, limited by condition to the four roles `main.bicep` assigns (AcrPull, Key Vault Secrets User, Key Vault Secrets Officer, Log Analytics Reader); the custom `Lance deployment writer` role at subscription scope, which allows subscription deployments and their what-if and nothing else. |
| Federated credential `github-environment-dev` on it | Trusts tokens from GitHub whose subject is `repo:dom-valliance@215853107/lance@1378678734:environment:dev`. No client secret exists. |

The numbers in the subject are the owner id and the repository id. GitHub appends them to the names in every token it issues for this repository, and Entra compares the whole string, so a credential written without them never matches. Both ids are in `infra/params/deployer-dev.bicepparam`; if the repository is ever transferred or recreated, read the new ones from the `subject claim` line that azure/login prints on the failed run and redeploy step 1.

There is no read-only identity for pull requests. A what-if runs the same authorisation pre-flight as a deployment, checking write permission on every resource in the template, so a Reader cannot run one. The what-if runs inside `deploy.yml` instead, under the deploy identity, in the same log as the deployment it describes, and CI's Bicep job on a pull request builds, lints and guards without touching Azure.

Nothing in `main.bicep` changes, and the template touches nothing that `main.bicep` owns. CI never deploys this template.

## 1. Deploy the identity

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

On a clean environment the what-if lists six creations (identity, credential, two group role assignments, role definition, subscription role assignment) and the existing resources to ignore. Anything reported as a modification of a resource `main.bicep` owns is a fault in the template; stop and read it.

An environment that received the earlier version of this template also has `id-lance-github-plan-dev`, its two role assignments and the `Lance deployment reader` role, which nothing uses now. The template no longer declares them and a redeploy leaves them in place. Remove them once, assignments first: deleting an identity does not delete its role assignments, they stay behind with an empty principal name, and a role definition cannot be deleted while an assignment references it.

```
principal=$(az identity show -g rg-lance-dev -n id-lance-github-plan-dev --query principalId -o tsv)
az role assignment list --all --assignee "$principal" --query "[].id" -o tsv | xargs -n1 az role assignment delete --ids
az identity delete -g rg-lance-dev -n id-lance-github-plan-dev
az role definition delete --name "Lance deployment reader"
```

If the identity was deleted first, find the orphaned assignments by the role and by the group instead, and delete each by id:

```
az role assignment list --all --role "Lance deployment reader" --query "[].id" -o tsv
az role assignment list -g rg-lance-dev --query "[?principalName==''].{id:id, role:roleDefinitionName}" -o table
az role assignment delete --ids <id>
```

## 2. Read the values GitHub needs

Three identifiers and none of them secret. Print them:

```
az deployment sub show -n lance-deployer-dev \
  --query "properties.outputs.{tenantId:tenantId.value, subscriptionId:subscriptionId.value, deployClientId:deployClientId.value}" \
  -o table
```

Known values:

| Name | Value |
| --- | --- |
| Tenant id | `ac995b50-b931-4d4b-b0ea-c0617e8141f9` |
| Subscription id | `d28312a1-6e66-4302-ac89-510f2d686a12` |
| GitHub owner id | `215853107` (in the parameter file; part of the OIDC subject) |
| GitHub repository id | `1378678734` (same) |
| Deploy client id | From the command above (`deployClientId`). Created by the deploy, so it is not known before step 1. |

## 3. Configure the repository

In GitHub, `dom-valliance/lance`, Settings.

1. Environments, New environment, name `dev`.
   - Environment secrets: add `AZURE_CLIENT_ID` with the deploy client id.
   - Deployment branches and tags: choose "Selected branches and tags" and add `main`. This is the control that stops a manual run of the Deploy workflow from another branch reaching dev; the Azure side trusts the environment, not the branch.
   - Leave required reviewers off for dev. Prod gets one.
2. Secrets and variables, Actions, Repository secrets: add `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`.

The client id lives only in the environment, so a job that does not name the environment has no identity to log in with. A repository-level `AZURE_CLIENT_ID` left over from the earlier version of this runbook is unused and can be deleted.

## 4. First run

Role assignments take up to five minutes to propagate, so wait that long after step 1 before the first run.

1. Merge a pull request. When `CI` finishes green on `main`, `Deploy` starts on its own: three `Build and push` jobs, then `Deploy, migrate and verify`. The environment `dev` in the repository's Environments page shows the deployment with the web hostname as its link.
2. Read the `Deploy the environment` step. It opens with the what-if: expect the eleven modifications the what-if always reports (Postgres and Log Analytics properties the provider rewrites), the image change on the three apps and the job, and nothing under `Create` or `Delete`.
3. Read the `Verify the deployment` step. It prints one `ok:` line per check: three revisions Running and Healthy on the new tag, the web page, both api probes, and the two console start-up lines.
4. Confirm from the other side once: `/lance status` in Slack, and the web app signed in as Dom.

If the run fails:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `AADSTS700213` or "No matching federated identity record found" at `Log in to Azure with OIDC` | The subject does not match: the client id is missing from the environment, the environment is not called `dev`, or the repository or its ids changed | Compare the `subject claim` line in the job log with the credential (`az identity federated-credential list -g rg-lance-dev --identity-name id-lance-github-deploy-dev`). Step 3 for the client id; for the subject, update `githubRepository`, `githubOwnerId` or `githubRepositoryId` in the parameter file and redeploy step 1 |
| `AuthorizationFailed` on a `Microsoft.Authorization/roleAssignments` write during `Deploy the environment` | `main.bicep` assigns a role that `assignableRoleIds` in `infra/deployer.bicep` does not list | Add the id, redeploy step 1, re-run the workflow. `scripts/check-deployer-roles.sh` in CI catches this on the pull request |
| `AuthorizationFailed` on anything else within five minutes of step 1 | Role assignments still propagating | Wait and re-run the workflow |
| `has no lance-web:<tag>` from `scripts/deploy.sh` | The push jobs did not complete for that tag | Read the `Build and push` job that failed |
| The migration job ends Failed | A migration the managed server refuses | The job log is in the step output; fix the migration and re-run |

## Redeploying by hand

The workflow and the runbook share `scripts/deploy.sh`, `scripts/run-migration-job.sh` and `scripts/verify-deploy.sh`, so `deploy.md` steps 5 to 10 remain the manual path and need only `LANCE_IMAGE_TAG` in the shell. A manual deploy and a workflow deploy never run at once: the workflow's concurrency group serialises its own runs, and a person checks the Actions tab before starting one.

## Removing the identity

Role assignments first, because deleting an identity leaves its assignments behind and a role definition cannot be deleted while one references it:

```
principal=$(az identity show -g rg-lance-dev -n id-lance-github-deploy-dev --query principalId -o tsv)
az role assignment list --all --assignee "$principal" --query "[].id" -o tsv | xargs -n1 az role assignment delete --ids
az identity delete -g rg-lance-dev -n id-lance-github-deploy-dev
az role definition delete --name "Lance deployment writer"
```

Then remove the GitHub environment and the two repository secrets.
