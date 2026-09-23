#!/usr/bin/env bash
#
# Usage: scripts/verify-deploy.sh <dev|prod> <image tag>
#
# Reads a deployed environment the way a person would after a deploy, and fails
# on the first thing a person would stop at. A Running revision proves only that
# a process started (docs/runbooks/deploy.md), so this checks, in order:
#
#   1. Each app's latest revision carries the expected image tag and is Running
#      and Healthy, waiting up to five minutes for revisions still activating.
#   2. The web app answers a page request and the api answers both probes,
#      /health/ready included, which proves the api can read system_state.
#   3. The api and worker console logs of the new revision carry their start-up
#      lines ("Server listening at" and "worker started"), waiting up to two
#      minutes for a container that is still booting. A revision older than the
#      log window (thirty minutes) has scrolled its start-up line out of the tail
#      the CLI can read, so for one of those the tail is read for error-level
#      lines and the count reported instead.
#
# What it cannot see from outside: failed pg-boss jobs and failed agent runs.
# docs/runbooks/observing.md covers those, and they are read after every deploy
# that changes the worker.

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: scripts/verify-deploy.sh <dev|prod> <image tag>" >&2
  exit 2
fi

environment=$1
tag=$2
resource_group="rg-lance-${environment}"
apps=(web api worker)
revision_deadline_seconds=300
log_deadline_seconds=120
poll_seconds=10
failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$(( failures + 1 ))
}

latest_revision() {
  az containerapp show -g "${resource_group}" -n "ca-lance-$1-${environment}" --query properties.latestRevisionName -o tsv
}

# 1. Revisions
# Kept in revision_<app> variables rather than an associative array: the script
# also runs on a Mac, whose system bash (3.2) has none.
for app in "${apps[@]}"; do
  name="ca-lance-${app}-${environment}"
  elapsed=0
  while :; do
    revision=$(latest_revision "${app}")
    # tsv prints one array element per line; paste joins them and keeps the final
    # newline that read needs to return success under set -e.
    read -r image state health < <(az containerapp revision show -g "${resource_group}" -n "${name}" --revision "${revision}" \
      --query "[properties.template.containers[0].image, properties.runningState, properties.healthState]" -o tsv | paste -sd ' ' -)
    printf -v "revision_${app}" '%s' "${revision}"
    if [[ "${image##*:}" != "${tag}" ]]; then
      fail "${name} latest revision ${revision} runs ${image}, expected tag ${tag}. The deployment did not take, or a later one replaced it."
      break
    fi
    # The worker holds at one replica, so its steady state reads RunningAtMaxScale.
    if [[ "${state}" =~ ^Running(AtMaxScale)?$ && "${health}" == "Healthy" ]]; then
      echo "ok: ${name} ${revision} is Running and Healthy on ${image}"
      break
    fi
    if [[ "${state}" == "Failed" || "${health}" == "Unhealthy" ]]; then
      fail "${name} ${revision} is ${state}/${health}. Read: az containerapp logs show -g ${resource_group} -n ${name} --revision ${revision} --type system --tail 50"
      break
    fi
    if (( elapsed >= revision_deadline_seconds )); then
      fail "${name} ${revision} is still ${state}/${health} after ${revision_deadline_seconds}s."
      break
    fi
    sleep "${poll_seconds}"
    elapsed=$(( elapsed + poll_seconds ))
  done
done

# 2. Endpoints
fqdn() {
  az containerapp show -g "${resource_group}" -n "ca-lance-$1-${environment}" --query properties.configuration.ingress.fqdn -o tsv
}
web_fqdn=$(fqdn web)
api_fqdn=$(fqdn api)

status_of() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$1" || echo "000"
}

web_status=$(status_of "https://${web_fqdn}/proposals")
if [[ "${web_status}" =~ ^(200|30[0-9])$ ]]; then
  echo "ok: https://${web_fqdn}/proposals answered ${web_status}"
else
  fail "https://${web_fqdn}/proposals answered ${web_status}; expected 200 or a redirect to sign-in."
fi

live_body=$(curl -sS --max-time 20 "https://${api_fqdn}/health/live" || true)
if [[ "${live_body}" == *'"ok":true'* ]]; then
  echo "ok: https://${api_fqdn}/health/live answered ${live_body}"
else
  fail "https://${api_fqdn}/health/live answered '${live_body}'; expected {\"ok\":true}."
fi

ready_status=$(status_of "https://${api_fqdn}/health/ready")
ready_body=$(curl -sS --max-time 20 "https://${api_fqdn}/health/ready" || true)
if [[ "${ready_status}" == "200" ]]; then
  echo "ok: https://${api_fqdn}/health/ready answered ${ready_body}"
else
  fail "https://${api_fqdn}/health/ready answered ${ready_status} ${ready_body}. The api cannot read system_state: check the database connection and that the migration job has run."
fi

# 3. Console start-up lines
log_window_minutes=30

console_log() {
  az containerapp logs show -g "${resource_group}" -n "ca-lance-$1-${environment}" --revision "$2" --type console --tail 300 2>/dev/null \
    | jq -r '.Log // empty' || true
}

# ISO 8601 with a zone suffix to epoch seconds, on GNU date (the runner) and BSD
# date (a Mac). The zone is UTC in both places the value comes from.
epoch_of() {
  local stamp
  stamp=$(sed -E 's/[.+Z].*$//' <<< "$1")
  date -u -d "${stamp}" +%s 2>/dev/null || TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "${stamp}" +%s
}

revision_age_minutes() {
  local created
  created=$(az containerapp revision show -g "${resource_group}" -n "ca-lance-$1-${environment}" --revision "$2" --query properties.createdTime -o tsv)
  echo $(( ( $(date -u +%s) - $(epoch_of "${created}") ) / 60 ))
}

report_error_lines() {
  local app=$1 revision=$2 log errors count
  log=$(console_log "${app}" "${revision}")
  errors=$(grep -E '"level":(50|60)|job failed' <<< "${log}" || true)
  count=$(grep -c . <<< "${errors}" || true)
  if [[ "${count}" -eq 0 ]]; then
    echo "ok: ca-lance-${app}-${environment} ${revision} has no error-level lines in its last 300 console lines"
  else
    echo "note: ca-lance-${app}-${environment} ${revision} has ${count} error-level line(s) in its last 300 console lines; the last three:"
    tail -3 <<< "${errors}"
  fi
}

expect_start_line() {
  local app=$1 pattern=$2 variable="revision_$1" elapsed=0 log revision age
  revision=${!variable}
  age=$(revision_age_minutes "${app}" "${revision}")
  if (( age > log_window_minutes )); then
    echo "note: ca-lance-${app}-${environment} ${revision} was created ${age} minutes ago, so its start-up line has left the readable tail; start-up line not checked"
    report_error_lines "${app}" "${revision}"
    return
  fi
  while :; do
    log=$(console_log "${app}" "${revision}")
    if grep -q "${pattern}" <<< "${log}"; then
      echo "ok: ca-lance-${app}-${environment} ${revision} logged \"${pattern}\""
      report_error_lines "${app}" "${revision}"
      return
    fi
    if (( elapsed >= log_deadline_seconds )); then
      fail "ca-lance-${app}-${environment} ${revision} has not logged \"${pattern}\" after ${log_deadline_seconds}s. Last lines:"
      tail -20 <<< "${log}" >&2
      return
    fi
    sleep "${poll_seconds}"
    elapsed=$(( elapsed + poll_seconds ))
  done
}

expect_start_line api "Server listening at"
expect_start_line worker "worker started"

if (( failures > 0 )); then
  echo "${failures} check(s) failed for ${environment} at tag ${tag}." >&2
  exit 1
fi
echo "All checks passed for ${environment} at tag ${tag}: web https://${web_fqdn} api https://${api_fqdn}"
