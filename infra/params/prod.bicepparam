using '../main.bicep'

param environmentName = 'prod'
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

// Prod never deploys on the bootstrap image. Set containerImageTag to the immutable
// tag that CI pushed and that dev has already run.
param useBootstrapImage = false
param containerImageTag = 'latest'

param allowedUpn = 'dom@valliance.ai'
