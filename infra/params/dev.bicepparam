using '../main.bicep'

param environmentName = 'dev'
param location = 'uksouth'

// Dom's Entra object id, from: az ad signed-in-user show --query id -o tsv
param postgresEntraAdminObjectId = '19fb2afd-6814-4600-8697-eb798ec5691f'
param postgresEntraAdminPrincipalName = 'dom@valliance.ai'

// Password fallback only (ADR 0008). Nothing in the running system uses it. Export
// LANCE_PG_ADMIN_PASSWORD in the deploying shell; never commit a value here.
param postgresPasswordAuthEnabled = false
param postgresAdministratorPassword = readEnvironmentVariable('LANCE_PG_ADMIN_PASSWORD', '')

// Bootstrap: the environment stands up on the public quickstart image. Flip to false
// once az acr build has pushed lance-web, lance-api and lance-worker, and set
// containerImageTag to the tag that was pushed.
param useBootstrapImage = false
param containerImageTag = 'e9dbbd6'

param allowedUpn = 'dom@valliance.ai'
// Dom's Slack user id in the Valliance workspace. Not a secret.
param slackAllowedUserId = 'U0BN7JN7BAN'

// The executor's write flags. Both stay false for the dry-run week; flip them to
// true and redeploy on the day Lance goes live (docs/runbooks/deploy.md, going live).
param graphWritesEnabled = false
param notionWritesEnabled = false
