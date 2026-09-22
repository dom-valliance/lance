#!/usr/bin/env bash
#
# Usage: scripts/smoke-image.sh <api|web|worker> <image>
#
# Proves a built image can start. The api and worker run TypeScript under
# tsx, so their entry module is imported inside the container with the
# database and every integration left unconfigured: a missing workspace
# package fails to resolve before any connection is attempted, while the
# app's own configuration error (no DATABASE_URL) is the expected exit and
# is treated as success. The web image is a compiled server; it is started
# and must answer a request within thirty seconds.

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: scripts/smoke-image.sh <api|web|worker> <image>" >&2
  exit 2
fi

app=$1
image=$2

case "$app" in
  api|worker)
    # `import()` of the entry module resolves the whole import graph first;
    # only after that does main() run and fail on the missing database.
    output=$(docker run --rm -e NODE_ENV=production "$image" \
      ./node_modules/.bin/tsx -e "import('./src/main.ts').then(() => { console.log('modules resolved'); process.exit(0); }, (e) => { console.error(String(e && e.message || e)); process.exit(3); })" 2>&1 || true)
    echo "$output" | tail -5
    if echo "$output" | grep -Eq "ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package"; then
      echo "The $app image cannot resolve one of its modules. Add the package's src directory to apps/$app/Dockerfile." >&2
      exit 1
    fi
    ;;
  web)
    name="lance-web-smoke-$$"
    docker run --rm -d --name "$name" -p 3100:3000 -e AUTH_SECRET=smoke -e AUTH_URL=http://localhost:3100 -e AUTH_TRUST_HOST=true "$image" >/dev/null
    trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
    for attempt in $(seq 1 30); do
      # Extended regex: BSD grep on a Mac has no basic-mode alternation.
      if curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/proposals | grep -Eq '^(30[0-9]|200)$'; then
        echo "web image answered"
        exit 0
      fi
      sleep 1
    done
    echo "The web image did not answer within thirty seconds." >&2
    docker logs "$name" | tail -20 >&2
    exit 1
    ;;
  *)
    echo "Unknown app \"$app\"; expected api, web or worker." >&2
    exit 2
    ;;
esac
