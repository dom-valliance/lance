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

echo "Deploying ${deployment_name}: images tagged ${tag} from ${registry}"

export LANCE_IMAGE_TAG="${tag}"
az deployment sub create \
  --name "${deployment_name}" \
  --location "${LANCE_LOCATION:-uksouth}" \
  --template-file "${repo_root}/infra/main.bicep" \
  --parameters "${parameters}" \
  --query "properties.provisioningState" -o tsv

az deployment sub show --name "${deployment_name}" \
  --query "properties.outputs.{web:webFqdn.value, api:apiFqdn.value, registry:registryName.value, keyVault:keyVaultName.value, postgres:postgresServerName.value, migrateJob:migrateJobName.value}" \
  -o table

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "web_fqdn=$(az deployment sub show --name "${deployment_name}" --query properties.outputs.webFqdn.value -o tsv)"
    echo "api_fqdn=$(az deployment sub show --name "${deployment_name}" --query properties.outputs.apiFqdn.value -o tsv)"
    echo "deployment_name=${deployment_name}"
  } >> "${GITHUB_OUTPUT}"
fi
