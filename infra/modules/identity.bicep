// One user-assigned managed identity per Container App, plus one for the migration job.
// Each identity name is also the Postgres principal name created by
// pgaadauth_create_principal after the first deploy (ADR 0008), so the names here
// are load bearing and match PG_USER in containerapps.bicep and migrate-job.bicep.

@description('Environment name, dev or prod.')
param environmentName string

@description('Azure region.')
param location string

@description('Tags applied to every resource.')
param tags object

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-lance-web-${environmentName}'
  location: location
  tags: tags
}

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-lance-api-${environmentName}'
  location: location
  tags: tags
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-lance-worker-${environmentName}'
  location: location
  tags: tags
}

resource migrateIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-lance-migrate-${environmentName}'
  location: location
  tags: tags
}

@description('Every identity, keyed by the workload that uses it.')
output identities object = {
  web: {
    name: webIdentity.name
    id: webIdentity.id
    clientId: webIdentity.properties.clientId
    principalId: webIdentity.properties.principalId
  }
  api: {
    name: apiIdentity.name
    id: apiIdentity.id
    clientId: apiIdentity.properties.clientId
    principalId: apiIdentity.properties.principalId
  }
  worker: {
    name: workerIdentity.name
    id: workerIdentity.id
    clientId: workerIdentity.properties.clientId
    principalId: workerIdentity.properties.principalId
  }
  migrate: {
    name: migrateIdentity.name
    id: migrateIdentity.id
    clientId: migrateIdentity.properties.clientId
    principalId: migrateIdentity.properties.principalId
  }
}

@description('Principal ids of all four identities, for role assignments.')
output principalIds array = [
  webIdentity.properties.principalId
  apiIdentity.properties.principalId
  workerIdentity.properties.principalId
  migrateIdentity.properties.principalId
]

@description('Identity names, which are also the Postgres principal names to create after the first deploy.')
output identityNames object = {
  web: webIdentity.name
  api: apiIdentity.name
  worker: workerIdentity.name
  migrate: migrateIdentity.name
}
