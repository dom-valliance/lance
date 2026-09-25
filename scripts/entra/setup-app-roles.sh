#!/usr/bin/env bash
#
# Usage: scripts/entra/setup-app-roles.sh <env>
#
# Grants Lance access through Entra app roles (ADR 0020). Run once per
# environment by an Entra administrator; safe to rerun, since every step looks
# for what it would create and reuses it. It changes the tenant, so read
# docs/runbooks/entra-setup.md section 8 before running it.
#
# What must exist first: the app registration and its service principal
# (entra-setup.md section 1) and the environment's Key Vault, created by
# infra/main.bicep through deploy.md, holding entra-client-id (section 5).
#
# The order keeps the person running it signed in throughout:
#   1. rename the app registration and its service principal to "Lance (Valliance)"
#   2. add the app roles Lance.User and Lance.Admin
#   3. assign Lance.User and Lance.Admin to the signed-in administrator
#   4. request the Graph application permission the nightly role check needs
#   5. only then require assignment on the service principal
#
# Roles are assigned to users, not groups: assigning a group to an app role
# needs Entra ID P1, which this tenant does not have (read from
# GET /subscribedSkus on 2026-09-25; ADR 0020 amendment). A colleague is
# given access with scripts/entra/grant-access.sh.
#
# Admin consent for step 4 is not granted here; the command is printed at the
# end for the administrator to run once they have read what it grants.

set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[a-z0-9]+$ ]]; then
  echo "Usage: scripts/entra/setup-app-roles.sh <env>, for example dev. The environment names the resource group rg-lance-<env>." >&2
  exit 2
fi
ENVIRONMENT="$1"

for tool in az jq; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "${tool} is not on PATH. Install it and run the script again." >&2
    exit 2
  fi
done

# Stable ids, generated once for Lance. Tokens carry the role value, the
# nightly role check matches the id (apps/worker/src/roles/roleCheck.ts), and
# packages/shared/src/roles.ts holds the same two values.
LANCE_USER_ROLE_ID='b98fd184-521c-4ebe-9889-bb9d03c8322c'
LANCE_ADMIN_ROLE_ID='3f59d957-584d-4fc7-9233-45d4979d06f8'

APP_DISPLAY_NAME='Lance (Valliance)'

# Microsoft Graph, and the application permission the role check uses:
#   Application.Read.All  GET /servicePrincipals/{id}/appRoleAssignedTo
GRAPH_APP_ID='00000003-0000-0000-c000-000000000000'
GRAPH_APPLICATION_READ_ALL='9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30'

GRAPH='https://graph.microsoft.com/v1.0'

step() { printf '\n== %s\n' "$*"; }
found() { printf '   %s=%s (%s)\n' "$1" "$2" "$3"; }

step "Reading identifiers for ${ENVIRONMENT}"
TENANT_ID=$(az account show --query tenantId -o tsv)
found TENANT_ID "${TENANT_ID}" "az account show"

RESOURCE_GROUP="rg-lance-${ENVIRONMENT}"
# The static vault, kv-lance-<env>-<suffix>; the principal vault beside it
# (kv-lance-p-<env>-...) holds no entra-client-id.
KEY_VAULT=$(az keyvault list -g "${RESOURCE_GROUP}" --query "[?starts_with(name, 'kv-lance-${ENVIRONMENT}-')].name | [0]" -o tsv)
if [[ -z "${KEY_VAULT}" ]]; then
  echo "No Key Vault in ${RESOURCE_GROUP}. Run docs/runbooks/deploy.md first; infra/main.bicep creates the vault." >&2
  exit 1
fi
found KEY_VAULT "${KEY_VAULT}" "az keyvault list -g ${RESOURCE_GROUP}"

CLIENT_ID=$(az keyvault secret show --vault-name "${KEY_VAULT}" --name entra-client-id --query value -o tsv)
found CLIENT_ID "${CLIENT_ID}" "Key Vault secret entra-client-id"

APP_OBJECT_ID=$(az ad app show --id "${CLIENT_ID}" --query id -o tsv)
found APP_OBJECT_ID "${APP_OBJECT_ID}" "az ad app show"

SP_ID=$(az ad sp show --id "${CLIENT_ID}" --query id -o tsv)
found SP_ID "${SP_ID}" "az ad sp show"

ADMIN_OID=$(az ad signed-in-user show --query id -o tsv)
ADMIN_UPN=$(az ad signed-in-user show --query userPrincipalName -o tsv)
found ADMIN_OID "${ADMIN_OID}" "az ad signed-in-user show, ${ADMIN_UPN}"

GRAPH_SP_ID=$(az ad sp show --id "${GRAPH_APP_ID}" --query id -o tsv)
found GRAPH_SP_ID "${GRAPH_SP_ID}" "Microsoft Graph's service principal in this tenant"

step "1. Naming the app registration ${APP_DISPLAY_NAME}"
current_name=$(az ad app show --id "${CLIENT_ID}" --query displayName -o tsv)
if [[ "${current_name}" == "${APP_DISPLAY_NAME}" ]]; then
  echo "   The app registration is already named ${APP_DISPLAY_NAME}."
else
  az ad app update --id "${CLIENT_ID}" --display-name "${APP_DISPLAY_NAME}"
  echo "   Renamed the app registration from ${current_name}."
fi
current_sp_name=$(az ad sp show --id "${SP_ID}" --query displayName -o tsv)
if [[ "${current_sp_name}" == "${APP_DISPLAY_NAME}" ]]; then
  echo "   The enterprise application is already named ${APP_DISPLAY_NAME}."
else
  az ad sp update --id "${SP_ID}" --set displayName="${APP_DISPLAY_NAME}"
  echo "   Renamed the enterprise application from ${current_sp_name}."
fi

step "2. Adding the app roles Lance.User and Lance.Admin"
existing_roles=$(az ad app show --id "${CLIENT_ID}" --query appRoles -o json)
wanted_roles=$(jq -n \
  --arg user "${LANCE_USER_ROLE_ID}" \
  --arg admin "${LANCE_ADMIN_ROLE_ID}" \
  '[
    {id: $user, value: "Lance.User", displayName: "Lance user", isEnabled: true,
     allowedMemberTypes: ["User"],
     description: "Signs in to Lance and works their own proposals, briefs and settings."},
    {id: $admin, value: "Lance.Admin", displayName: "Lance admin", isEnabled: true,
     allowedMemberTypes: ["User"],
     description: "Sees the health of every principal and changes organisation rules. Never sees another principal'"'"'s content."}
  ]')
merged_roles=$(jq -n --argjson have "${existing_roles}" --argjson want "${wanted_roles}" \
  '$have + [ $want[] | select(.id as $id | ($have | map(.id) | index($id)) == null) ]')
if [[ "$(jq length <<< "${merged_roles}")" == "$(jq length <<< "${existing_roles}")" ]]; then
  echo "   Both roles are already on the app registration."
else
  roles_file=$(mktemp)
  trap 'rm -f "${roles_file}"' EXIT
  printf '%s' "${merged_roles}" > "${roles_file}"
  az ad app update --id "${CLIENT_ID}" --app-roles "@${roles_file}"
  echo "   Added the missing roles; any role already there is unchanged."
fi
found LANCE_USER_ROLE_ID "${LANCE_USER_ROLE_ID}" "Lance.User"
found LANCE_ADMIN_ROLE_ID "${LANCE_ADMIN_ROLE_ID}" "Lance.Admin"

# Assigns an app role to the signed-in administrator on the Lance service
# principal unless they already hold it.
ensure_assignment() {
  local user_id="$1" role_id="$2" label="$3" count
  count=$(az rest --method GET --uri "${GRAPH}/servicePrincipals/${SP_ID}/appRoleAssignedTo" \
    --query "length(value[?principalId=='${user_id}' && appRoleId=='${role_id}'])" -o tsv)
  if (( count > 0 )); then
    echo "   ${ADMIN_UPN} already holds ${label}."
  else
    az rest --method POST --uri "${GRAPH}/servicePrincipals/${SP_ID}/appRoleAssignedTo" \
      --headers 'Content-Type=application/json' \
      --body "{\"principalId\":\"${user_id}\",\"resourceId\":\"${SP_ID}\",\"appRoleId\":\"${role_id}\"}" \
      --output none
    echo "   Assigned ${label} to ${ADMIN_UPN}."
  fi
}

step "3. Assigning Lance.User and Lance.Admin to ${ADMIN_UPN}"
ensure_assignment "${ADMIN_OID}" "${LANCE_USER_ROLE_ID}" "Lance.User"
ensure_assignment "${ADMIN_OID}" "${LANCE_ADMIN_ROLE_ID}" "Lance.Admin"

step "4. Requesting the Graph application permission for the nightly role check"
requested=$(az ad app permission list --id "${CLIENT_ID}" \
  --query "[?resourceAppId=='${GRAPH_APP_ID}'].resourceAccess[] | [?type=='Role'].id" -o tsv)
for permission in "${GRAPH_APPLICATION_READ_ALL}"; do
  if grep -qx "${permission}" <<< "${requested}"; then
    echo "   ${permission} is already requested."
  else
    az ad app permission add --id "${CLIENT_ID}" --api "${GRAPH_APP_ID}" \
      --api-permissions "${permission}=Role" --only-show-errors
    echo "   Requested ${permission}; admin consent is still needed, see the end of this output."
  fi
done

step "5. Requiring assignment on the enterprise application"
required=$(az ad sp show --id "${SP_ID}" --query appRoleAssignmentRequired -o tsv)
if [[ "${required}" == "true" ]]; then
  echo "   Assignment is already required."
else
  az ad sp update --id "${SP_ID}" --set appRoleAssignmentRequired=true
  echo "   Assignment is now required: only users assigned a Lance role can get a token for Lance."
fi

cat <<EOF

Known values for docs/runbooks/entra-setup.md ("Values already known for ${ENVIRONMENT}"):

| Item | Value |
|---|---|
| Tenant id | \`${TENANT_ID}\` |
| App registration name | \`${APP_DISPLAY_NAME}\` |
| Client id | \`${CLIENT_ID}\` |
| App registration object id | \`${APP_OBJECT_ID}\` |
| Service principal object id | \`${SP_ID}\` |
| App role Lance.User id | \`${LANCE_USER_ROLE_ID}\` |
| App role Lance.Admin id | \`${LANCE_ADMIN_ROLE_ID}\` |
| First administrator | \`${ADMIN_UPN}\`, object id \`${ADMIN_OID}\` |
| Microsoft Graph service principal | \`${GRAPH_SP_ID}\` |

Admin consent for the role check (not run by this script). The command grants
one application permission to Lance's own service principal and nothing else:

az rest --method POST --uri ${GRAPH}/servicePrincipals/${SP_ID}/appRoleAssignments \\
  --headers 'Content-Type=application/json' \\
  --body '{"principalId":"${SP_ID}","resourceId":"${GRAPH_SP_ID}","appRoleId":"${GRAPH_APPLICATION_READ_ALL}"}'

EOF
