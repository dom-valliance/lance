#!/usr/bin/env bash
#
# Usage: scripts/entra/grant-access.sh <env> <upn> <user|admin> [--remove]
#
# Gives one person a Lance app role on the enterprise application, or takes
# it away (ADR 0020 and its amendment). Roles are assigned to users because
# assigning a group to an app role needs Entra ID P1, which this tenant does
# not have. `admin` assigns both Lance.User and Lance.Admin; `--remove` with
# `user` removes both, with `admin` removes Lance.Admin only.
#
# What must exist first: scripts/entra/setup-app-roles.sh has run for the
# environment, so the two roles exist and assignment is required. Removing a
# role stops the person's next sign-in; the nightly role check pauses their
# principal and, after the grace days, offboards it
# (docs/runbooks/offboard-principal.md).

set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 || ! "$1" =~ ^[a-z0-9]+$ || ! "$3" =~ ^(user|admin)$ ]]; then
  echo "Usage: scripts/entra/grant-access.sh <env> <upn> <user|admin> [--remove], for example dev colleague@valliance.ai user." >&2
  exit 2
fi
if [[ $# -eq 4 && "$4" != "--remove" ]]; then
  echo "The fourth argument may only be --remove; got '$4'." >&2
  exit 2
fi
ENVIRONMENT="$1"
UPN="$2"
LEVEL="$3"
REMOVE="${4:-}"

# The same stable ids as setup-app-roles.sh and packages/shared/src/roles.ts.
LANCE_USER_ROLE_ID='b98fd184-521c-4ebe-9889-bb9d03c8322c'
LANCE_ADMIN_ROLE_ID='3f59d957-584d-4fc7-9233-45d4979d06f8'
GRAPH='https://graph.microsoft.com/v1.0'

RESOURCE_GROUP="rg-lance-${ENVIRONMENT}"
KEY_VAULT=$(az keyvault list -g "${RESOURCE_GROUP}" --query "[?starts_with(name, 'kv-lance-${ENVIRONMENT}-')].name | [0]" -o tsv)
if [[ -z "${KEY_VAULT}" ]]; then
  echo "No static Key Vault kv-lance-${ENVIRONMENT}-* in ${RESOURCE_GROUP}. Deploy the environment first (docs/runbooks/deploy.md)." >&2
  exit 1
fi
CLIENT_ID=$(az keyvault secret show --vault-name "${KEY_VAULT}" --name entra-client-id --query value -o tsv)
SP_ID=$(az ad sp show --id "${CLIENT_ID}" --query id -o tsv)
USER_ID=$(az ad user show --id "${UPN}" --query id -o tsv)
echo "Service principal ${SP_ID}; ${UPN} is ${USER_ID}."

roles=("${LANCE_USER_ROLE_ID}:Lance.User")
if [[ "${LEVEL}" == "admin" ]]; then
  roles=("${LANCE_USER_ROLE_ID}:Lance.User" "${LANCE_ADMIN_ROLE_ID}:Lance.Admin")
  [[ -n "${REMOVE}" ]] && roles=("${LANCE_ADMIN_ROLE_ID}:Lance.Admin")
elif [[ -n "${REMOVE}" ]]; then
  roles=("${LANCE_USER_ROLE_ID}:Lance.User" "${LANCE_ADMIN_ROLE_ID}:Lance.Admin")
fi

for entry in "${roles[@]}"; do
  role_id="${entry%%:*}"
  label="${entry##*:}"
  assignment=$(az rest --method GET --uri "${GRAPH}/servicePrincipals/${SP_ID}/appRoleAssignedTo" \
    --query "value[?principalId=='${USER_ID}' && appRoleId=='${role_id}'].id | [0]" -o tsv)
  if [[ -n "${REMOVE}" ]]; then
    if [[ -z "${assignment}" ]]; then
      echo "   ${UPN} does not hold ${label}."
    else
      az rest --method DELETE --uri "${GRAPH}/servicePrincipals/${SP_ID}/appRoleAssignedTo/${assignment}" --output none
      echo "   Removed ${label} from ${UPN}."
    fi
  elif [[ -n "${assignment}" ]]; then
    echo "   ${UPN} already holds ${label}."
  else
    az rest --method POST --uri "${GRAPH}/servicePrincipals/${SP_ID}/appRoleAssignedTo" \
      --headers 'Content-Type=application/json' \
      --body "{\"principalId\":\"${USER_ID}\",\"resourceId\":\"${SP_ID}\",\"appRoleId\":\"${role_id}\"}" \
      --output none
    echo "   Assigned ${label} to ${UPN}."
  fi
done
