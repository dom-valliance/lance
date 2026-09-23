# infra

Bicep for Lance on Azure. One subscription-scope template creates the resource group and calls one module per concern. `docs/runbooks/deploy.md` is the procedure; this file is the map.

## Layout

```
main.bicep                 Subscription scope. Resource group plus every module.
params/dev.bicepparam      Dev values. Bootstrap image on, geo-redundant backup off.
params/prod.bicepparam     Prod values. Real images, geo-redundant backup on.
deployer.bicep             Subscription scope. The two GitHub Actions identities for one
                           environment and their roles. Deployed once by Dom, never by CI.
params/deployer-dev.bicepparam  Dev values for deployer.bicep: repository and environment name.
modules/deployer.bicep     The identities, their federated credentials and group roles.
modules/monitoring.bicep   Log Analytics and Application Insights.
modules/identity.bicep     Four user-assigned managed identities.
modules/keyvault.bicep     Key Vault and the secret read grants.
modules/registry.bicep     Container registry and the pull grants.
modules/postgres.bicep     Postgres 16 Flexible Server, AGE and pgvector allowlisted.
modules/containerapps.bicep  Managed environment and the three apps.
modules/migrate-job.bicep  Manual-trigger migration job.
docker/                    Local Postgres image for docker-compose. Not deployed.
```

## What each module does

**monitoring** One Log Analytics workspace at 30 day retention and one workspace-based Application Insights component. The Container Apps environment ships its logs to the workspace; the apps export OpenTelemetry to Application Insights.

**identity** `id-lance-web-<env>`, `id-lance-api-<env>`, `id-lance-worker-<env>` and `id-lance-migrate-<env>`. These names are also the Postgres principal names created after the first deploy, so they are load bearing in three places: the identity itself, `PG_USER` on the container, and `pgaadauth_create_principal` in the runbook. ADR 0008.

**keyvault** RBAC authorisation, soft delete, purge protection, public network access on so Dom can set values from the CLI. The four identities get `Key Vault Secrets User`. The module documents the eleven secret names Lance expects and creates none of the values.

**registry** Basic sku, admin user disabled. The four identities get `AcrPull`. Pushes come from `.github/workflows/deploy.yml` under the deploy identity's Contributor role, or from `az acr build` under Dom's own credentials on a manual deploy.

**deployer** (`deployer.bicep`, not part of `main.bicep`) `id-lance-github-deploy-<env>`, a user-assigned identity with a federated credential for GitHub's OIDC issuer bound to the GitHub environment of the same name, so the workflow holds no secret. Contributor on the group, Role Based Access Control Administrator on the group with a condition limiting it to the four roles `main.bicep` assigns, and the custom `Lance deployment writer` role at subscription scope. There is no read-only identity for pull requests: a what-if needs the same rights as a deployment, so it runs in `deploy.yml` under this identity. Dom deploys the template once per environment (`docs/runbooks/github-deploy-setup.md`); `scripts/check-deployer-roles.sh` keeps its allowed-role list in step with the modules. ADR 0014.

**postgres** Version 16 per ADR 0004. Burstable B1ms for dev, General Purpose D2ds_v5 for prod, 32 GB, 35 day backups, geo-redundant only in prod. Entra authentication with Dom as administrator, password authentication left enabled as the ADR 0008 fallback. `azure.extensions` is set to `AGE,VECTOR` so the migrations can create both. One firewall rule allows Azure services and nothing else. Prod moves to a private endpoint in Phase 5.

**containerapps** The managed environment bound to the Log Analytics workspace, then `ca-lance-web-<env>`, `ca-lance-api-<env>` and `ca-lance-worker-<env>`. Each app carries its own identity, pulls with that identity, and reads its secrets as Key Vault references resolved with the same identity. Web is external on 3000 and api on 3001; worker has no ingress. Worker holds at one replica, web and api scale 1 to 2 on HTTP concurrency. While `useBootstrapImage` is true the apps run the public quickstart image on port 80 with no registry and no secret references, so the environment stands up before the first image is pushed.

**migrate-job** `caj-lance-migrate-<env>`, manual trigger only, worker image, runs the migrations and the idempotent seed with tsx. Its identity is the one granted `lance_migrator`, so no running app can migrate.

## Read-only checks

None of these change anything in Azure.

```
az bicep build --file infra/main.bicep --stdout > /dev/null
az bicep lint  --file infra/main.bicep
az bicep build --file infra/deployer.bicep --stdout > /dev/null
az bicep lint  --file infra/deployer.bicep

export LANCE_IMAGE_TAG=$(git rev-parse --short HEAD)

az deployment sub validate --location uksouth \
  --template-file infra/main.bicep --parameters infra/params/dev.bicepparam

az deployment sub what-if --location uksouth \
  --template-file infra/main.bicep --parameters infra/params/dev.bicepparam
```

The parameter files read the image tag from `LANCE_IMAGE_TAG` and refuse to compile without it; for a what-if, the tag dev is running keeps image changes out of the report (`az containerapp show -g rg-lance-dev -n ca-lance-api-dev --query "properties.template.containers[0].image" -o tsv`).

What-if reports the eight role assignments as `Unsupported`. Their resource names are a `guid()` of principal ids that do not exist until the deploy runs, so what-if cannot resolve them. Every other resource shows as `Create` on a clean subscription.

CI runs the build, the lint, the parameter compile and the deployer role check on every pull request, without logging in to Azure. `.github/workflows/deploy.yml` deploys `main` to dev after a green CI run, and its deploy step opens with the what-if (spec 3.2).
