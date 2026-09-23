// The GitHub Actions identities for one Lance environment. Subscription scope.
//
// Dom deploys this template once per environment, by hand, after the first deploy of
// main.bicep has created the resource group. CI never deploys it: the identities it
// creates are the ones CI runs as, and a deployment cannot grant its own identity the
// rights it is about to need. ADR 0014.
//
// Two user-assigned managed identities, both trusting GitHub's OIDC issuer for this
// repository only, so there is no client secret anywhere:
//   - id-lance-github-deploy-<env> runs .github/workflows/deploy.yml. It pushes the
//     images, deploys main.bicep and starts the migration job. Contributor on the
//     resource group, Role Based Access Control Administrator on the group limited to
//     the four roles main.bicep assigns, and the custom "Lance deployment writer" role
//     at subscription scope so it can create subscription-scope deployments.
//   - id-lance-github-plan-<env> runs the what-if in .github/workflows/ci.yml. Reader on
//     the group and the custom "Lance deployment reader" role at subscription scope.
//
// Contributor at subscription scope would also work and is what the built-in roles
// offer, but the subscription is shared with other Valliance projects, so the
// subscription-scope grant is the smallest custom role that lets a deployment run.

targetScope = 'subscription'

@description('Environment name. Selects the resource group and names the identities.')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Azure region for the identities.')
param location string = 'uksouth'

@description('Resource group main.bicep created for this environment.')
param resourceGroupName string = 'rg-lance-${environmentName}'

@description('GitHub repository, owner/name, whose workflows may use the identities.')
param githubRepository string = 'dom-valliance/lance'

@description('GitHub Actions environment that deploy.yml deploys through. Its OIDC subject is the only one the deploy identity trusts.')
param githubEnvironment string = environmentName

// The built-in roles main.bicep assigns, one per module that assigns it. The deploy
// identity may assign these and no others; a new role assignment in main.bicep needs
// its id added here first, and scripts/check-deployer-roles.sh fails CI otherwise.
// Ids from: az role definition list --name "<role>" --query "[0].name" -o tsv
var assignableRoleIds = [
  '7f951dda-4ed3-4680-a7ca-43fe172d538d' // AcrPull, modules/registry.bicep
  '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User, modules/keyvault.bicep
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7' // Key Vault Secrets Officer, modules/keyvault.bicep
  '73c42c96-874c-492b-b04d-ab87d138a893' // Log Analytics Reader, modules/containerapps.bicep
]

var deployIdentityName = 'id-lance-github-deploy-${environmentName}'
var planIdentityName = 'id-lance-github-plan-${environmentName}'

var tags = {
  application: 'lance'
  environment: environmentName
  managedBy: 'bicep'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2021-04-01' existing = {
  name: resourceGroupName
}

module identities 'modules/deployer.bicep' = {
  scope: resourceGroup
  name: 'deployer-identities'
  params: {
    location: location
    tags: tags
    githubRepository: githubRepository
    githubEnvironment: githubEnvironment
    assignableRoleIds: assignableRoleIds
    deployIdentityName: deployIdentityName
    planIdentityName: planIdentityName
  }
}

// Everything a subscription-scope deployment does at subscription scope: create the
// deployment resource and follow it. The resources the deployment creates are covered
// by Contributor on the resource group, granted in the module above.
resource deploymentWriterRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'lance-deployment-writer')
  properties: {
    roleName: 'Lance deployment writer'
    description: 'Create, validate and follow subscription-scope deployments. Grants nothing on the resources a deployment creates.'
    type: 'CustomRole'
    assignableScopes: [
      subscription().id
    ]
    permissions: [
      {
        actions: [
          'Microsoft.Resources/deployments/read'
          'Microsoft.Resources/deployments/write'
          'Microsoft.Resources/deployments/validate/action'
          'Microsoft.Resources/deployments/whatIf/action'
          'Microsoft.Resources/deployments/operations/read'
          'Microsoft.Resources/deployments/operationstatuses/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

// The read-only half: what-if and validate, for pull requests.
resource deploymentReaderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, 'lance-deployment-reader')
  properties: {
    roleName: 'Lance deployment reader'
    description: 'Validate and what-if subscription-scope deployments and read existing ones. Cannot create a deployment.'
    type: 'CustomRole'
    assignableScopes: [
      subscription().id
    ]
    permissions: [
      {
        actions: [
          'Microsoft.Resources/deployments/read'
          'Microsoft.Resources/deployments/validate/action'
          'Microsoft.Resources/deployments/whatIf/action'
          'Microsoft.Resources/deployments/operations/read'
          'Microsoft.Resources/deployments/operationstatuses/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource deployWriterAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, deployIdentityName, deploymentWriterRole.id)
  properties: {
    roleDefinitionId: deploymentWriterRole.id
    principalId: identities.outputs.deployPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource planReaderAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, planIdentityName, deploymentReaderRole.id)
  properties: {
    roleDefinitionId: deploymentReaderRole.id
    principalId: identities.outputs.planPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('Client id for the AZURE_CLIENT_ID secret of the GitHub environment named by githubEnvironment.')
output deployClientId string = identities.outputs.deployClientId

@description('Client id for the repository-level AZURE_CLIENT_ID secret that the CI what-if uses.')
output planClientId string = identities.outputs.planClientId

output deployIdentityName string = deployIdentityName
output planIdentityName string = planIdentityName
output tenantId string = tenant().tenantId
output subscriptionId string = subscription().subscriptionId
