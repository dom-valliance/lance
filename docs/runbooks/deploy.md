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

## 4. Set the Key Vault secrets

The template creates the vault and grants the four identities `Key Vault Secrets User`. It never creates a secret value. Set all eleven by hand. Take the values from `entra-setup.md`, `slack-app-setup.md` and `rotate-secrets.md`.

```
KV=<key vault name from the outputs>

az keyvault secret set --vault-name $KV --name entra-tenant-id         --value '<directory tenant id>'
az keyvault secret set --vault-name $KV --name entra-client-id         --value '<application client id>'
az keyvault secret set --vault-name $KV --name entra-client-secret     --value '<client secret>'
az keyvault secret set --vault-name $KV --name allowed-upn             --value 'dom@valliance.ai'
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

Check all eleven are present:

```
az keyvault secret list --vault-name $KV --query "[].name" -o tsv | sort
```

If the CLI reports a forbidden error, grant yourself `Key Vault Secrets Officer` on the vault. The vault uses RBAC, not access policies, and creating it does not grant you data plane access.

## 5. Build and push the three images

`az acr build` runs the build in Azure, so nothing local needs Docker.

```
ACR=<registry name from the outputs>

az acr build --registry $ACR --image lance-web:$(git rev-parse --short HEAD)    --file apps/web/Dockerfile .
az acr build --registry $ACR --image lance-api:$(git rev-parse --short HEAD)    --file apps/api/Dockerfile .
az acr build --registry $ACR --image lance-worker:$(git rev-parse --short HEAD) --file apps/worker/Dockerfile .
```

The build context is the repo root because the Dockerfiles copy the pnpm workspace. Confirm the tags landed:

```
az acr repository show-tags --name $ACR --repository lance-web -o tsv
```

## 6. Flip to the real images

1. In `infra/params/dev.bicepparam` set:

   ```
   param useBootstrapImage = false
   param containerImageTag = '<the short SHA used in step 5>'
   ```

2. Re-run the what-if, then deploy with the same command as step 3. The three apps get new revisions that pull from the registry with their own identities and resolve the Key Vault references. The ingress target ports move from 80 to 3000 for web and 3001 for api.

3. Watch the revisions come up:

   ```
   az containerapp revision list -g rg-lance-dev -n ca-lance-api-dev \
     --query "[].{name:name, active:properties.active, state:properties.runningState}" -o table
   ```

   A revision stuck in `Failed` is normally a Key Vault reference that cannot resolve. Check that the secret exists and that the role assignment has propagated; propagation takes up to five minutes after the first deploy.

## 7. Run the migration job

The job is manual trigger only. It never runs on a schedule and never as part of a deploy.

```
az containerapp job start -g rg-lance-dev -n caj-lance-migrate-dev
```

Follow it:

```
az containerapp job execution list -g rg-lance-dev -n caj-lance-migrate-dev \
  --query "[0].{name:name, status:properties.status, start:properties.startTime}" -o table

az containerapp job logs show -g rg-lance-dev -n caj-lance-migrate-dev --container migrate --follow
```

The first run fails with a permission error because the migration identity has no Postgres principal yet. Do step 8, then start the job again.

## 8. Create the Postgres principals

Run this once per environment, as the Entra administrator from step 2. The identity names come from the `identityNames` deployment output and are exactly `id-lance-web-dev`, `id-lance-api-dev`, `id-lance-worker-dev` and `id-lance-migrate-dev`.

1. Connect with an Entra access token as the password:

   ```
   PGHOST=<postgres FQDN from the outputs>
   PGPASSWORD=$(az account get-access-token \
     --resource-type oss-rdbms --query accessToken -o tsv) \
   psql "host=$PGHOST port=5432 dbname=lance user=dom@valliance.ai sslmode=require"
   ```

2. Create a principal for each managed identity. The second and third arguments are `isAdmin` and `isMfa`, both false:

   ```sql
   SELECT * FROM pgaadauth_create_principal('id-lance-web-dev', false, false);
   SELECT * FROM pgaadauth_create_principal('id-lance-api-dev', false, false);
   SELECT * FROM pgaadauth_create_principal('id-lance-worker-dev', false, false);
   SELECT * FROM pgaadauth_create_principal('id-lance-migrate-dev', false, false);
   ```

3. Grant the roles the migrations create. The three app identities get `lance_app`, which has INSERT and SELECT on the ledger and no UPDATE or DELETE anywhere:

   ```sql
   GRANT lance_app TO "id-lance-web-dev";
   GRANT lance_app TO "id-lance-api-dev";
   GRANT lance_app TO "id-lance-worker-dev";
   GRANT lance_migrator TO "id-lance-migrate-dev";
   ```

   The role names are case sensitive and the identity names must stay in double quotes.

4. `lance_retention` arrives with the retention jobs in a later phase (ADR 0011). When its identity exists, create its principal the same way and grant it:

   ```sql
   GRANT lance_retention TO "id-lance-retention-dev";
   ```

   Until then there is no retention identity and nothing to grant.

5. Quit psql, then start the migration job again (step 7). It should finish `Succeeded`.

## 9. Verify

1. Open `https://<web hostname>` and sign in as Dom. Any other UPN is refused.
2. Run `/lance status` in `dom-claude-agent`. The api answers with an ephemeral message and the ledger records a `state_changed` event.
3. Open `https://<api hostname>/auth/graph/connect` as Dom and consent. The api writes the real `graph-refresh-token` over the placeholder from step 4.
4. Confirm `LANCE_MODE` is still `dry_run`. Lance proposes and does not execute until Dom changes it deliberately.

## Notes

- Prod uses `infra/params/prod.bicepparam`, which never deploys on the bootstrap image. Push the images to the prod registry and set `containerImageTag` before the first prod deploy.
- Deleting the resource group leaves the Key Vault soft deleted for 90 days, and purge protection means it cannot be purged early. The vault name is derived from the subscription id and the resource group name, so a redeploy into the same group asks for the same name and collides with the soft deleted vault. Recover it rather than renaming: `az keyvault recover --name <vault name>`.
- The api is externally reachable on every route because Container Apps has no path-scoped ingress. The api enforces Entra bearer authentication on every route except `/slack/*` and `/ingest/*`, and Slack signature verification on those two. Phase 5 revisits this.
