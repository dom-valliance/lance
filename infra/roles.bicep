// Custom role definitions Lance's templates assign but the deploy identity may not
// create (ADR 0014, ADR 0022). Subscription scope; deployed by Dom, never by CI:
// by deploy.md step 3 before the first main.bicep deployment of a subscription, and
// again as a module of deployer.bicep. Both runs declare the same definition.

targetScope = 'subscription'

@description('Fixed id of the Lance principal secret writer role. infra/deployer.bicep passes it and lists it in assignableRoleIds; modules/principal-vault.bicep assigns it.')
param writerRoleId string = 'dcd10611-553f-42e2-911d-2904e3716c5e'

// Set only, so onboarding writes a principal's credential without being able to read
// any back. setSecret is the one data action Key Vault's SetSecret operation checks,
// and it covers creating a secret as well as adding a version to an existing one.
// It does not cover a name in the soft-deleted state; recovering one needs
// Microsoft.KeyVault/vaults/secrets/recover/action, which stays with the worker's and
// Dom's Key Vault Secrets Officer role. Both environments of this subscription share
// the one definition, so deploying this template for either keeps it current.
resource principalSecretWriterRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: writerRoleId
  properties: {
    roleName: 'Lance principal secret writer'
    description: 'Set secrets in a Lance principal vault. Cannot read, list or delete them.'
    type: 'CustomRole'
    assignableScopes: [
      subscription().id
    ]
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.KeyVault/vaults/secrets/setSecret/action'
        ]
        notDataActions: []
      }
    ]
  }
}

output writerRoleId string = principalSecretWriterRole.name
