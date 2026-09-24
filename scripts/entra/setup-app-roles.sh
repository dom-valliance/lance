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
#   3. create the security groups "Lance Users" and "Lance Admins"
#   4. add the signed-in administrator to both groups
#   5. assign each group its app role on the service principal
#   6. request the Graph application permissions the nightly role check needs
#   7. only then require assignment on the service principal
#
# Admin consent for step 6 is not granted here; the command is printed at the
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
USERS_GROUP_NAME='Lance Users'
ADMINS_GROUP_NAME='Lance Admins'

# Microsoft Graph, and the two application permissions the role check uses:
#   Application.Read.All       GET /servicePrincipals/{id}/appRoleAssignedTo
#   GroupMember.ReadBasic.All  GET /groups/{id}/transitiveMembers
GRAPH_APP_ID='00000003-0000-0000-c000-000000000000'
GRAPH_APPLICATION_READ_ALL='9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30'
GRAPH_GROUP_MEMBER_READ_BASIC_ALL='8222c640-cae5-4860-8d11-b32cfad95e03'

GRAPH='https://graph.microsoft.com/v1.0'

step() { printf '\n== %s\n' "$*"; }
found() { printf '   %s=%s (%s)\n' "$1" "$2" "$3"; }

step "Reading identifiers for ${ENVIRONMENT}"
TENANT_ID=$(az account show --query tenantId -o tsv)
found TENANT_ID "${TENANT_ID}" "az account show"

RESOURCE_GROUP="rg-lance-${ENVIRONMENT}"
KEY_VAULT=$(az keyvault list -g "${RESOURCE_GROUP}" --query "[0].name" -o tsv)
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

# Prints the object id of the security group with this display name, creating it if absent.
ensure_group() {
  local name="$1" nickname="$2" description="$3" id count
  count=$(az ad group list --filter "displayName eq '${name}'" --query "length(@)" -o tsv)
  if (( count > 1 )); then
    echo "   ${count} groups are named ${name}. Remove the duplicates in the Entra admin centre and run the script again." >&2
    exit 1
  fi
  if (( count == 1 )); then
    id=$(az ad group list --filter "displayName eq '${name}'" --query "[0].id" -o tsv)
    echo "   Found the group ${name}." >&2
  else
    id=$(az ad group create --display-name "${name}" --mail-nickname "${nickname}" \
      --description "${description}" --query id -o tsv)
    echo "   Created the security group ${name}." >&2
  fi
  printf '%s' "${id}"
}

step "3. Creating the security groups"
USERS_GROUP_ID=$(ensure_group "${USERS_GROUP_NAME}" lance-users "Members may sign in to Lance (app role Lance.User).")
found USERS_GROUP_ID "${USERS_GROUP_ID}" "${USERS_GROUP_NAME}"
ADMINS_GROUP_ID=$(ensure_group "${ADMINS_GROUP_NAME}" lance-admins "Members administer Lance (app role Lance.Admin).")
found ADMINS_GROUP_ID "${ADMINS_GROUP_ID}" "${ADMINS_GROUP_NAME}"

step "4. Adding ${ADMIN_UPN} to both groups"
for group_id in "${USERS_GROUP_ID}" "${ADMINS_GROUP_ID}"; do
  is_member=$(az ad group member check --group "${group_id}" --member-id "${ADMIN_OID}" --query value -o tsv)
  if [[ "${is_member}" == "true" ]]; then
    echo "   Already a member of ${group_id}."
  else
    az ad group member add --group "${group_id}" --member-id "${ADMIN_OID}"
    echo "   Added to ${group_id}."
  fi
done

# Assigns an app role to a group on the Lance service principal unless it already holds it.
ensure_assignment() {
  local group_id="$1" role_id="$2" label="$3" count
  count=$(az rest --method GET --uri "${GRAPH}/servicePrincipals/${SP_ID}/appRoleAssignedTo" \
    --query "length(value[?principalId=='${group_id}' && appRoleId=='${role_id}'])" -o tsv)
  if (( count > 0 )); then
    echo "   ${label} already holds its role."
  else
    az rest --method POST --uri "${GRAPH}/servicePrincipals/${SP_ID}/appRoleAssignedTo" \
      --headers 'Content-Type=application/json' \
      --body "{\"principalId\":\"${group_id}\",\"resourceId\":\"${SP_ID}\",\"appRoleId\":\"${role_id}\"}" \
      --output none
    echo "   Assigned ${label} its role."
  fi
}

step "5. Assigning each group its app role"
ensure_assignment "${USERS_GROUP_ID}" "${LANCE_USER_ROLE_ID}" "${USERS_GROUP_NAME} (Lance.User)"
ensure_assignment "${ADMINS_GROUP_ID}" "${LANCE_ADMIN_ROLE_ID}" "${ADMINS_GROUP_NAME} (Lance.Admin)"

step "6. Requesting the Graph application permissions for the nightly role check"
requested=$(az ad app permission list --id "${CLIENT_ID}" \
  --query "[?resourceAppId=='${GRAPH_APP_ID}'].resourceAccess[] | [?type=='Role'].id" -o tsv)
for permission in "${GRAPH_APPLICATION_READ_ALL}" "${GRAPH_GROUP_MEMBER_READ_BASIC_ALL}"; do
  if grep -qx "${permission}" <<< "${requested}"; then
    echo "   ${permission} is already requested."
  else
    az ad app permission add --id "${CLIENT_ID}" --api "${GRAPH_APP_ID}" \
      --api-permissions "${permission}=Role" --only-show-errors
    echo "   Requested ${permission}; admin consent is still needed, see the end of this output."
  fi
done

step "7. Requiring assignment on the enterprise application"
required=$(az ad sp show --id "${SP_ID}" --query appRoleAssignmentRequired -o tsv)
if [[ "${required}" == "true" ]]; then
  echo "   Assignment is already required."
else
  az ad sp update --id "${SP_ID}" --set appRoleAssignmentRequired=true
  echo "   Assignment is now required: only members of the two groups can get a token for Lance."
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
| Group ${USERS_GROUP_NAME} object id | \`${USERS_GROUP_ID}\` |
| Group ${ADMINS_GROUP_NAME} object id | \`${ADMINS_GROUP_ID}\` |
| First administrator | \`${ADMIN_UPN}\`, object id \`${ADMIN_OID}\` |
| Microsoft Graph service principal | \`${GRAPH_SP_ID}\` |

Admin consent for the role check (not run by this script). Each command grants
one application permission to Lance's own service principal and nothing else:

az rest --method POST --uri ${GRAPH}/servicePrincipals/${SP_ID}/appRoleAssignments \\
  --headers 'Content-Type=application/json' \\
  --body '{"principalId":"${SP_ID}","resourceId":"${GRAPH_SP_ID}","appRoleId":"${GRAPH_APPLICATION_READ_ALL}"}'

az rest --method POST --uri ${GRAPH}/servicePrincipals/${SP_ID}/appRoleAssignments \\
  --headers 'Content-Type=application/json' \\
  --body '{"principalId":"${SP_ID}","resourceId":"${GRAPH_SP_ID}","appRoleId":"${GRAPH_GROUP_MEMBER_READ_BASIC_ALL}"}'
EOF
