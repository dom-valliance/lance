# Runbook: deploy Lance to Azure

First deploy of an environment takes about forty minutes, most of it waiting for the Postgres Flexible Server. Later deploys take five. Everything here runs from the repo root as Dom, signed in with `az login`.

The templates are in `infra/`. See `infra/README.md` for what each module does.

The order matters. The environment stands up on a public bootstrap image first, then the secrets go in, then the real images, then the database principals. Steps 1 to 3 create nothing that depends on a secret, so they work on a clean subscription.

After the first deploy, merges to `main` deploy themselves: `.github/workflows/deploy.yml` builds and pushes the images, deploys, runs the migration job and verifies, using the same scripts steps 5 to 10 name. `github-deploy-setup.md` connects the repository to Azure once. The manual path below stays for the first deploy of an environment and for a redeploy from a laptop.

## 1. Check the subscription and the providers

1. Confirm the target subscription:

   ```
   az account show --query "{name:name, id:id, tenant:tenantId}" -o table
   ```

   For Lance this is `Azure subscription 1`, `d28312a1-6e66-4302-ac89-510f2d686a12`, tenant `ac995b50-b931-4d4b-b0ea-c0617e8141f9`. Change it with `az account set --subscription <id>`.

2. Confirm the resource providers are registered:

   ```
   for p in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL \
            Microsoft.KeyVault Microsoft.OperationalInsights Microsoft.Insights \
            Microsoft.ManagedIdentity; do
     echo -n "$p "
     az provider show -n $p --query registrationState -o tsv
   done
   ```

   Every line must read `Registered`. Register a missing one with `az provider register -n <provider>` and wait for it to finish before deploying.

## 2. Fill the parameter file

1. Find Dom's object id. This is the principal that becomes the Postgres Entra administrator and creates the managed identity principals later (ADR 0008):

   ```
   az ad signed-in-user show --query id -o tsv
   ```

2. Open `infra/params/dev.bicepparam` and replace the placeholder:

   ```
   param postgresEntraAdminObjectId = '00000000-0000-0000-0000-000000000000'
   ```

   with the id from step 1. The placeholder is not a valid principal. Deployment validation passes with it because validation does not resolve principals, so the failure arrives during the deploy itself.

3. Export the Postgres administrator password for the session. This is the password fallback that ADR 0008 allows. Nothing in the running system uses it, and the value never goes in a file:

   ```
   export LANCE_PG_ADMIN_PASSWORD="$(openssl rand -base64 24)"
   ```

   Only needed when `postgresPasswordAuthEnabled` is true. It is false by default, so Entra is the only authentication and this step can be skipped.

   Record it in the password manager if you want the fallback to be usable. If you lose it, reset it in the portal.

## 3. Deploy the environment on the bootstrap image

`useBootstrapImage` is `true` in `dev.bicepparam`, so the three apps and the migration job run `mcr.microsoft.com/k8se/quickstart:latest`. Nothing needs the registry or Key Vault yet.

1. Check the plan first. This is read-only:

   ```
   az deployment sub what-if \
     --location uksouth \
     --template-file infra/main.bicep \
     --parameters infra/params/dev.bicepparam
   ```

   The eight role assignments report as `Unsupported` because their names depend on principal ids that do not exist until the deploy runs. That is expected.

2. Deploy:

   ```
   az deployment sub create \
     --location uksouth \
     --template-file infra/main.bicep \
     --parameters infra/params/dev.bicepparam
   ```

3. Read the outputs. Later steps need them:

   ```
   az deployment sub show -n main --query properties.outputs -o json
   ```

   The deployment name defaults to `main`. The outputs give the Key Vault name, the registry name and login server, the Postgres FQDN, the web and api hostnames, the migration job name, and the four identity names.

## 3b. Restart Postgres once

`shared_preload_libraries` (which preloads Apache AGE) is a static server parameter, so the first deploy leaves it pending until a restart. Do this once after the first deploy of an environment; later deploys do not change it:

```
az postgres flexible-server restart -g rg-lance-dev -n <postgres server name from the outputs>
az postgres flexible-server parameter show -g rg-lance-dev -s <server name> -n shared_preload_libraries --query value -o tsv
```

The second command must print `pg_cron,pg_stat_statements,age`.

## 3a. Confirm you can write secrets

The vault uses RBAC, and the template grants you Key Vault Secrets Officer from `postgresEntraAdminObjectId`. Role assignments can take a few minutes to propagate. If `az keyvault secret set` returns `ForbiddenByRbac`, check the assignment exists and wait:

```
az role assignment list --scope $(az keyvault show -g rg-lance-dev -n <vault name> --query id -o tsv) \
  --query "[].{role:roleDefinitionName, principal:principalName}" -o table
```

Do not grant the role by hand. Azure keys role assignments by name, the template names its own deterministically, and a hand-made assignment for the same principal, role and scope makes the next deploy fail with `RoleAssignmentExists`. If the vault was deployed from a template older than this step, redeploy (step 3) and the assignment appears. If a hand-made one already exists, delete it first:

```
az role assignment delete --ids <assignment id from the list above>
```

## 4. Set the Key Vault secrets

The template creates the vault and grants the four identities `Key Vault Secrets User`. It never creates a secret value. Set these ten by hand; the api writes `graph-refresh-token` itself on the first consent. An environment deployed before ADR 0020 also holds `allowed-upn`; no app reads it any more, and it stays until someone deletes it deliberately. Take the values from `entra-setup.md`, `slack-app-setup.md` and `rotate-secrets.md`.

```
KV=<key vault name from the outputs>

az keyvault secret set --vault-name $KV --name entra-tenant-id         --value '<directory tenant id>'
az keyvault secret set --vault-name $KV --name entra-client-id         --value '<application client id>'
az keyvault secret set --vault-name $KV --name entra-client-secret     --value '<client secret>'
az keyvault secret set --vault-name $KV --name auth-secret             --value "$(openssl rand -base64 32)"
az keyvault secret set --vault-name $KV --name slack-bot-token         --value 'xoxb-...'
az keyvault secret set --vault-name $KV --name slack-signing-secret    --value '<signing secret>'
az keyvault secret set --vault-name $KV --name anthropic-api-key       --value '<anthropic key>'
az keyvault secret set --vault-name $KV --name notion-token            --value '<notion integration token>'
az keyvault secret set --vault-name $KV --name jamie-api-key           --value '<jamie read-only key>'
az keyvault secret set --vault-name $KV --name agent-log-ingest-secret --value "$(openssl rand -hex 32)"
```

The Notion token alone reaches nothing. In Notion, open the All Tasks database and the Meetings database, choose the three dots, Connections, and add the integration the token belongs to (`Dom's Lance`). Until both are shared, every query returns `object_not_found` and the notion watcher raises a breaker alert on each poll. Check with:

```
curl -s https://api.notion.com/v1/data_sources/<tasks data source id> \
  -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2025-09-03" | head -c 300
```

`graph-refresh-token` is the exception. The api writes it after Dom's first delegated consent, step 7 of `entra-setup.md`. Create a placeholder now so the api starts:

```
az keyvault secret set --vault-name $KV --name graph-refresh-token --value 'pending-first-consent'
```

Check all twelve are present:

```
az keyvault secret list --vault-name $KV --query "[].name" -o tsv | sort
```

If the CLI reports a forbidden error, see step 3a.

## 5. Build and push the three images

`az acr build` runs the build in Azure, so nothing local needs Docker.

The image tag is the short git SHA of the commit being deployed. Capture it once so steps 5 and 6 use the same value:

```
ACR=<registry name from the outputs>
TAG=$(git rev-parse --short HEAD)
echo "$TAG"

az acr build --registry $ACR --image lance-web:$TAG    --file apps/web/Dockerfile .
az acr build --registry $ACR --image lance-api:$TAG    --file apps/api/Dockerfile .
az acr build --registry $ACR --image lance-worker:$TAG --file apps/worker/Dockerfile .
```

The build context is the repo root because the Dockerfiles copy the pnpm workspace. Confirm the tags landed:

```
az acr repository show-tags --name $ACR --repository lance-web -o tsv
```

## 6. Flip to the real images

1. In `infra/params/dev.bicepparam` set `useBootstrapImage` to `false`. The image tag is not in the file: the parameter file reads it from `LANCE_IMAGE_TAG`, and refuses to compile when the variable is unset, so no deploy ever edits a committed file to name a tag.

2. Deploy with the tag from step 5. `scripts/deploy.sh` checks the three images exist in the registry, exports `LANCE_IMAGE_TAG`, runs the subscription deployment under the name `lance-dev-<tag>` and prints the outputs:

   ```
   scripts/deploy.sh dev "$TAG"
   ```

   To read the plan first, run the what-if of step 3 with the variable exported: `LANCE_IMAGE_TAG=$TAG az deployment sub what-if ...`. The three apps get new revisions that pull from the registry with their own identities and resolve the Key Vault references. The ingress target ports move from 80 to 3000 for web and 3001 for api.

3. Watch the revisions come up:

   ```
   az containerapp revision list -g rg-lance-dev -n ca-lance-api-dev \
     --query "[].{name:name, active:properties.active, state:properties.runningState}" -o table
   ```

   A revision stuck in `Failed` is normally a Key Vault reference that cannot resolve. Check that the secret exists and that the role assignment has propagated; propagation takes up to five minutes after the first deploy. Step 10 runs the full set of checks.

   Later deploys look up their outputs by the name the script gave them: `az deployment sub show -n lance-dev-<tag> --query properties.outputs -o json`.

## 7. Create the Postgres principals

Run this once per environment, as the Entra administrator from step 2, before the migration job. The identity names come from the `identityNames` deployment output and are exactly `id-lance-web-dev`, `id-lance-api-dev`, `id-lance-worker-dev` and `id-lance-migrate-dev`.

1. Open the server to your machine for this session. The server accepts Azure services only, and your public address changes with the network you are on, so the template owns no client rule. `scripts/psql-admin.sh` adds a rule for your current address, waits for it to take effect, opens psql with an Entra token as the password, and removes the rule when psql exits. It logs in as the account `az login` holds, which must be the Entra administrator from step 2:

   ```
   scripts/psql-admin.sh postgres
   ```

   The first argument is the database (`postgres` for the steps below, `lance` for anything else); further arguments go to psql, so `scripts/psql-admin.sh lance -c 'select 1'` runs one statement and closes the rule again.

2. The script has opened psql on the `postgres` maintenance database, not `lance`. The `pgaadauth_*` functions exist only there; roles are cluster-wide, so principals created here apply to `lance`.

3. Create a principal for each managed identity. The arguments are `isAdmin` and `isMfa`. The migrate identity is an admin principal because the migrations create roles and extensions, which needs `azure_pg_admin`; the three app identities are not:

   ```sql
   SELECT * FROM pgaadauth_create_principal('id-lance-migrate-dev', true, false);
   SELECT * FROM pgaadauth_create_principal('id-lance-web-dev', false, false);
   SELECT * FROM pgaadauth_create_principal('id-lance-api-dev', false, false);
   SELECT * FROM pgaadauth_create_principal('id-lance-worker-dev', false, false);
   ```

   Stay connected; step 9 uses the same session.

## 8. Run the migration job

The job is manual trigger only and never runs on a schedule. It runs the migrations and then the idempotent seed (the global state row and the first principal) as the migrate identity, and migration 0000 grants that identity `lance_migrator` so later migrations can reassign ownership. The deployment itself never runs it; `scripts/run-migration-job.sh` does, and `deploy.yml` runs that script with the new tag before the deployment, so the migrations run before the apps move (ADR 0032). By hand, run it with the tag before step 6, and without one to rerun it on the image it has:

```
scripts/run-migration-job.sh dev "${LANCE_IMAGE_TAG}"
```

The script starts an execution, waits for it to finish, prints its log and exits non-zero on anything other than `Succeeded`. To look at past executions:

```
az containerapp job execution list -g rg-lance-dev -n caj-lance-migrate-dev \
  --query "[].{name:name, status:properties.status}" -o table
az containerapp job logs show -g rg-lance-dev -n caj-lance-migrate-dev --container migrate --execution <name>
```

## 9. Grant the application roles

Open psql again with `scripts/psql-admin.sh postgres` (roles are cluster-wide, so the `postgres` database is fine), now that the migrations have created the roles. The three app identities get `lance_app`, which has INSERT and SELECT on the ledger and no UPDATE or DELETE there:

```sql
GRANT lance_app TO "id-lance-web-dev";
GRANT lance_app TO "id-lance-api-dev";
GRANT lance_app TO "id-lance-worker-dev";
```

The role names are case sensitive and the identity names must stay in double quotes. `lance_retention` arrives with the retention jobs in Phase 5 (ADR 0011); its identity and grant are added then.

The three apps connect with `PG_ROLE=lance_app` (set by the template), so every session acts as the shared role and anything created at runtime, pg-boss's queue tables above all, is owned by `lance_app` rather than by whichever identity made it. An environment deployed before `PG_ROLE` existed has pg-boss tables owned by the worker identity, which the api cannot read; repair it once with `scripts/psql-admin.sh lance`:

```sql
REASSIGN OWNED BY "id-lance-worker-dev" TO lance_app;
```

Quit psql; the script closes the firewall rule.

## 10. Verify

Run the same checks the workflow runs. The script waits for each app's latest revision to be Running and Healthy on the expected tag, requests the web app and both api probes, and reads the api and worker console logs for their start-up lines:

```
scripts/verify-deploy.sh dev "$TAG"
```

It cannot see failed pg-boss jobs or failed agent runs; after any deploy that changes the worker, read those as `observing.md` describes. Then, from the user's side:

1. Open `https://<web hostname>` and sign in as Dom. Any other UPN is refused.
2. Run `/lance status` in `dom-claude-agent`. The api answers with an ephemeral message and the ledger records a `state_changed` event.
3. In the web app, open Settings and press Connect Microsoft 365, then consent as Dom. The api writes the real `graph-refresh-token` over the placeholder from step 4.
4. Confirm `LANCE_MODE` is still `dry_run`. Lance proposes and does not execute until Dom changes it deliberately.

## 11. Going live

Lance starts in dry run: proposals are created and held, nothing is written externally, and a digest goes to Slack at 17:00 on weekdays. Two independent gates keep it that way, and both are opened deliberately.

1. Wait out the dry-run window. Every watcher holds its proposals for its first `WATCHERS_DRY_RUN_DAYS_FOR_NEW_WATCHER` working days (default five) from its first run, whatever the mode. `/lance status` shows each watcher's `__started_at`.
2. Turn the write flags on. In `infra/params/<env>.bicepparam` set `graphWritesEnabled` and `notionWritesEnabled` to `true` and redeploy. Until then the executor holds every approved proposal with the reason `writes_disabled`.
3. Switch the mode: `/lance mode live` in Slack, or `POST /admin/mode` with `{"mode": "live"}`. The ledger records a `state_changed` event.
4. Release what was held: `/lance pause` then `/lance resume`. Resume re-queues every held proposal, and from now on the executor performs approved writes. To stop, `/lance pause` at any time or `/lance mode dry_run`.

## Notes

- The migration job runs on the new image before the apps move to it (ADR 0032), so every migration must leave the image already running working for the minute the apps take to move. The apps wait up to `LANCE_STARTUP_WAIT_SECONDS` (default 600) at start-up for their principal, so a start that races the job waits for it.
- A migration that moves state the running image reads must leave that state where the running image looks. Migration 0009 moved the kill switch from `system_state` into `principal_state` and cleared the global row, so the old image, which reads only `system_state`, saw itself unpaused for the six minutes between the migration and the new worker starting, despite `/lance pause` (phase log, Phase 4 deploy). Before such a migration, say in the runbook how the old image is kept idle, and check it by reading the old image's jobs in `pgboss.job` during the window.

- Prod uses `infra/params/prod.bicepparam`, which never deploys on the bootstrap image. Push the images to the prod registry and export `LANCE_IMAGE_TAG` to a tag dev has already run before the first prod deploy. The workflow deploys dev only; prod is a later addition (ADR 0014).
- Deleting the resource group leaves the Key Vault soft deleted for 90 days, and purge protection means it cannot be purged early. The vault name is derived from the subscription id and the resource group name, so a redeploy into the same group asks for the same name and collides with the soft deleted vault. Recover it rather than renaming: `az keyvault recover --name <vault name>`.
- The api is externally reachable on every route because Container Apps has no path-scoped ingress. The api enforces Entra bearer authentication on every route except `/slack/*` and `/ingest/*`, and Slack signature verification on those two. Phase 5 revisits this.
