// Lance infrastructure, subscription scope.
// Creates the resource group and every resource the three Container Apps need.
// Manual steps that this template deliberately does not do:
//   - Entra app registration (docs/runbooks/entra-setup.md)
//   - Slack app creation (docs/runbooks/slack-app-setup.md)
//   - Key Vault secret values (docs/runbooks/deploy.md, step 4)
//   - Postgres principals for the managed identities (docs/runbooks/deploy.md, step 8)

targetScope = 'subscription'

@description('Environment name. Drives resource names and Postgres sizing.')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Azure region for every resource.')
param location string = 'uksouth'

@description('Resource group to create and deploy into.')
param resourceGroupName string = 'rg-lance-${environmentName}'

@description('Object id of the Entra principal that becomes the Postgres Entra administrator. Dom runs the first migration and creates the managed identity principals from this account. ADR 0008.')
param postgresEntraAdminObjectId string

@description('Principal name of the Postgres Entra administrator, normally Dom\'s UPN.')
param postgresEntraAdminPrincipalName string

@description('Postgres administrator login for the password fallback that ADR 0008 allows. Password authentication stays enabled so the fallback exists, but nothing in the running system uses it.')
param postgresAdministratorLogin string = 'lanceadmin'

@description('Password for the Postgres administrator login. Supply it from the shell at deploy time; never commit it. See docs/runbooks/deploy.md.')
@secure()
param postgresAdministratorPassword string

@description('Tag on the three container images in the registry.')
param containerImageTag string = 'bootstrap'

@description('When true the three apps and the migration job run the public quickstart image, so the environment can stand up before any image is pushed. Flip to false once the real images are in the registry.')
param useBootstrapImage bool = true

@description('The single UPN allowed to sign in to the web app in v1. Spec 4.1.')
param allowedUpn string

// Six characters of subscription-and-group entropy for the three globally unique names
// (Key Vault, container registry, Postgres server).
var uniqueSuffix = take(uniqueString(subscription().subscriptionId, resourceGroupName), 6)

var tags = {
  application: 'lance'
  environment: environmentName
  managedBy: 'bicep'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module monitoring 'modules/monitoring.bicep' = {
  scope: resourceGroup
  name: 'monitoring'
  params: {
    environmentName: environmentName
    location: location
    tags: tags
  }
}

module identity 'modules/identity.bicep' = {
  scope: resourceGroup
  name: 'identity'
  params: {
    environmentName: environmentName
    location: location
    tags: tags
  }
}

module keyVault 'modules/keyvault.bicep' = {
  scope: resourceGroup
  name: 'keyvault'
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    uniqueSuffix: uniqueSuffix
    secretsUserPrincipalIds: identity.outputs.principalIds
  }
}

module registry 'modules/registry.bicep' = {
  scope: resourceGroup
  name: 'registry'
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    uniqueSuffix: uniqueSuffix
    acrPullPrincipalIds: identity.outputs.principalIds
  }
}

module postgres 'modules/postgres.bicep' = {
  scope: resourceGroup
  name: 'postgres'
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    uniqueSuffix: uniqueSuffix
    entraAdminObjectId: postgresEntraAdminObjectId
    entraAdminPrincipalName: postgresEntraAdminPrincipalName
    administratorLogin: postgresAdministratorLogin
    administratorPassword: postgresAdministratorPassword
  }
}

module containerApps 'modules/containerapps.bicep' = {
  scope: resourceGroup
  name: 'containerapps'
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    logAnalyticsWorkspaceName: monitoring.outputs.logAnalyticsWorkspaceName
    applicationInsightsConnectionString: monitoring.outputs.applicationInsightsConnectionString
    keyVaultUri: keyVault.outputs.vaultUri
    registryLoginServer: registry.outputs.loginServer
    postgresFqdn: postgres.outputs.fqdn
    identities: identity.outputs.identities
    containerImageTag: containerImageTag
    useBootstrapImage: useBootstrapImage
    allowedUpn: allowedUpn
  }
  // The apps resolve Key Vault references and pull from the registry with their
  // identities. Both role assignments are created inside those modules, and the
  // parameters above reference their outputs, so the ordering is already implied.
}

module migrateJob 'modules/migrate-job.bicep' = {
  scope: resourceGroup
  name: 'migrate-job'
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    managedEnvironmentId: containerApps.outputs.managedEnvironmentId
    registryLoginServer: registry.outputs.loginServer
    postgresFqdn: postgres.outputs.fqdn
    migrateIdentity: identity.outputs.identities.migrate
    containerImageTag: containerImageTag
    useBootstrapImage: useBootstrapImage
  }
}

output resourceGroupNameOut string = resourceGroup.name
output keyVaultName string = keyVault.outputs.vaultName
output registryLoginServer string = registry.outputs.loginServer
output registryName string = registry.outputs.registryName
output postgresFqdn string = postgres.outputs.fqdn
output postgresServerName string = postgres.outputs.serverName
output webFqdn string = containerApps.outputs.webFqdn
output apiFqdn string = containerApps.outputs.apiFqdn
output migrateJobName string = migrateJob.outputs.jobName
output identityNames object = identity.outputs.identityNames
