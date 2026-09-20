// Azure Container Registry for the three Lance images: lance-web, lance-api, lance-worker.
// Basic sku is enough for one developer and one environment. Admin user is disabled:
// every pull goes through a managed identity with AcrPull, and pushes go through
// az acr build under Dom's own credentials.

@description('Environment name, dev or prod.')
param environmentName string

@description('Azure region.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Entropy for the globally unique registry name.')
param uniqueSuffix string

@description('Principal ids granted AcrPull. The four managed identities.')
param acrPullPrincipalIds array

// AcrPull. Pull images, nothing else.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource registry 'Microsoft.ContainerRegistry/registries@2025-05-01-preview' = {
  name: 'acrlance${environmentName}${uniqueSuffix}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource acrPullAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in acrPullPrincipalIds: {
    scope: registry
    name: guid(registry.id, principalId, acrPullRoleId)
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

output registryName string = registry.name
output registryId string = registry.id
output loginServer string = registry.properties.loginServer
