# Runbook: deploy Lance to Azure

First deploy of an environment takes about forty minutes, most of it waiting for the Postgres Flexible Server. Later deploys take five. Everything here runs from the repo root as Dom, signed in with `az login`.

The templates are in `infra/`. See `infra/README.md` for what each module does.

The order matters. The environment stands up on a public bootstrap image first, then the secrets go in, then the real images, then the database principals. Steps 1 to 3 create nothing that depends on a secret value, so they work on a clean subscription; step 2a creates the one custom role step 3 assigns.

An environment deployed before ADR 0022 (dev) is upgraded once by the section "Moving an environment to per-principal credentials" at the end, not by repeating these steps.

## Upgrading dev from Phase 4 to Phase 5

Dev runs Phase 4 (migrations 0000 to 0010). The Phase 5 build adds per-request identity from Entra app roles, per-principal credentials in a second vault, Slack linking and the job registry. Do these in this order; each step names where its detail is. Steps 1 and 2 must come before the merge, or the deploy stops or Dom is locked out of the web app.

1. **Entra app roles**, before the merge: make Dom an owner of the app registration and the enterprise application as the tenant administrator, then run `scripts/entra/setup-app-roles.sh dev` as Dom (`entra-setup.md` section 8). It gives Dom both roles and then requires assignment. Optionally run the admin-consent command it prints, for the nightly role check.
2. **The deployer identity**, before the merge: redeploy `infra/deployer.bicep` from the branch (`github-deploy-setup.md` step 1, then the two checks in "Moving an environment to per-principal credentials" step 1 below). It creates the custom role `Lance principal secret writer` and lets the deploy identity assign it.
3. **Pause Lance**: `/lance pause Phase 5 deploy` in Slack, and `/lance status` says paused. This keeps the old image idle for the minute it runs against the new schema; the migrations carry the pause into the new build (the Phase 4 lesson in the notes below).
4. **Merge.** The Deploy workflow runs the migration job on the new image (0011 to 0021 and the seed), deploys, runs the job again under the new job definition (which grants the retention role, ADR 0032), removes the four vault-wide Key Vault grants, and verifies.
5. **Sign in to the web app once.** The api binds Dom's Entra object id to his principal (`entra-setup.md` section 8, "Check it").
6. **Check the credentials moved**: the principal vault holds Dom's two secrets and the ledger holds two `credential_migrated` events ("Moving an environment to per-principal credentials" step 3 below).
7. **Resume**: `/lance resume`. It releases and re-queues everything held.
8. **Slack scopes**: add `groups:write` and `users:read.email` to the Slack app and reinstall it (`slack-app-setup.md` section 8). If the bot token changed, store it in the static vault and restart the apps.
9. **Link Slack**: `/lance login` in `dom-claude-agent`, follow the link, confirm (`slack-app-setup.md` section 8). Cards keep arriving in `C0BU7P278N5`.
10. **Retire the Slack fallback**: set `slackAllowedUserId = ''` in `infra/params/dev.bicepparam` and let the next deploy carry it.
11. **Evidence signing key**: set `evidence-signing-key` with the commands in step 4 below, then restart the api revision.
12. **Notion**: rename the integration from "Dom's Lance" to "Lance" in Notion; the token is unchanged.
13. **Before the pilot**: rehearse onboarding and offboarding with a test account (`offboard-principal.md`, "Rehearse in dev with a synthetic principal"), and send `docs/compliance/` to the DPO; the LIA must be signed off.

Jobs the old image queued without a principal are adopted when the new worker starts, before it fetches anything. Each one still waiting (`created` or `retry`) on a per-principal queue (`execute`, `triage`, `bulk-mail`, `chase`, `brief-morning` and every other queue the job registry declares per principal) is sent again with the owner's id and group, and the original is completed with the id of its replacement. The owner is the only principal, or the only principal that existed when the job was queued; in dev before the pilot that is Dom. The worker log says `jobs queued without a principal adopted` with a count, and Dom's ledger holds one `jobs_adopted` event listing each queue, old id and new id. Step 3's pause still matters: it keeps the old watchers idle while the old image runs against the new schema, and the adopted jobs wait behind the pause like any other until step 7.

If more than one principal existed when a job was queued, the worker does not guess. It leaves the job on its queue, logs `jobs queued without a principal were left unrun` with the job ids, and raises a P1 `unscoped_jobs_held` alert to every Lance.Admin (Dom when no admin role is recorded). Such a job fails once when a worker fetches it and is not retried. After step 7, check `pgboss.job` for failed jobs (`observing.md`) and send again, from the principal's own page, anything that still matters.

## Known values for dev

Read with the commands beside them; none is a secret.

| Item | Value | Command |
|---|---|---|
| Static Key Vault | `kv-lance-dev-j7riq4`, created by `infra/modules/keyvault.bicep` | `az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-dev-')].name" -o tsv` |
| Principal vault | `kv-lance-p-dev-j7riq4`, created by `infra/modules/principal-vault.bicep` on the first deploy that carries ADR 0022 | `az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-p-dev-')].name" -o tsv` |
| `id-lance-web-dev` principal id | `5ee0adf2-f489-46fc-99aa-7984b5c4e3b5` | `az identity show -g rg-lance-dev -n id-lance-web-dev --query principalId -o tsv` |
| `id-lance-api-dev` principal id | `659d6af9-e4ac-4573-be8a-a370b000830b` | as above, `-n id-lance-api-dev` |
| `id-lance-worker-dev` principal id | `84aa02b2-706b-49cc-89ef-b8577fd0c71f` | as above, `-n id-lance-worker-dev` |
| `id-lance-migrate-dev` principal id | `1e0a907c-b7bf-48e5-98c1-e721c76ec78b` | as above, `-n id-lance-migrate-dev` |
| `id-lance-github-deploy-dev` principal id | `758df7e5-0d06-45da-aef0-d14b7a7e2c9f` | as above, `-n id-lance-github-deploy-dev` |
| Dom's object id | `19fb2afd-6814-4600-8697-eb798ec5691f` | `az ad signed-in-user show --query id -o tsv` |
| Custom role `Lance principal secret writer` | `dcd10611-553f-42e2-911d-2904e3716c5e`, created by `infra/roles.bicep` | `az role definition list --custom-role-only true --name "Lance principal secret writer" --query "[0].name" -o tsv` |

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

## 2a. Create the custom role, once per subscription

`main.bicep` gives the api the custom role `Lance principal secret writer` on the principal vault (ADR 0022): set a secret, never read one. The deploy identity may not create role definitions, so Dom creates it with `infra/roles.bicep`, a subscription-scope template that needs no resource group. Both environments of a subscription share it, and `infra/deployer.bicep` declares the same definition (`github-deploy-setup.md`), so this step is skipped when the role exists:

```
az role definition list --custom-role-only true --name "Lance principal secret writer" --query "[0].name" -o tsv
```

If that prints nothing:

```
az deployment sub create \
  --name lance-roles \
  --location uksouth \
  --template-file infra/roles.bicep
```

The first command must then print `dcd10611-553f-42e2-911d-2904e3716c5e`.

## 3. Deploy the environment on the bootstrap image

`useBootstrapImage` is `true` in `dev.bicepparam`, so the three apps and the migration job run `mcr.microsoft.com/k8se/quickstart:latest`. Nothing needs the registry or a secret value yet.

The parameter file reads two values from the shell and refuses to compile without either. `LANCE_IMAGE_TAG` names the image tag; the bootstrap image ignores it, so any value does. `LANCE_EXISTING_SECRETS` lists the secrets already in the static vault, so the template creates a placeholder only for a missing one and never writes over a real value (`infra/modules/keyvault.bicep`). `scripts/existing-secrets.sh` reads the names from the control plane, never a value, and prints an empty line while the vault does not exist:

```
export LANCE_IMAGE_TAG=bootstrap
export LANCE_EXISTING_SECRETS=$(scripts/existing-secrets.sh dev)
echo "tag=${LANCE_IMAGE_TAG} existing=${LANCE_EXISTING_SECRETS:-none}"
```

1. Check the plan first. This is read-only:

   ```
   az deployment sub what-if \
     --location uksouth \
     --template-file infra/main.bicep \
     --parameters infra/params/dev.bicepparam
   ```

   The role assignments report as `Unsupported` because their names depend on principal ids that do not exist until the deploy runs. That is expected. On a clean subscription the plan creates both vaults and every secret in `infra/secrets.json` with the value `lance-placeholder-set-me`; the per-secret role assignments are scoped to those secrets, which is why they must exist.

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

   The deployment name defaults to `main`. The outputs give the static Key Vault name (`keyVaultName`), the principal vault name (`principalKeyVaultName`), the registry name and login server, the Postgres FQDN, the web and api hostnames, the migration job name, and the four identity names.

## 3b. Restart Postgres once

`shared_preload_libraries` (which preloads Apache AGE) is a static server parameter, so the first deploy leaves it pending until a restart. Do this once after the first deploy of an environment; later deploys do not change it:

```
az postgres flexible-server restart -g rg-lance-dev -n <postgres server name from the outputs>
az postgres flexible-server parameter show -g rg-lance-dev -s <server name> -n shared_preload_libraries --query value -o tsv
```

The second command must print `pg_cron,pg_stat_statements,age`.

## 3a. Confirm you can write secrets

Both vaults use RBAC, and the template grants you Key Vault Secrets Officer on each from `postgresEntraAdminObjectId`. Role assignments can take a few minutes to propagate. If `az keyvault secret set` returns `ForbiddenByRbac`, check the assignment exists and wait:

```
az role assignment list --scope $(az keyvault show -g rg-lance-dev -n <vault name> --query id -o tsv) \
  --query "[].{role:roleDefinitionName, principal:principalName}" -o table
```

Do not grant the role by hand. Azure keys role assignments by name, the template names its own deterministically, and a hand-made assignment for the same principal, role and scope makes the next deploy fail with `RoleAssignmentExists`. If the vault was deployed from a template older than this step, redeploy (step 3) and the assignment appears. If a hand-made one already exists, delete it first:

```
az role assignment delete --ids <assignment id from the list above>
```

## 4. Set the Key Vault secrets

The template created every static secret in `infra/secrets.json` with the placeholder `lance-placeholder-set-me` and granted each app `Key Vault Secrets User` on exactly the secrets it binds (ADR 0022). Replace the placeholders with the real values. A redeploy never writes a secret that exists, so a value set here survives every later deploy. Take the values from `entra-setup.md`, `slack-app-setup.md` and `rotate-secrets.md`.

```
KV=$(az deployment sub show -n main --query properties.outputs.keyVaultName.value -o tsv)
echo "$KV"

az keyvault secret set --vault-name $KV --name entra-tenant-id         --value '<directory tenant id>'
az keyvault secret set --vault-name $KV --name entra-client-id         --value '<application client id>'
az keyvault secret set --vault-name $KV --name entra-client-secret     --value '<client secret>'
az keyvault secret set --vault-name $KV --name auth-secret             --value "$(openssl rand -base64 32)"
az keyvault secret set --vault-name $KV --name slack-bot-token         --value 'xoxb-...'
az keyvault secret set --vault-name $KV --name slack-signing-secret    --value '<signing secret>'
az keyvault secret set --vault-name $KV --name anthropic-api-key       --value '<anthropic key>'
az keyvault secret set --vault-name $KV --name notion-token            --value '<notion integration token>'
az keyvault secret set --vault-name $KV --name agent-log-ingest-secret --value "$(openssl rand -hex 32)"
```

The evidence export's signing key (spec 4.4) is an Ed25519 private key, set from a file so its line breaks survive, and never kept on disk afterwards. Record the key id it prints in the ISO 27001 evidence register (`docs/compliance/iso27001-access-review.md`); an auditor checks a bundle's `signature.keyId` against it:

The `openssl` macOS ships is LibreSSL and has no Ed25519; use OpenSSL 3, which Homebrew installs at `/opt/homebrew/bin/openssl` (`brew install openssl@3` if it is missing):

```
OPENSSL=/opt/homebrew/bin/openssl
umask 077
$OPENSSL genpkey -algorithm ed25519 -out /tmp/evidence-signing-key.pem
az keyvault secret set --vault-name $KV --name evidence-signing-key --file /tmp/evidence-signing-key.pem --query name -o tsv
EVIDENCE_KEY_ID=$($OPENSSL pkey -in /tmp/evidence-signing-key.pem -pubout -outform DER | $OPENSSL dgst -sha256 | awk '{print substr($NF, 1, 16)}')
echo "$EVIDENCE_KEY_ID"
rm /tmp/evidence-signing-key.pem
```

The api resolves the key when its revision starts. On a new environment step 6 starts it after this; on an environment already running, restart the api once:

```
API_REVISION=$(az containerapp show -g rg-lance-dev -n ca-lance-api-dev --query properties.latestRevisionName -o tsv)
echo "$API_REVISION"
az containerapp revision restart -g rg-lance-dev -n ca-lance-api-dev --revision "$API_REVISION"
```

Until then the admin page's evidence export answers that the key is missing.

Leave `graph-refresh-token` and `jamie-api-key` as placeholders on a new environment. They are the pre-ADR 0022 single-owner credentials, read only for the one-time copy into Dom's own secrets (see the last section), and the apps read the placeholder as "not set". Each principal connects Microsoft 365 and Jamie for themselves, and those credentials land in the principal vault as `graph-refresh-token--<principalId>` and `jamie-api-key--<principalId>`; nothing is set there by hand. An environment deployed before ADR 0020 also holds `allowed-upn`; no app reads it, and it stays until someone deletes it deliberately.

The Notion token alone reaches nothing. The integration is the organisation's, named `Lance` (renamed from `Dom's Lance` for ADR 0022; renaming it in Notion under Settings, Connections, Develop or manage integrations keeps the same token). In Notion, open the All Tasks database, choose the three dots, Connections, and add the integration. The Meetings database is not in use (spec Q7) and is not shared. Until All Tasks is shared, every query returns `object_not_found` and the notion watcher raises a breaker alert on each poll. Check with:

```
curl -s https://api.notion.com/v1/data_sources/<tasks data source id> \
  -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2025-09-03" | head -c 300
```

Check that no placeholder is left among the values that must be real. This prints the value of each secret, so run it in a terminal nobody is watching; every line must say `set`, except the two legacy ones on a new environment:

```
for name in $(az keyvault secret list --vault-name $KV --query "[].name" -o tsv | sort); do
  value=$(az keyvault secret show --vault-name $KV --name "$name" --query value -o tsv)
  [ "$value" = lance-placeholder-set-me ] && echo "$name placeholder" || echo "$name set"
done
```

Check who may read what. The web identity must hold exactly four assignments, each at a secret's scope, and no identity may hold one at the vault's own scope except Dom:

```
WEB=$(az identity show -g rg-lance-dev -n id-lance-web-dev --query principalId -o tsv)
echo "$WEB"
az role assignment list --all --assignee "$WEB" \
  --query "[?contains(scope, '/vaults/')].{role:roleDefinitionName, scope:scope}" -o table
az role assignment list --scope $(az keyvault show -n $KV --query id -o tsv) \
  --query "[].{role:roleDefinitionName, who:principalName, type:principalType}" -o table
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

   The script reads `LANCE_EXISTING_SECRETS` itself (`scripts/existing-secrets.sh`) just before the what-if and the deployment, and after the deployment removes the vault-wide grants that templates before ADR 0022 made (`scripts/remove-legacy-vault-grants.sh`; it lists them first with `LANCE_DRY_RUN=1`). To read the plan first, run the what-if of step 3 with both variables exported: `LANCE_IMAGE_TAG=$TAG LANCE_EXISTING_SECRETS=$(scripts/existing-secrets.sh dev) az deployment sub what-if ...`. The three apps get new revisions that pull from the registry with their own identities and resolve the Key Vault references. The ingress target ports move from 80 to 3000 for web and 3001 for api.

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

The role names are case sensitive and the identity names must stay in double quotes.

Nobody grants `lance_retention` by hand. The migration job (step 8) grants it to the worker identity after the migrations and the seed, from the `LANCE_RETENTION_MEMBER` variable the template sets to the worker identity's name (`packages/db/src/grants.ts`, ADR 0011). The grant is `WITH INHERIT FALSE, SET TRUE`: the worker's sessions run as `lance_app` and gain nothing from it, and the nightly retention job uses it only through `SET LOCAL ROLE lance_retention` inside its own transaction. The migrate identity may make the grant because it created the role in migration 0000. The job needs the worker's Postgres principal from step 7; if the job ran before step 7, run it again after. Check, in the same psql session:

```sql
SELECT u.rolname AS member, m.inherit_option, m.set_option
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
  JOIN pg_roles u ON u.oid = m.member
 WHERE r.rolname = 'lance_retention';
```

One row: `id-lance-worker-dev | f | t`. No row names `lance_app`, `id-lance-api-dev` or `id-lance-web-dev`.

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

1. Open `https://<web hostname>` and sign in as Dom. Anyone without a Lance app role is refused by Microsoft before reaching Lance (ADR 0020).
2. Run `/lance status` in `dom-claude-agent`. The api answers with an ephemeral message and the ledger records a `state_changed` event.
3. In the web app, open Settings and press Connect Microsoft 365, then consent as Dom. The api writes `graph-refresh-token--<Dom's principal id>` in the principal vault, and the worker builds Dom's Graph connector from it at its next context build. Check the secret exists (names only):

   ```
   PKV=$(az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-p-dev-')].name" -o tsv)
   echo "$PKV"
   az keyvault secret list --vault-name $PKV --query "[].name" -o tsv
   ```
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

## Moving an environment to per-principal credentials (ADR 0022)

Once for an environment deployed before ADR 0022; dev needs it. Until it has run, the web identity can read every secret in the static vault, and the Graph token and the Jamie key are Dom's alone, in `graph-refresh-token` and `jamie-api-key`.

What each step consumes comes from the step before it. The order is fixed.

1. **Dom redeploys `infra/deployer.bicep` first, by hand, from the branch that carries ADR 0022** (`github-deploy-setup.md` step 1, the same two commands). It creates the custom role `Lance principal secret writer` (through its `roles.bicep` module) and widens the deploy identity's condition to let it assign that role. The what-if shows the role definition and the `lance-roles` deployment as new and the administrator assignment's condition as modified; nothing that `main.bicep` owns changes. Check:

   ```
   az role definition list --custom-role-only true --name "Lance principal secret writer" --query "[0].name" -o tsv
   az role assignment list -g rg-lance-dev --assignee 758df7e5-0d06-45da-aef0-d14b7a7e2c9f \
     --role "Role Based Access Control Administrator" --query "[0].condition" -o tsv | grep -c dcd10611
   ```

   The first prints `dcd10611-553f-42e2-911d-2904e3716c5e`; the second prints `1`. If the CD deploy runs before this step, it stops at the principal vault's api assignment with `AuthorizationFailed` or `RoleDefinitionDoesNotExist`. The apps stay on their old image in that case, because the Container Apps depend on both vault modules, and the migration job has only run migration 0015, which the old image ignores. Run this step and re-run the workflow.

2. **Merge; the `Deploy` workflow does the rest.** It runs migration 0015 on the new image, reads `LANCE_EXISTING_SECRETS` (the twelve dev secrets of ADR 0022 exist; `evidence-signing-key`, added by package 5.6, does not, so it alone is written as a placeholder and step 4 sets it), creates `kv-lance-p-dev-j7riq4` with its three assignments, creates the nineteen per-secret assignments on the static vault (the worker's existing Secrets Officer grant on `graph-refresh-token` is adopted, same name), moves the apps, and then `scripts/remove-legacy-vault-grants.sh` deletes the four vault-wide Secrets User assignments and the api's Secrets Officer grant on `graph-refresh-token`. To see in advance what the script will delete: `LANCE_DRY_RUN=1 scripts/remove-legacy-vault-grants.sh dev` (read-only; on 2026-09-24 it listed exactly those five).

3. **The worker copies Dom's credentials on its first start.** On first use for the principal whose UPN is `DOM_EMAIL`, it copies `graph-refresh-token` from the static vault into `graph-refresh-token--<Dom's principal id>` and `JAMIE_API_KEY` into `jamie-api-key--<Dom's principal id>`, each under the rotation lock and only when the per-principal secret is absent, and records a `state_changed` event with `change: credential_migrated` for each. The old secrets are never written. For the minute both revisions run, the old worker may still rotate the old secret; Entra keeps the previous refresh token valid, and if the copied one is ever refused the P0 `token_refresh_failed` alert asks Dom to reconnect from Settings, which writes the per-principal secret directly. Check:

   ```
   PKV=$(az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-p-dev-')].name" -o tsv)
   echo "$PKV"
   az keyvault secret list --vault-name $PKV --query "[].name" -o tsv
   scripts/psql-admin.sh lance \
     -c "SELECT set_config('app.principal', (SELECT id FROM principals WHERE upn = 'dom@valliance.ai'), false)" \
     -c "SELECT ts, payload FROM ledger_events WHERE payload->>'change' = 'credential_migrated' ORDER BY id"

   The first command scopes the session to Dom's principal; without it, row-level security returns no rows and the check looks as if nothing was copied (`docs/runbooks/observing.md`, "Reading principal-bearing tables").
   ```

   The vault lists two secrets named with Dom's principal id, and the query returns one row for `graph` and one for `jamie`. Then run the checks at the end of step 4 again: the web identity holds four secret-scoped assignments and nothing on either vault.

4. **Rename the Notion integration** from `Dom's Lance` to `Lance` in Notion (Settings, Connections, Develop or manage integrations). The token does not change and nothing is redeployed.

The fallback that copies the legacy credentials stays until dev and prod have each recorded both `credential_migrated` events. A follow-up change then removes `apps/worker/src/credentials/legacy.ts`, the worker's `KEY_VAULT_URL`, the `jamie-api-key` binding and the worker's Secrets Officer grant on `graph-refresh-token` from `infra/secrets.json`; after that deploy, Dom deletes the two old secrets by hand, since the template never deletes one.
