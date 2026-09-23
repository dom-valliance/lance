#!/usr/bin/env bash
#
# Usage: scripts/check-deployer-roles.sh [infra directory]
#
# The GitHub deploy identity may assign only the roles listed in
# infra/deployer.bicep (assignableRoleIds); its Role Based Access Control
# Administrator assignment carries a condition that refuses every other role.
# main.bicep's modules declare the roles they assign as `<name>RoleId = '<guid>'`
# variables. This check fails when a module assigns a role the deployer list
# does not carry, because that deploy would fail on the role assignment with
# AuthorizationFailed after the apps had already moved to the new image.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
infra_dir="${1:-${repo_root}/infra}"
deployer="${infra_dir}/deployer.bicep"
guid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

if [[ ! -f "${deployer}" ]]; then
  echo "No deployer template at ${deployer}." >&2
  exit 2
fi

allowed=$(sed -n '/^var assignableRoleIds = \[/,/^\]/p' "${deployer}" | grep -oE "${guid}" | sort -u)
if [[ -z "${allowed}" ]]; then
  echo "assignableRoleIds in ${deployer} is empty or not where this check expects it." >&2
  exit 1
fi

missing=0
for module in "${infra_dir}"/modules/*.bicep; do
  [[ "$(basename "${module}")" == "deployer.bicep" ]] && continue
  while IFS= read -r line; do
    id=$(grep -oE "${guid}" <<< "${line}")
    if ! grep -qx "${id}" <<< "${allowed}"; then
      echo "${module}: assigns ${line#var } which infra/deployer.bicep does not allow the deploy identity to assign. Add the id to assignableRoleIds and redeploy infra/deployer.bicep (docs/runbooks/github-deploy-setup.md)." >&2
      missing=$(( missing + 1 ))
    fi
  done < <(grep -E "^var [A-Za-z]+RoleId = '${guid}'" "${module}" || true)
done

if (( missing > 0 )); then
  exit 1
fi
echo "Every role main.bicep assigns is in the deploy identity's allowed list ($(wc -l <<< "${allowed}" | tr -d ' ') roles)."
