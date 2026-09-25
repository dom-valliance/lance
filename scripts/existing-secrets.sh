#!/usr/bin/env bash
#
# Usage: scripts/existing-secrets.sh <dev|prod>
#
# Prints the names of the secrets in the environment's static Key Vault,
# kv-lance-<env>-<suffix>, comma separated, for LANCE_EXISTING_SECRETS. The
# template creates a placeholder for a secret in infra/secrets.json only when
# its name is missing from this list, so a real value is never written over
# (ADR 0022, infra/modules/keyvault.bicep).
#
# The names come from the control plane (GET .../vaults/<name>/secrets), which
# Contributor and Reader can call and which returns names and attributes, never
# values. The call pages a few secrets at a time, so every nextLink is followed.
# A resource group or vault that does not exist yet prints an empty line: the
# first deploy creates every secret as a placeholder. Any other failure exits
# non-zero, so a deployment never runs on a list that is short by accident.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: scripts/existing-secrets.sh <dev|prod>" >&2
  exit 2
fi

environment=$1
group="rg-lance-${environment}"

if [[ "$(az group exists --name "${group}")" != "true" ]]; then
  echo ""
  exit 0
fi

# The static vault is kv-lance-<env>-<suffix>; the principal vault,
# kv-lance-p-<env>-<suffix>, does not match the prefix.
vault_ids=$(az keyvault list --resource-group "${group}" \
  --query "[?starts_with(name, 'kv-lance-${environment}-')].id" -o tsv)
count=$(grep -c . <<< "${vault_ids}" || true)
if (( count == 0 )); then
  echo ""
  exit 0
fi
if (( count > 1 )); then
  echo "Found ${count} vaults named kv-lance-${environment}-* in ${group}; expected one. Resolve which is the environment's before deploying." >&2
  exit 1
fi

url="https://management.azure.com${vault_ids}/secrets?api-version=2023-07-01"
names=()
while [[ -n "${url}" ]]; do
  page=$(az rest --method get --url "${url}" -o json)
  while IFS= read -r name; do
    [[ -n "${name}" ]] && names+=("${name}")
  done < <(jq -r '.value[].name' <<< "${page}")
  url=$(jq -r '.nextLink // empty' <<< "${page}")
done

(IFS=,; echo "${names[*]:-}")
