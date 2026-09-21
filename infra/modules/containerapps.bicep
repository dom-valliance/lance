// Container Apps managed environment and the three Lance apps: web, api, worker.
// Each app runs under its own user-assigned managed identity, pulls from the registry
// with that identity, and reads its secrets as Key Vault references resolved with the
// same identity (spec 3.3, spec 4.2).

@description('Environment name, dev or prod.')
param environmentName string

@description('Azure region.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Name of the Log Analytics workspace the environment logs to.')
param logAnalyticsWorkspaceName string

@description('Application Insights connection string for the OpenTelemetry exporter.')
param applicationInsightsConnectionString string

@description('Key Vault URI, including the trailing slash.')
param keyVaultUri string

@description('Login server of the container registry.')
param registryLoginServer string

@description('Fully qualified domain name of the Postgres Flexible Server.')
param postgresFqdn string

@description('The four managed identities from modules/identity.bicep, keyed by workload.')
param identities object

@description('Tag on the three container images.')
param containerImageTag string

@description('When true, run the public quickstart image with no registry credentials and no Key Vault references, so the environment stands up before any image exists.')
param useBootstrapImage bool

@description('The single UPN allowed to sign in. Not a secret; the same value is also held in Key Vault as allowed-upn for components that read it from there.')
param allowedUpn string

@description('The Slack user id allowed to work the kill switch from Slack. Not a secret.')
param slackAllowedUserId string

@description('Database name on the Postgres server.')
param databaseName string = 'lance'

// A public image that starts, serves on port 80 and does nothing else. It lets the
// whole environment deploy and go healthy before the first az acr build.
var bootstrapImage = 'mcr.microsoft.com/k8se/quickstart:latest'
var bootstrapPort = 80

// Secret name to environment variable name. The secret names match the table in
// modules/keyvault.bicep and the rotation runbook.
var webSecretBindings = [
  {
    secretName: 'auth-secret'
    envName: 'AUTH_SECRET'
  }
  {
    secretName: 'entra-tenant-id'
    envName: 'ENTRA_TENANT_ID'
  }
  {
    secretName: 'entra-client-id'
    envName: 'ENTRA_CLIENT_ID'
  }
  {
    secretName: 'entra-client-secret'
    envName: 'ENTRA_CLIENT_SECRET'
  }
  {
    secretName: 'allowed-upn'
    envName: 'ALLOWED_UPN'
  }
]

var apiSecretBindings = [
  {
    secretName: 'entra-tenant-id'
    envName: 'ENTRA_TENANT_ID'
  }
  {
    secretName: 'entra-client-id'
    envName: 'ENTRA_CLIENT_ID'
  }
  {
    secretName: 'entra-client-secret'
    envName: 'ENTRA_CLIENT_SECRET'
  }
  {
    secretName: 'slack-bot-token'
    envName: 'SLACK_BOT_TOKEN'
  }
  {
    secretName: 'slack-signing-secret'
    envName: 'SLACK_SIGNING_SECRET'
  }
  {
    secretName: 'agent-log-ingest-secret'
    envName: 'AGENT_LOG_INGEST_SECRET'
  }
]

var workerSecretBindings = [
  {
    secretName: 'entra-tenant-id'
    envName: 'ENTRA_TENANT_ID'
  }
  {
    secretName: 'entra-client-id'
    envName: 'ENTRA_CLIENT_ID'
  }
  {
    secretName: 'anthropic-api-key'
    envName: 'ANTHROPIC_API_KEY'
  }
  {
    secretName: 'notion-token'
    envName: 'NOTION_TOKEN'
  }
  {
    secretName: 'jamie-api-key'
    envName: 'JAMIE_API_KEY'
  }
  {
    secretName: 'graph-refresh-token'
    envName: 'GRAPH_REFRESH_TOKEN'
  }
  {
    secretName: 'entra-client-secret'
    envName: 'ENTRA_CLIENT_SECRET'
  }
  {
    secretName: 'allowed-upn'
    envName: 'ALLOWED_UPN'
  }
]

var apps = [
  {
    name: 'ca-lance-web-${environmentName}'
    identity: identities.web
    repository: 'lance-web'
    hasIngress: true
    external: true
    targetPort: 3000
    minReplicas: 1
    maxReplicas: 2
    bindings: webSecretBindings
    // Auth.js builds callback URLs from AUTH_URL; without it the container's
    // bind address (0.0.0.0:3000) leaks into the sign-in redirect. The value is
    // computed in the loop body because it needs the environment's domain.
    needsAuthUrl: true
  }
  {
    // Container Apps has no path-scoped ingress, so the whole api is reachable from
    // the internet rather than only /slack/* and /ingest/* as spec 3.3 describes.
    // The api closes that gap in code: Entra bearer authentication on every route
    // except /slack/* and /ingest/*, and Slack signature verification on those two.
    // Phase 5 item: revisit by splitting the public webhook routes into a separate
    // Container App if the single-app surface proves too wide.
    name: 'ca-lance-api-${environmentName}'
    identity: identities.api
    repository: 'lance-api'
    hasIngress: true
    external: true
    targetPort: 3001
    needsAuthUrl: false
    minReplicas: 1
    maxReplicas: 2
    bindings: apiSecretBindings
  }
  {
    // Single replica in v1. pg-boss locks jobs, so a second replica is safe later
    // (spec 3.3), but nothing depends on that yet.
    name: 'ca-lance-worker-${environmentName}'
    identity: identities.worker
    repository: 'lance-worker'
    hasIngress: false
    external: false
    targetPort: 0
    minReplicas: 1
    maxReplicas: 1
    bindings: workerSecretBindings
    needsAuthUrl: false
  }
]

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-lance-${environmentName}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspace.properties.customerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

resource containerApps 'Microsoft.App/containerApps@2025-01-01' = [
  for app in apps: {
    name: app.name
    location: location
    tags: tags
    identity: {
      type: 'UserAssigned'
      userAssignedIdentities: {
        '${app.identity.id}': {}
      }
    }
    properties: {
      managedEnvironmentId: managedEnvironment.id
      configuration: {
        activeRevisionsMode: 'Single'
        ingress: app.hasIngress
          ? {
              external: app.external
              targetPort: useBootstrapImage ? bootstrapPort : app.targetPort
              transport: 'auto'
              allowInsecure: false
              traffic: [
                {
                  latestRevision: true
                  weight: 100
                }
              ]
            }
          : null
        // The bootstrap image comes from a public registry and needs no secrets, so
        // both lists stay empty until the real images and the Key Vault values exist.
        registries: useBootstrapImage
          ? []
          : [
              {
                server: registryLoginServer
                identity: app.identity.id
              }
            ]
        secrets: useBootstrapImage
          ? []
          : map(app.bindings, binding => {
              name: binding.secretName
              keyVaultUrl: '${keyVaultUri}secrets/${binding.secretName}'
              identity: app.identity.id
            })
      }
      template: {
        containers: [
          {
            name: app.repository
            image: useBootstrapImage ? bootstrapImage : '${registryLoginServer}/${app.repository}:${containerImageTag}'
            resources: {
              cpu: json('0.5')
              memory: '1Gi'
            }
            env: concat(
              [
                {
                  name: 'NODE_ENV'
                  value: 'production'
                }
                {
                  name: 'LANCE_MODE'
                  value: 'dry_run'
                }
                {
                  name: 'AGENT_DISPLAY_NAME'
                  value: 'Lance'
                }
                {
                  name: 'ALLOWED_UPN'
                  value: allowedUpn
                }
                {
                  name: 'SLACK_ALLOWED_USER_ID'
                  value: slackAllowedUserId
                }
                {
                  name: 'PG_HOST'
                  value: postgresFqdn
                }
                {
                  name: 'PG_DATABASE'
                  value: databaseName
                }
                {
                  name: 'PG_PORT'
                  value: '5432'
                }
                {
                  // TLS with certificate verification; the password is an Entra token.
                  name: 'PG_SSL'
                  value: 'require'
                }
                {
                  // The Postgres principal created for this identity by
                  // pgaadauth_create_principal. ADR 0008.
                  name: 'PG_USER'
                  value: app.identity.name
                }
                {
                  name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
                  value: applicationInsightsConnectionString
                }
                {
                  // Tells DefaultAzureCredential which user-assigned identity to use.
                  name: 'AZURE_CLIENT_ID'
                  value: app.identity.clientId
                }
              ],
              app.needsAuthUrl
                ? [
                    {
                      name: 'AUTH_URL'
                      value: 'https://${app.name}.${managedEnvironment.properties.defaultDomain}'
                    }
                    {
                      name: 'AUTH_TRUST_HOST'
                      value: 'true'
                    }
                  ]
                : [],
              useBootstrapImage
                ? []
                : map(app.bindings, binding => {
                    name: binding.envName
                    secretRef: binding.secretName
                  })
            )
          }
        ]
        scale: {
          minReplicas: app.minReplicas
          maxReplicas: app.maxReplicas
          rules: app.maxReplicas > app.minReplicas
            ? [
                {
                  name: 'http-concurrency'
                  http: {
                    metadata: {
                      concurrentRequests: '50'
                    }
                  }
                }
              ]
            : []
        }
      }
    }
  }
]

output managedEnvironmentId string = managedEnvironment.id
output managedEnvironmentName string = managedEnvironment.name
output webFqdn string = containerApps[0].properties.configuration.ingress.fqdn
output apiFqdn string = containerApps[1].properties.configuration.ingress.fqdn
output workerAppName string = containerApps[2].name
