// Key Vault for every Lance secret. RBAC authorisation, soft delete and purge
// protection on. Spec 4.2: all secrets live here and the Container Apps read them
// as Key Vault references at start.
//
// This template creates the vault and the role assignments only. It never creates a
// secret value. The secrets Lance expects, and where each one comes from:
//
//   entra-tenant-id          Directory (tenant) id            docs/runbooks/entra-setup.md
//   entra-client-id          Application (client) id          docs/runbooks/entra-setup.md
//   entra-client-secret      Entra app client secret          docs/runbooks/entra-setup.md
//   allowed-upn              The single UPN allowed to sign in docs/runbooks/entra-setup.md
//   auth-secret              openssl rand -base64 32, Auth.js   docs/runbooks/deploy.md
//   graph-refresh-token      Written by api on first consent   docs/runbooks/entra-setup.md
//   slack-bot-token          Slack bot OAuth token             docs/runbooks/slack-app-setup.md
//   slack-signing-secret     Slack signing secret              docs/runbooks/slack-app-setup.md
//   anthropic-api-key        Anthropic console                 docs/runbooks/rotate-secrets.md
//   notion-token             Notion internal integration       docs/runbooks/rotate-secrets.md
//   jamie-api-key            Jamie read-only key               docs/runbooks/rotate-secrets.md
//   agent-log-ingest-secret  openssl rand -hex 32              docs/runbooks/rotate-secrets.md
//
// Dom sets the values from the CLI after the first deploy. See step 4 of
// docs/runbooks/deploy.md. Public network access stays on so that the CLI can reach
// the vault from Dom's machine without a private endpoint or a jump host. Phase 5
// revisits this alongside the Postgres private endpoint.

@description('Environment name, dev or prod.')
param environmentName string

@description('Azure region.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Entropy for the globally unique vault name.')
param uniqueSuffix string

@description('Principal ids granted Key Vault Secrets User. The four managed identities.')
param secretsUserPrincipalIds array

@description('Object id of the person who sets secret values from the CLI (Dom). Granted Key Vault Secrets Officer on the vault; RBAC vaults give the deployer no data-plane access by default.')
param vaultWriterObjectId string

// Key Vault Secrets User. Read secret contents, nothing else.
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
// Key Vault Secrets Officer. Set, read and list secrets; no vault management.
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource keyVault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: 'kv-lance-${environmentName}-${uniqueSuffix}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource secretsUserAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in secretsUserPrincipalIds: {
    scope: keyVault
    name: guid(keyVault.id, principalId, keyVaultSecretsUserRoleId)
    properties: {
      roleDefinitionId: subscriptionResourceId(
        'Microsoft.Authorization/roleDefinitions',
        keyVaultSecretsUserRoleId
      )
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

resource secretsOfficerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, vaultWriterObjectId, keyVaultSecretsOfficerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      keyVaultSecretsOfficerRoleId
    )
    principalId: vaultWriterObjectId
    principalType: 'User'
  }
}

output vaultName string = keyVault.name
output vaultId string = keyVault.id
output vaultUri string = keyVault.properties.vaultUri
