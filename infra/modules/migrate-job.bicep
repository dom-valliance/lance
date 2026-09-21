// Container Apps Job that runs the Drizzle migrations. Manual trigger only: Dom
// starts it from the CLI after a deploy, never on a schedule and never automatically.
//
// It runs the worker image, which carries the whole workspace, and its own managed
// identity. That identity is granted lance_migrator in Postgres (ADR 0008); the three
// app identities are granted lance_app only, so no running app can migrate.

@description('Environment name, dev or prod.')
param environmentName string

@description('Azure region.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Resource id of the Container Apps managed environment.')
param managedEnvironmentId string

@description('Login server of the container registry.')
param registryLoginServer string

@description('Fully qualified domain name of the Postgres Flexible Server.')
param postgresFqdn string

@description('The migration identity from modules/identity.bicep.')
param migrateIdentity object

@description('Tag on the worker image.')
param containerImageTag string

@description('When true the job carries the public quickstart image so it can be created before any image is pushed. Running the job in that state fails: push the images and flip this to false first.')
param useBootstrapImage bool

@description('Database name on the Postgres server.')
param databaseName string = 'lance'

var bootstrapImage = 'mcr.microsoft.com/k8se/quickstart:latest'

resource migrateJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'caj-lance-migrate-${environmentName}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${migrateIdentity.id}': {}
    }
  }
  properties: {
    environmentId: managedEnvironmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: useBootstrapImage
        ? []
        : [
            {
              server: registryLoginServer
              identity: migrateIdentity.id
            }
          ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: useBootstrapImage ? bootstrapImage : '${registryLoginServer}/lance-worker:${containerImageTag}'
          // The runtime image has no pnpm; tsx is installed with the db package.
          // Seed is idempotent (ON CONFLICT DO NOTHING), so the job runs both.
          command: [
            'sh'
            '-c'
            'cd /app/packages/db && ./node_modules/.bin/tsx src/migrate.ts && ./node_modules/.bin/tsx src/seed.ts'
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PG_HOST'
              value: postgresFqdn
            }
            {
              name: 'PG_PORT'
              value: '5432'
            }
            {
              name: 'PG_SSL'
              value: 'require'
            }
            {
              name: 'PG_DATABASE'
              value: databaseName
            }
            {
              // The Postgres principal created for this identity by
              // pgaadauth_create_principal, granted lance_migrator. ADR 0008.
              name: 'PG_USER'
              value: migrateIdentity.name
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: migrateIdentity.clientId
            }
          ]
        }
      ]
    }
  }
}

output jobName string = migrateJob.name
output jobId string = migrateJob.id
