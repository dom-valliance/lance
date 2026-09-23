// The GitHub Actions deploy identity for one environment, its federated credential
// and its resource group roles. Deployed by infra/deployer.bicep, never by CI.

@description('Azure region.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('GitHub repository, owner/name.')
param githubRepository string

@description('Numeric id of the repository owner.')
param githubOwnerId string

@description('Numeric id of the repository.')
param githubRepositoryId string

@description('GitHub Actions environment whose OIDC subject the deploy identity trusts.')
param githubEnvironment string

@description('Role definition ids the deploy identity may assign. Everything else is refused by the condition on its Role Based Access Control Administrator assignment.')
param assignableRoleIds array

@description('Name of the deploy identity. Set by the parent so the subscription-scope assignment can be named before the identity exists.')
param deployIdentityName string

var githubIssuer = 'https://token.actions.githubusercontent.com'

// The subject GitHub presents names the owner and repository with their numeric ids:
// repo:dom-valliance@215853107/lance@1378678734:environment:dev. Entra compares the
// whole string, so the ids are part of the subject. The value a run presents is
// printed by azure/login under "subject claim" when a login fails.
var githubRepositorySubject = '${split(githubRepository, '/')[0]}@${githubOwnerId}/${split(githubRepository, '/')[1]}@${githubRepositoryId}'

// Ids from: az role definition list --name "<role>" --query "[0].name" -o tsv
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var rbacAdministratorRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'

// Azure ABAC condition, version 2.0: a role assignment may be written or deleted only
// when the role being assigned is one of assignableRoleIds. The deploy identity can
// therefore never grant Owner, Contributor or its own administrator role to anyone.
var assignableRoleGuids = join(assignableRoleIds, ', ')
var roleAssignmentCondition = '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${assignableRoleGuids}})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${assignableRoleGuids}}))'

resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: deployIdentityName
  location: location
  tags: tags
}

// deploy.yml runs its jobs through the GitHub environment, so the token's subject is
// the environment's, whichever branch the run was started from. Branch restrictions
// belong on the GitHub environment, not here.
resource deployCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployIdentity
  name: 'github-environment-${githubEnvironment}'
  properties: {
    issuer: githubIssuer
    subject: 'repo:${githubRepositorySubject}:environment:${githubEnvironment}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// Assignment names are keyed on the identity name, which is known before the
// deployment starts; the principal id is not.
// Contributor covers every resource main.bicep creates, the nested resource group
// deployments, image pushes to the registry (Microsoft.ContainerRegistry/registries/push/write
// is a control-plane action inside Contributor's wildcard), starting the migration job
// and reading console logs. It excludes Microsoft.Authorization writes, hence the
// administrator assignment below.
resource deployContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(resourceGroup().id, deployIdentity.name, contributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: deployIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource deployRbacAdministrator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(resourceGroup().id, deployIdentity.name, rbacAdministratorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdministratorRoleId)
    principalId: deployIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    condition: roleAssignmentCondition
    conditionVersion: '2.0'
  }
}

output deployPrincipalId string = deployIdentity.properties.principalId
output deployClientId string = deployIdentity.properties.clientId
