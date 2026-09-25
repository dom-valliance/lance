#!/usr/bin/env bash
#
# Usage: scripts/deploy.sh <dev|prod> <image tag>
#
# Deploys infra/main.bicep with infra/params/<env>.bicepparam, pointing the three
# apps and the migration job at the images tagged <image tag> in the environment's
# registry. The tag reaches the parameter file through LANCE_IMAGE_TAG, so the file
# never records a tag. The deployment is named after the environment and the tag,
# which is how a deploy is found again in the portal or with
# `az deployment sub show -n lance-<env>-<tag>`.
#
# Before the deployment it reads which static secrets exist
# (scripts/existing-secrets.sh) so the template creates only missing ones as
# placeholders; after it, it removes the vault-wide grants the template no
# longer declares (scripts/remove-legacy-vault-grants.sh).
#
# The deployment never runs the migration job; scripts/run-migration-job.sh does,
# and scripts/verify-deploy.sh reads the result. deploy.yml runs the three in order.
#
# The caller is signed in to Azure already: `az login` by hand, azure/login in CI.
# LANCE_LOCATION overrides the deployment metadata location, default uksouth.

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: scripts/deploy.sh <dev|prod> <image tag>" >&2
  exit 2
fi

environment=$1
tag=$2
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
parameters="${repo_root}/infra/params/${environment}.bicepparam"
deployment_name="lance-${environment}-${tag}"

if [[ ! -f "${parameters}" ]]; then
  echo "No parameter file at ${parameters}. The environment must be dev or prod." >&2
  exit 2
fi

registry=$(az acr list -g "rg-lance-${environment}" --query "[0].name" -o tsv)
if [[ -z "${registry}" ]]; then
  echo "No container registry in rg-lance-${environment}. Deploy the environment on the bootstrap image first (docs/runbooks/deploy.md, step 3)." >&2
  exit 1
fi

for repository in lance-web lance-api lance-worker; do
  if ! az acr repository show-tags --name "${registry}" --repository "${repository}" -o tsv 2>/dev/null | grep -qx "${tag}"; then
    echo "${registry} has no ${repository}:${tag}. Push the three images with that tag before deploying." >&2
    exit 1
  fi
done

export LANCE_IMAGE_TAG="${tag}"
location="${LANCE_LOCATION:-uksouth}"

# The static secrets that exist already, so the template writes a placeholder
# only for a missing one and never over a real value (ADR 0022). Read now,
# immediately before the what-if and the deployment that use it.
LANCE_EXISTING_SECRETS=$("${repo_root}/scripts/existing-secrets.sh" "${environment}")
export LANCE_EXISTING_SECRETS
echo "Secrets already in the static vault: ${LANCE_EXISTING_SECRETS:-none}"

# The plan first, in the same log as the deployment it describes. A what-if runs
# the same authorisation pre-flight as a deployment, so it cannot run under a
# read-only identity on a pull request; here it runs under the deploying one.
echo "What-if for ${deployment_name}: images tagged ${tag} from ${registry}"
az deployment sub what-if \
  --name "${deployment_name}" \
  --location "${location}" \
  --template-file "${repo_root}/infra/main.bicep" \
  --parameters "${parameters}"

echo "Deploying ${deployment_name}"
az deployment sub create \
  --name "${deployment_name}" \
  --location "${location}" \
  --template-file "${repo_root}/infra/main.bicep" \
  --parameters "${parameters}" \
  --query "properties.provisioningState" -o tsv

# The vault-wide grants the template made before ADR 0022 are not declared any
# more, and an incremental deployment does not delete them.
"${repo_root}/scripts/remove-legacy-vault-grants.sh" "${environment}"

az deployment sub show --name "${deployment_name}" \
  --query "properties.outputs.{web:webFqdn.value, api:apiFqdn.value, registry:registryName.value, keyVault:keyVaultName.value, principalVault:principalKeyVaultName.value, postgres:postgresServerName.value, migrateJob:migrateJobName.value}" \
  -o table

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "web_fqdn=$(az deployment sub show --name "${deployment_name}" --query properties.outputs.webFqdn.value -o tsv)"
    echo "api_fqdn=$(az deployment sub show --name "${deployment_name}" --query properties.outputs.apiFqdn.value -o tsv)"
    echo "deployment_name=${deployment_name}"
  } >> "${GITHUB_OUTPUT}"
fi
