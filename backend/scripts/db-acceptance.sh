#!/usr/bin/env bash
# D1 真库验收：一条命令跑完所有门，产出 docs/acceptance/latest.json
#   DB_PORT=5432 DB_NAME=labelflow_test ./scripts/db-acceptance.sh
set -uo pipefail
cd "$(dirname "$0")/.."

export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5432}"
export DB_NAME="${DB_NAME:-labelflow_test}"
export DB_USER="${DB_USER:-labelflow}"
export DB_PASS="${DB_PASS:-labelflow}"
export DATABASE_URL="${DATABASE_URL:-postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}}"

echo "== D1 验收：${DB_NAME}@${DB_HOST}:${DB_PORT} =="
node scripts/acceptance-run.mjs
