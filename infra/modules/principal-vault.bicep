// The principal vault: one secret per (principal, connector), written at onboarding
// and at run time, never by this template (ADR 0022). Secret names:
//
//   graph-refresh-token--<principalId>    written by the api at consent, rotated by the worker
//   jamie-api-key--<principalId>          written by the api after a test call succeeds
//   foundry-refresh-token--<principalId>  reserved for Phase 7; nothing writes it yet
//
// Because the secrets do not exist when the template runs, access is granted on the
// vault, per identity, and the roles are what separate them:
//
//   worker  Key Vault Secrets Officer: read, set (rotation) and list
//   api     Lance principal secret writer (custom, infra/deployer.bicep): set only,
//           so onboarding can store a credential it can never read back
//   web     nothing
//   Dom     Key Vault Secrets Officer, as on the static vault, for repairs
//
// Same protections as the static vault: RBAC, soft delete, purge protection. The
// name is kv-lance-p-<env>-<suffix>, at most 22 characters for prod against Key
// Vault's limit of 24.

@description('Environment name, dev or prod.')
param environmentName string

@description('Azure region.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Entropy for the globally unique vault name; the same suffix as the static vault.')
param uniqueSuffix string

@description('The managed identities from modules/identity.bicep, keyed by workload. The api and worker entries are read.')
param identities object

@description('Object id of the person who repairs secrets from the CLI (Dom). Granted Key Vault Secrets Officer on the vault.')
param vaultWriterObjectId string

// Key Vault Secrets Officer. Set, read and list secrets; no vault management.
// From: az role definition list --name "Key Vault Secrets Officer" --query "[0].name" -o tsv
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
// Lance principal secret writer: the one data action
// Microsoft.KeyVault/vaults/secrets/setSecret/action. Defined by infra/deployer.bicep,
// which Dom deploys by hand, because the deploy identity may not create roles.
// From: az role definition list --custom-role-only true --name "Lance principal secret writer" --query "[0].name" -o tsv
var principalSecretWriterRoleId = 'dcd10611-553f-42e2-911d-2904e3716c5e'

resource vault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: 'kv-lance-p-${environmentName}-${uniqueSuffix}'
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

resource workerOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, identities.worker.principalId, keyVaultSecretsOfficerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      keyVaultSecretsOfficerRoleId
    )
    principalId: identities.worker.principalId
    principalType: 'ServicePrincipal'
  }
}

resource apiWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, identities.api.principalId, principalSecretWriterRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      principalSecretWriterRoleId
    )
    principalId: identities.api.principalId
    principalType: 'ServicePrincipal'
  }
}

resource writerOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, vaultWriterObjectId, keyVaultSecretsOfficerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      keyVaultSecretsOfficerRoleId
    )
    principalId: vaultWriterObjectId
    principalType: 'User'
  }
}

output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
