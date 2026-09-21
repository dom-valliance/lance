#!/usr/bin/env bash
#
# Usage: scripts/psql-admin.sh <database> [psql arguments...]
#
# Opens the Postgres Flexible Server to this machine's current public address,
# runs psql as the signed-in Entra account with an access token as the
# password, and removes the firewall rule again when psql exits, however it
# exits. The template owns no client rule because the address changes with the
# network (docs/runbooks/deploy.md step 7).
#
# Environment: LANCE_RESOURCE_GROUP and LANCE_PG_SERVER override the dev
# defaults. The az CLI must be logged in as the Postgres Entra administrator.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: scripts/psql-admin.sh <database> [psql arguments...]" >&2
  exit 2
fi

database=$1
shift

resource_group=${LANCE_RESOURCE_GROUP:-rg-lance-dev}
server=${LANCE_PG_SERVER:-psql-lance-dev-j7riq4}
rule_name=AllowAdminClient

address=$(curl -fsS https://api.ipify.org)
if ! [[ $address =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Could not read a public IPv4 address from api.ipify.org; got \"$address\"." >&2
  exit 1
fi

host=$(az postgres flexible-server show --resource-group "$resource_group" --name "$server" \
  --query fullyQualifiedDomainName --output tsv)
account=$(az account show --query user.name --output tsv)

close_rule() {
  az postgres flexible-server firewall-rule delete --resource-group "$resource_group" \
    --name "$server" --rule-name "$rule_name" --yes --output none 2>/dev/null || true
}
trap close_rule EXIT

echo "Opening $server to $address as rule $rule_name for this session." >&2
az postgres flexible-server firewall-rule create --resource-group "$resource_group" \
  --name "$server" --rule-name "$rule_name" \
  --start-ip-address "$address" --end-ip-address "$address" --output none 2>/dev/null

token=$(az account get-access-token --resource-type oss-rdbms --query accessToken --output tsv)
connection="host=$host port=5432 dbname=$database user=$account sslmode=require connect_timeout=8"

# The rule takes a few seconds to apply; a connection attempt in that window
# times out rather than failing fast, so probe until the server answers.
for attempt in $(seq 1 12); do
  if PGPASSWORD=$token psql "$connection" -X -q -c 'select 1' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 12 ]; then
    echo "The server did not accept a connection from $address within about 90 seconds. Check the rule in the portal and try again." >&2
    exit 1
  fi
  sleep 5
done

PGPASSWORD=$token psql "$connection" "$@"
