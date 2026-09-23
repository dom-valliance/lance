using '../deployer.bicep'

param environmentName = 'dev'
param location = 'uksouth'

// The repository whose GitHub Actions runs may use the identities, and the GitHub
// Actions environment that deploy.yml deploys dev through.
param githubRepository = 'dom-valliance/lance'
// Numeric ids GitHub appends to the owner and repository in every OIDC subject. From the
// "subject claim" line azure/login prints, or GET https://api.github.com/repos/dom-valliance/lance
// (owner.id and id).
param githubOwnerId = '215853107'
param githubRepositoryId = '1378678734'
param githubEnvironment = 'dev'
