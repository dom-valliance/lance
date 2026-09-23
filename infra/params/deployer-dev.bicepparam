using '../deployer.bicep'

param environmentName = 'dev'
param location = 'uksouth'

// The repository whose GitHub Actions runs may use the identities, and the GitHub
// Actions environment that deploy.yml deploys dev through.
param githubRepository = 'dom-valliance/lance'
param githubEnvironment = 'dev'
