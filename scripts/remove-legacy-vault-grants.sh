#!/usr/bin/env bash
#
# Usage: scripts/remove-legacy-vault-grants.sh <dev|prod>
#
# Before ADR 0022 the template gave the web, api, worker and migrate identities
# Key Vault Secrets User on the whole static vault, and the api Key Vault
# Secrets Officer on graph-refresh-token. The template now grants each app
# its own secrets one by one (infra/modules/keyvault.bicep) and declares
# neither of those, but ARM's incremental mode never deletes what a template
# stops declaring, so they would outlive it and the web app could still read
# every secret. scripts/deploy.sh runs this after each deployment; once the
# old assignments are gone it finds nothing and changes nothing.
#
# It removes exactly those two kinds of assignment and nothing else: Dom's
# vault-wide Secrets Officer is a User assignment and is kept, and the
# per-secret grants the template makes are at a secret's scope, not the
# vault's. The deploy identity may delete them because both roles are in
# infra/deployer.bicep's assignableRoleIds.
#
# LANCE_DRY_RUN=1 lists what would be removed and removes nothing.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: scripts/remove-legacy-vault-grants.sh <dev|prod>" >&2
  exit 2
fi

environment=$1
group="rg-lance-${environment}"
secrets_user='4633458b-17de-408a-b874-0445c86b69e6'
secrets_officer='b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

vault_id=$(az keyvault list --resource-group "${group}" \
  --query "[?starts_with(name, 'kv-lance-${environment}-')].id | [0]" -o tsv)
if [[ -z "${vault_id}" ]]; then
  echo "No static vault in ${group}; nothing to remove."
  exit 0
fi

principal_of() {
  az identity show --resource-group "${group}" --name "$1" --query principalId -o tsv
}
web=$(principal_of "id-lance-web-${environment}")
api=$(principal_of "id-lance-api-${environment}")
worker=$(principal_of "id-lance-worker-${environment}")
migrate=$(principal_of "id-lance-migrate-${environment}")

# `az role assignment list --scope` without --include-inherited lists the
# assignments made at that scope only.
remove() {
  local scope=$1 role=$2
  shift 2
  local principals=("$@")
  local ids
  ids=$(az role assignment list --scope "${scope}" --role "${role}" \
    --query "[?principalType=='ServicePrincipal'].{id:id, principal:principalId}" -o tsv)
  while IFS=$'\t' read -r id principal; do
    [[ -z "${id}" ]] && continue
    for candidate in "${principals[@]}"; do
      if [[ "${principal}" == "${candidate}" ]]; then
        if [[ "${LANCE_DRY_RUN:-}" == "1" ]]; then
          echo "Would remove legacy assignment ${id}"
        else
          echo "Removing legacy assignment ${id}"
          az role assignment delete --ids "${id}"
        fi
      fi
    done
  done <<< "${ids}"
}

remove "${vault_id}" "${secrets_user}" "${web}" "${api}" "${worker}" "${migrate}"
remove "${vault_id}/secrets/graph-refresh-token" "${secrets_officer}" "${api}"

[[ "${LANCE_DRY_RUN:-}" == "1" ]] && echo "Dry run: nothing removed." || echo "Static vault grants are per secret only."
