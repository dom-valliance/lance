# Runbook: deploy Lance to Azure

First deploy of an environment takes about forty minutes, most of it waiting for the Postgres Flexible Server. Later deploys take five. Everything here runs from the repo root as Dom, signed in with `az login`.

The templates are in `infra/`. See `infra/README.md` for what each module does.

The order matters. The environment stands up on a public bootstrap image first, then the secrets go in, then the real images, then the database principals. Steps 1 to 3 create nothing that depends on a secret, so they work on a clean subscription.

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

The template creates the vault and grants the four identities `Key Vault Secrets User`. It never creates a secret value. Set all twelve by hand. Take the values from `entra-setup.md`, `slack-app-setup.md` and `rotate-secrets.md`.

```
KV=<key vault name from the outputs>

az keyvault secret set --vault-name $KV --name entra-tenant-id         --value '<directory tenant id>'
az keyvault secret set --vault-name $KV --name entra-client-id         --value '<application client id>'
az keyvault secret set --vault-name $KV --name entra-client-secret     --value '<client secret>'
az keyvault secret set --vault-name $KV --name allowed-upn             --value 'dom@valliance.ai'
az keyvault secret set --vault-name $KV --name auth-secret             --value "$(openssl rand -base64 32)"
az keyvault secret set --vault-name $KV --name slack-bot-token         --value 'xoxb-...'
az keyvault secret set --vault-name $KV --name slack-signing-secret    --value '<signing secret>'
az keyvault secret set --vault-name $KV --name anthropic-api-key       --value '<anthropic key>'
az keyvault secret set --vault-name $KV --name notion-token            --value '<notion integration token>'
az keyvault secret set --vault-name $KV --name jamie-api-key           --value '<jamie read-only key>'
az keyvault secret set --vault-name $KV --name agent-log-ingest-secret --value "$(openssl rand -hex 32)"
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

1. In `infra/params/dev.bicepparam` set:

   ```
   param useBootstrapImage = false
   param containerImageTag = '<the value of $TAG from step 5>'
   ```

2. Re-run the what-if, then deploy with the same command as step 3. The three apps get new revisions that pull from the registry with their own identities and resolve the Key Vault references. The ingress target ports move from 80 to 3000 for web and 3001 for api.

3. Watch the revisions come up:

   ```
   az containerapp revision list -g rg-lance-dev -n ca-lance-api-dev \
     --query "[].{name:name, active:properties.active, state:properties.runningState}" -o table
   ```

   A revision stuck in `Failed` is normally a Key Vault reference that cannot resolve. Check that the secret exists and that the role assignment has propagated; propagation takes up to five minutes after the first deploy.

## 7. Create the Postgres principals

Run this once per environment, as the Entra administrator from step 2, before the migration job. The identity names come from the `identityNames` deployment output and are exactly `id-lance-web-dev`, `id-lance-api-dev`, `id-lance-worker-dev` and `id-lance-migrate-dev`.

1. Open the firewall to your machine. The server accepts Azure services only, so a psql connection from outside times out. Export your public IP and redeploy; the template adds a single-address rule. Unset the variable and redeploy later to remove it. The rule is one address: when your network changes, psql times out again, and the fix is the same export and redeploy, so set the variable from `curl` in the shell you deploy from every time rather than keeping an old value:

   ```
   export LANCE_ADMIN_CLIENT_IP=$(curl -s https://api.ipify.org)
   az deployment sub create --location uksouth --template-file infra/main.bicep --parameters infra/params/dev.bicepparam
   ```

2. Connect to the `postgres` maintenance database, not `lance`, with an Entra access token as the password. The `pgaadauth_*` functions exist only there; roles are cluster-wide, so principals created here apply to `lance`:

   ```
   PGHOST=<postgres FQDN from the outputs>
   PGPASSWORD=$(az account get-access-token \
     --resource-type oss-rdbms --query accessToken -o tsv) \
   psql "host=$PGHOST port=5432 dbname=postgres user=dom@valliance.ai sslmode=require"
   ```

3. Create a principal for each managed identity. The arguments are `isAdmin` and `isMfa`. The migrate identity is an admin principal because the migrations create roles and extensions, which needs `azure_pg_admin`; the three app identities are not:

   ```sql
   SELECT * FROM pgaadauth_create_principal('id-lance-migrate-dev', true, false);
   SELECT * FROM pgaadauth_create_principal('id-lance-web-dev', false, false);
   SELECT * FROM pgaadauth_create_principal('id-lance-api-dev', false, false);
   SELECT * FROM pgaadauth_create_principal('id-lance-worker-dev', false, false);
   ```

   Stay connected; step 9 uses the same session.

## 8. Run the migration job

The job is manual trigger only. It never runs on a schedule and never as part of a deploy. It runs the migrations and then the idempotent seed (system_state row, Dom's user row) as the migrate identity, and migration 0000 grants that identity `lance_migrator` so later migrations can reassign ownership.

```
az containerapp job start -g rg-lance-dev -n caj-lance-migrate-dev
az containerapp job execution list -g rg-lance-dev -n caj-lance-migrate-dev \
  --query "[].{name:name, status:properties.status}" -o table
```

Wait for `Succeeded`. On failure read the logs:

```
az containerapp job logs show -g rg-lance-dev -n caj-lance-migrate-dev --container migrate
```

## 9. Grant the application roles

Back in the psql session from step 7 (still on the `postgres` database; roles are cluster-wide), now that the migrations have created the roles. The three app identities get `lance_app`, which has INSERT and SELECT on the ledger and no UPDATE or DELETE there:

```sql
GRANT lance_app TO "id-lance-web-dev";
GRANT lance_app TO "id-lance-api-dev";
GRANT lance_app TO "id-lance-worker-dev";
```

The role names are case sensitive and the identity names must stay in double quotes. `lance_retention` arrives with the retention jobs in Phase 5 (ADR 0011); its identity and grant are added then.

The three apps connect with `PG_ROLE=lance_app` (set by the template), so every session acts as the shared role and anything created at runtime, pg-boss's queue tables above all, is owned by `lance_app` rather than by whichever identity made it. An environment deployed before `PG_ROLE` existed has pg-boss tables owned by the worker identity, which the api cannot read; repair it once, from the same psql session but connected to the `lance` database:

```sql
REASSIGN OWNED BY "id-lance-worker-dev" TO lance_app;
```

Quit psql.

## 10. Verify

1. Open `https://<web hostname>` and sign in as Dom. Any other UPN is refused.
2. Run `/lance status` in `dom-claude-agent`. The api answers with an ephemeral message and the ledger records a `state_changed` event.
3. In the web app, open Settings and press Connect Microsoft 365, then consent as Dom. The api writes the real `graph-refresh-token` over the placeholder from step 4.
4. Confirm `LANCE_MODE` is still `dry_run`. Lance proposes and does not execute until Dom changes it deliberately.

## Notes

- Prod uses `infra/params/prod.bicepparam`, which never deploys on the bootstrap image. Push the images to the prod registry and set `containerImageTag` before the first prod deploy.
- Deleting the resource group leaves the Key Vault soft deleted for 90 days, and purge protection means it cannot be purged early. The vault name is derived from the subscription id and the resource group name, so a redeploy into the same group asks for the same name and collides with the soft deleted vault. Recover it rather than renaming: `az keyvault recover --name <vault name>`.
- The api is externally reachable on every route because Container Apps has no path-scoped ingress. The api enforces Entra bearer authentication on every route except `/slack/*` and `/ingest/*`, and Slack signature verification on those two. Phase 5 revisits this.
