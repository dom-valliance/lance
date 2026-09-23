#!/usr/bin/env bash
#
# Usage: scripts/run-migration-job.sh <dev|prod>
#
# Starts the migration job caj-lance-migrate-<env>, waits for the execution to
# finish and prints its log. Exits 0 on Succeeded and 1 on anything else, so a
# deploy that carries a migration the job cannot apply fails here rather than at
# the apps' first use of the missing table. The job runs the Drizzle migrations
# and then the idempotent seed, so running it after a deploy with no new
# migration is a no-op that finishes in under a minute.
#
# The wait is bounded by the job's replicaTimeout (1800 s in
# infra/modules/migrate-job.bicep) plus a margin for scheduling.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: scripts/run-migration-job.sh <dev|prod>" >&2
  exit 2
fi

environment=$1
resource_group="rg-lance-${environment}"
job="caj-lance-migrate-${environment}"
poll_seconds=10
deadline_seconds=2000

execution=$(az containerapp job start -g "${resource_group}" -n "${job}" --query name -o tsv)
if [[ -z "${execution}" ]]; then
  echo "az containerapp job start returned no execution name for ${job}. Check the job exists in ${resource_group} and that you can start it." >&2
  exit 1
fi
echo "Started ${job} execution ${execution}"

show_logs() {
  az containerapp job logs show -g "${resource_group}" -n "${job}" --container migrate --execution "${execution}" --tail 100 2>/dev/null \
    | jq -r '.Log // empty' || true
}

elapsed=0
while (( elapsed < deadline_seconds )); do
  status=$(az containerapp job execution show -g "${resource_group}" -n "${job}" --job-execution-name "${execution}" --query properties.status -o tsv)
  case "${status}" in
    Succeeded)
      echo "Execution ${execution} succeeded after ${elapsed}s. Log:"
      show_logs
      exit 0
      ;;
    Failed|Stopped|Degraded)
      echo "Execution ${execution} ended as ${status} after ${elapsed}s. Log:" >&2
      show_logs >&2
      echo "Fix the migration or the job's configuration, then start the job again with scripts/run-migration-job.sh ${environment}." >&2
      exit 1
      ;;
    *)
      sleep "${poll_seconds}"
      elapsed=$(( elapsed + poll_seconds ))
      ;;
  esac
done

echo "Execution ${execution} was still ${status} after ${deadline_seconds}s. Read its log with:" >&2
echo "  az containerapp job logs show -g ${resource_group} -n ${job} --container migrate --execution ${execution}" >&2
exit 1
