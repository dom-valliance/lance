// Lance infrastructure, subscription scope.
// Creates the resource group and every resource the three Container Apps need.
// Manual steps that this template deliberately does not do:
//   - Entra app registration (docs/runbooks/entra-setup.md)
//   - Slack app creation (docs/runbooks/slack-app-setup.md)
//   - Key Vault secret values (docs/runbooks/deploy.md, step 4). The template creates
//     each static secret as a placeholder when it is missing and never writes one that
//     exists (modules/keyvault.bicep, ADR 0022)
//   - The custom role the api holds on the principal vault, defined in deployer.bicep
//   - Postgres principals for the managed identities (docs/runbooks/deploy.md, step 7)
//   - The GitHub Actions identities that deploy this template (deployer.bicep,
//     docs/runbooks/github-deploy-setup.md), which CI cannot grant to itself
// The image tag arrives in LANCE_IMAGE_TAG through the parameter files; deploy.yml
// sets it to the short SHA it built, scripts/deploy.sh exports it for a manual run.

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

@description('Enable Postgres password authentication alongside Entra. Off by default: the admin password is the one credential that could disable the ledger guard, and nothing in the running system uses it (ADR 0008 keeps it as a fallback only).')
param postgresPasswordAuthEnabled bool = false

@description('Postgres administrator login, used only when password authentication is enabled.')
param postgresAdministratorLogin string = 'lanceadmin'

@description('Password for the Postgres administrator login, used only when password authentication is enabled. Supply it from the shell at deploy time; never commit it.')
@secure()
param postgresAdministratorPassword string = ''

@description('Tag on the three container images in the registry.')
param containerImageTag string = 'bootstrap'

@description('When true the three apps and the migration job run the public quickstart image, so the environment can stand up before any image is pushed. Flip to false once the real images are in the registry.')
param useBootstrapImage bool = true

@description('Names of the secrets already in the static vault. scripts/deploy.sh reads them from the control plane just before the deployment and passes them through LANCE_EXISTING_SECRETS; a secret in infra/secrets.json that is missing here is created as a placeholder, one that is present is never written.')
param existingStaticSecretNames array

@description('The one Slack user id that may run /lance status, pause and resume. Not a secret.')
param slackAllowedUserId string

@description('Lets the executor write to Microsoft Graph. Off until the dry-run week is over (spec 6.3).')
param graphWritesEnabled bool = false

@description('Lets the executor create tasks in the Notion All Tasks database. Off until the dry-run week is over (spec 6.3).')
param notionWritesEnabled bool = false

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
    identities: identity.outputs.identities
    existingSecretNames: existingStaticSecretNames
    vaultWriterObjectId: postgresEntraAdminObjectId
  }
}

module principalVault 'modules/principal-vault.bicep' = {
  scope: resourceGroup
  name: 'principal-vault'
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    uniqueSuffix: uniqueSuffix
    identities: identity.outputs.identities
    vaultWriterObjectId: postgresEntraAdminObjectId
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
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    passwordAuthEnabled: postgresPasswordAuthEnabled
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
    principalKeyVaultUri: principalVault.outputs.vaultUri
    registryLoginServer: registry.outputs.loginServer
    postgresFqdn: postgres.outputs.fqdn
    identities: identity.outputs.identities
    containerImageTag: containerImageTag
    useBootstrapImage: useBootstrapImage
    slackAllowedUserId: slackAllowedUserId
    graphWritesEnabled: graphWritesEnabled
    notionWritesEnabled: notionWritesEnabled
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
    retentionMemberName: identity.outputs.identities.worker.name
    containerImageTag: containerImageTag
    useBootstrapImage: useBootstrapImage
  }
}

output resourceGroupNameOut string = resourceGroup.name
output keyVaultName string = keyVault.outputs.vaultName
output principalKeyVaultName string = principalVault.outputs.vaultName
output registryLoginServer string = registry.outputs.loginServer
output registryName string = registry.outputs.registryName
output postgresFqdn string = postgres.outputs.fqdn
output postgresServerName string = postgres.outputs.serverName
output webFqdn string = containerApps.outputs.webFqdn
output apiFqdn string = containerApps.outputs.apiFqdn
output migrateJobName string = migrateJob.outputs.jobName
output identityNames object = identity.outputs.identityNames
