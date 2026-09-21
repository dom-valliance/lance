// Azure Database for PostgreSQL Flexible Server, version 16, with Apache AGE and
// pgvector allowlisted through the azure.extensions server parameter. ADR 0004 fixes
// the major version at 16 because Azure supports AGE 1.6 there and in-place major
// upgrades with AGE enabled are not available.
//
// Authentication follows ADR 0008: Entra authentication is the production path, with
// each Container App's managed identity created as a Postgres principal and granted
// lance_app, and the migration job's identity granted lance_migrator. Password
// authentication stays enabled so the Key Vault fallback in spec 3.3 exists, but
// nothing in the running system uses it.

@description('Environment name, dev or prod.')
param environmentName string

@description('Azure region.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Entropy for the globally unique server name.')
param uniqueSuffix string

@description('Object id of the Entra principal that becomes the Postgres Entra administrator.')
param entraAdminObjectId string

@description('Principal name of the Entra administrator, normally a UPN.')
param entraAdminPrincipalName string

@description('Public IPv4 address allowed to reach the server from outside Azure, for psql during the runbook steps. Empty means no rule.')
param adminClientIp string = ''

@description('Whether password authentication is enabled alongside Entra.')
param passwordAuthEnabled bool

@description('Administrator login for the password fallback.')
param administratorLogin string

@description('Administrator password for the password fallback.')
@secure()
param administratorPassword string

@description('Database name. Matches the local compose database so connection strings differ only in host.')
param databaseName string = 'lance'

@description('Log Analytics workspace that receives the server logs.')
param logAnalyticsWorkspaceId string

var isProd = environmentName == 'prod'

var skuName = isProd ? 'Standard_D2ds_v5' : 'Standard_B1ms'
var skuTier = isProd ? 'GeneralPurpose' : 'Burstable'

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-lance-${environmentName}-${uniqueSuffix}'
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: '16'
    administratorLogin: passwordAuthEnabled ? administratorLogin : null
    administratorLoginPassword: passwordAuthEnabled ? administratorPassword : null
    createMode: 'Default'
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: passwordAuthEnabled ? 'Enabled' : 'Disabled'
      tenantId: subscription().tenantId
    }
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 35
      geoRedundantBackup: isProd ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    // Public network access with a single firewall rule. Phase 5 moves prod to a
    // private endpoint on the Container Apps environment subnet and drops the rule.
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// Entra administrator. This is the account that runs the first migration and creates
// the managed identity principals with pgaadauth_create_principal. ADR 0008.
resource entraAdministrator 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: postgresServer
  name: entraAdminObjectId
  properties: {
    principalName: entraAdminPrincipalName
    principalType: 'User'
    tenantId: subscription().tenantId
  }
}

// AGE and pgvector. The extensions still need CREATE EXTENSION in the migration;
// this parameter only makes them creatable.
resource azureExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresServer
  name: 'azure.extensions'
  properties: {
    value: 'AGE,VECTOR'
    source: 'user-override'
  }
  dependsOn: [
    entraAdministrator
  ]
}

// AGE must be preloaded: Azure rejects LOAD 'age' per session. This parameter is
// static, so the server needs one restart after the first deploy (deploy.md step 3).
// The two defaults are kept so nothing Azure relies on is dropped.
resource sharedPreloadLibraries 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresServer
  name: 'shared_preload_libraries'
  properties: {
    value: 'pg_cron,pg_stat_statements,age'
    source: 'user-override'
  }
  dependsOn: [
    azureExtensions
  ]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgresServer
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [
    azureExtensions
  ]
}

// The 0.0.0.0 to 0.0.0.0 rule is the Azure convention for "allow Azure services",
// which is how the Container Apps environment reaches the server. The only other
// rule is Dom's client IP for psql, supplied at deploy time and removed by
// redeploying without it. Phase 5 replaces all of this with a private endpoint.
resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgresServer
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
  dependsOn: [
    database
  ]
}

resource allowAdminClient 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (adminClientIp != '') {
  parent: postgresServer
  name: 'AllowAdminClient'
  properties: {
    startIpAddress: adminClientIp
    endIpAddress: adminClientIp
  }
  dependsOn: [
    allowAzureServices
  ]
}

// Connection attempts and their outcome, so a dropped handshake has a server
// side record. log_connections is dynamic; no restart needed.
resource logConnections 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresServer
  name: 'log_connections'
  properties: {
    value: 'on'
    source: 'user-override'
  }
  dependsOn: [
    sharedPreloadLibraries
  ]
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: postgresServer
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'PostgreSQLLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

output serverName string = postgresServer.name
output serverId string = postgresServer.id
output fqdn string = postgresServer.properties.fullyQualifiedDomainName
output databaseNameOut string = databaseName
