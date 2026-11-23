#!/usr/bin/env bash
# LabelFlow 缺表自检：把数据库里的表与 db-expected-tables.txt 对账
#
# 用法：
#   bash backend/scripts/db-verify.sh
#   DATABASE_URL=postgres://... bash backend/scripts/db-verify.sh
#
# 退出码：0 齐全；1 有缺表；2 环境不满足
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPECTED="$HERE/db-expected-tables.txt"

command -v psql >/dev/null 2>&1 || { echo "FAIL: 未找到 psql" >&2; exit 2; }
[ -f "$EXPECTED" ] || { echo "FAIL: 未找到期望清单 $EXPECTED" >&2; exit 2; }

PSQL_ARGS=()
if [ -n "${DATABASE_URL:-}" ]; then
  PSQL_ARGS=("$DATABASE_URL")
else
  [ -n "${PGHOST:-}" ] && PSQL_ARGS+=("-h" "$PGHOST")
  [ -n "${PGPORT:-}" ] && PSQL_ARGS+=("-p" "$PGPORT")
  [ -n "${PGUSER:-}" ] && PSQL_ARGS+=("-U" "$PGUSER")
  [ -n "${PGDATABASE:-}" ] && PSQL_ARGS+=("-d" "$PGDATABASE")
fi

actual=$(psql "${PSQL_ARGS[@]}" -Atq -c \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1") || {
  echo "FAIL: 无法连接数据库" >&2; exit 2; }

missing=0
while IFS= read -r t; do
  [ -z "$t" ] && continue
  if ! echo "$actual" | grep -qx "$t"; then
    echo "  MISSING: $t"
    missing=$((missing + 1))
  fi
done < "$EXPECTED"

total=$(grep -c . "$EXPECTED")
got=$(echo "$actual" | grep -c . )

if [ "$missing" = "0" ]; then
  echo "PASS: 期望 $total 张表，实际 $got 张，全部命中"
  exit 0
fi

echo "FAIL: 期望 $total 张，缺 $missing 张（实际 $got 张）" >&2
exit 1
