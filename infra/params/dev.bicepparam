using '../main.bicep'

param environmentName = 'dev'
param location = 'uksouth'

// MUST BE FILLED before the first deploy. This placeholder is not a valid principal
// and the deployment will fail on it. Get the real value with:
//   az ad signed-in-user show --query id -o tsv
param postgresEntraAdminObjectId = '00000000-0000-0000-0000-000000000000'
param postgresEntraAdminPrincipalName = 'dom@valliance.ai'

// Password fallback only (ADR 0008). Nothing in the running system uses it. Export
// LANCE_PG_ADMIN_PASSWORD in the deploying shell; never commit a value here.
param postgresPasswordAuthEnabled = false
param postgresAdministratorPassword = readEnvironmentVariable('LANCE_PG_ADMIN_PASSWORD', '')

// Bootstrap: the environment stands up on the public quickstart image. Flip to false
// once az acr build has pushed lance-web, lance-api and lance-worker, and set
// containerImageTag to the tag that was pushed.
param useBootstrapImage = true
param containerImageTag = 'bootstrap'

param allowedUpn = 'dom@valliance.ai'
