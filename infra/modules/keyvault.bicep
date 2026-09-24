// The static Key Vault: every secret that belongs to the environment rather than to
// a principal (ADR 0022). RBAC authorisation, soft delete and purge protection on.
// Spec 4.2: the Container Apps read these as Key Vault references at start.
//
// The secrets, the env names they bind to and the apps that may read each one are
// one table, infra/secrets.json, which modules/containerapps.bicep reads too. Each
// app holds Key Vault Secrets User on exactly the secrets the table gives it, one
// role assignment per (app, secret), never on the vault. The web app therefore reads
// its four secrets and nothing else. Per-principal credentials live in the second
// vault, modules/principal-vault.bicep.
//
// Placeholders. A role assignment can only be scoped to a secret that exists, so on
// the first deploy every secret in the table is created with the placeholder value
// below, and Dom replaces it with the real value (docs/runbooks/deploy.md step 4).
// A redeploy must never write over a real value, and ARM has no "create if absent":
// a PUT of Microsoft.KeyVault/vaults/secrets always writes a new current version.
// So the caller passes the names that already exist (existingSecretNames) and the
// template creates a placeholder only for a name not in that list. The list is read
// by scripts/deploy.sh from the control plane (GET .../vaults/<name>/secrets, which
// returns names and attributes, never values) immediately before the deployment,
// under the deploy identity's Contributor role, and reaches the template through
// LANCE_EXISTING_SECRETS in the parameter files. The parameter files refuse to
// compile without it, so no deployment runs with the list forgotten. A deployment
// script resource was the alternative; it needs its own managed identity with
// secret write rights, a storage account and a minute per deploy, and it would still
// have to make the same existence check.
//
// Dom's own Key Vault Secrets Officer assignment is vault wide, so he can set every
// value from the CLI; RBAC vaults give the deployer no data-plane access by default.
// Public network access stays on so the CLI reaches the vault from Dom's machine.

@description('Environment name, dev or prod.')
param environmentName string

@description('Azure region.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Entropy for the globally unique vault name.')
param uniqueSuffix string

@description('The managed identities from modules/identity.bicep, keyed by workload. The web, api and worker entries are read.')
param identities object

@description('Names of the secrets already in this vault, read by scripts/deploy.sh just before the deployment. A table secret missing from this list is created as a placeholder; one in it is never written.')
param existingSecretNames array

@description('Object id of the person who sets secret values from the CLI (Dom). Granted Key Vault Secrets Officer on the vault.')
param vaultWriterObjectId string

// Key Vault Secrets User. Read secret contents, nothing else.
// From: az role definition list --name "Key Vault Secrets User" --query "[0].name" -o tsv
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
// Key Vault Secrets Officer. Set, read and list secrets; no vault management.
// From: az role definition list --name "Key Vault Secrets Officer" --query "[0].name" -o tsv
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

// Written into a secret the template had to create. It is not a credential; the apps
// read it as "not set yet" (PLACEHOLDER_SECRET_VALUE in packages/shared).
var placeholderValue = 'lance-placeholder-set-me'

var secretTable = loadJsonContent('../secrets.json').secrets

var appPrincipalIds = {
  web: identities.web.principalId
  api: identities.api.principalId
  worker: identities.worker.principalId
}

// One row per (secret, app, role). secretIndex points into secretTable, so the
// assignment's scope can name the secret resource below.
var readGrants = flatten(map(
  range(0, length(secretTable)),
  i =>
    map(union(secretTable[i].bind, secretTable[i].sdkRead), app => {
      secretIndex: i
      app: app
      roleId: keyVaultSecretsUserRoleId
    })
))
var writeGrants = flatten(map(
  range(0, length(secretTable)),
  i =>
    map(secretTable[i].sdkWrite, app => {
      secretIndex: i
      app: app
      roleId: keyVaultSecretsOfficerRoleId
    })
))
var grants = concat(readGrants, writeGrants)

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

// Created only when absent; see the header. contentType marks it for anyone reading
// the vault in the portal.
resource placeholderSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for secret in secretTable: if (!contains(existingSecretNames, secret.name)) {
    parent: keyVault
    name: secret.name
    properties: {
      value: placeholderValue
      contentType: 'lance-placeholder'
    }
  }
]

resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [
  for secret in secretTable: {
    parent: keyVault
    name: secret.name
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

// Last in the module: a failing assignment must not strand anything else half applied.
// The name formula matches the per-secret assignment the template made before ADR
// 0022 (the worker's Officer grant on graph-refresh-token), so that one is adopted,
// not duplicated. The vault-wide Secrets User assignments of that template are not
// declared any more, and ARM's incremental mode does not delete what a template
// stops declaring, so scripts/deploy.sh removes them after the deployment.
resource secretGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for grant in grants: {
    scope: secrets[grant.secretIndex]
    name: guid(keyVault.id, secretTable[grant.secretIndex].name, appPrincipalIds[grant.app], grant.roleId)
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', grant.roleId)
      principalId: appPrincipalIds[grant.app]
      principalType: 'ServicePrincipal'
    }
    dependsOn: [
      placeholderSecrets
    ]
  }
]

output vaultName string = keyVault.name
output vaultId string = keyVault.id
output vaultUri string = keyVault.properties.vaultUri
