#!/usr/bin/env bash
#
# Usage: scripts/check-migrations.sh [migrations-directory]
#
# Forward-only migration guard (CLAUDE.md conventions, spec section 3.2).
# Fails when any file under the migrations directory contains DROP TABLE or
# DROP COLUMN, matched case-insensitively as whole words. The directory
# defaults to packages/db/drizzle relative to the repository root; when it does
# not exist yet the check passes with a message.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
migrations_dir="${1:-${repo_root}/packages/db/drizzle}"

if [[ ! -d "${migrations_dir}" ]]; then
  echo "No migrations directory at ${migrations_dir} yet. Nothing to check."
  exit 0
fi

pattern='\bdrop[[:space:]]+(table|column)\b'

set +e
matches="$(grep -rIniE "${pattern}" "${migrations_dir}")"
status=$?
set -e

case "${status}" in
  0)
    echo "Destructive statements found in ${migrations_dir}:" >&2
    echo "${matches}" >&2
    echo >&2
    echo "Migrations are forward only. Remove the DROP TABLE or DROP COLUMN statement and" >&2
    echo "write a migration that adds the replacement instead, or record the deviation as an" >&2
    echo "ADR under docs/adr before changing this guard." >&2
    exit 1
    ;;
  1)
    echo "No DROP TABLE or DROP COLUMN statements in ${migrations_dir}."
    exit 0
    ;;
  *)
    echo "grep failed with exit status ${status} while scanning ${migrations_dir}." >&2
    exit "${status}"
    ;;
esac
