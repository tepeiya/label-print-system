#!/usr/bin/env bash
# LabelFlow 一键建库：按 db-manifest.txt 的顺序把所有 SQL 执行一遍（全部幂等，可重复跑）
#
# 用法：
#   bash backend/scripts/db-init.sh                      # 用 PG* 环境变量或 DATABASE_URL
#   DATABASE_URL=postgres://u:p@host:5433/labelflow bash backend/scripts/db-init.sh
#   bash backend/scripts/db-init.sh --seed-demo          # 额外注入演示数据
#   bash backend/scripts/db-init.sh --dry-run            # 只打印将要执行的顺序
#   bash backend/scripts/db-init.sh --verify-only        # 只检查表是否齐全
#
# 变量：
#   SQL_DIR        迁移脚本目录（默认：本脚本所在目录）
#   BASE_DDL       基础 DDL 路径（默认：<repo>/docs/03-database.sql；容器内 /app/docs/03-database.sql）
#   REPO_ROOT      仓库根（默认：脚本目录的上两级）
#
# 退出码：0 全部成功；1 某步失败；2 环境不满足（无 psql / 无连接）
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="${SQL_DIR:-$HERE}"
MANIFEST="$SQL_DIR/db-manifest.txt"
REPO_ROOT="${REPO_ROOT:-$(cd "$HERE/../.." && pwd)}"
BASE_DDL="${BASE_DDL:-$REPO_ROOT/docs/03-database.sql}"

SEED_DEMO=0
DRY_RUN=0
VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --seed-demo) SEED_DEMO=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

command -v psql >/dev/null 2>&1 || { echo "FAIL: 未找到 psql（需 postgresql-client）" >&2; exit 2; }
[ -f "$MANIFEST" ] || { echo "FAIL: 未找到清单 $MANIFEST" >&2; exit 2; }

PSQL_ARGS=()
if [ -n "${DATABASE_URL:-}" ]; then
  PSQL_ARGS=("$DATABASE_URL")
else
  PSQL_ARGS=()
  [ -n "${PGHOST:-}" ] && PSQL_ARGS+=("-h" "$PGHOST")
  [ -n "${PGPORT:-}" ] && PSQL_ARGS+=("-p" "$PGPORT")
  [ -n "${PGUSER:-}" ] && PSQL_ARGS+=("-U" "$PGUSER")
  [ -n "${PGDATABASE:-}" ] && PSQL_ARGS+=("-d" "$PGDATABASE")
fi

psql_run() {
  # 统一：遇错即停、静默模式；额外变量（如演示数据的 :tid）由调用方通过剩余参数传入
  local file="$1"; shift || true
  if [ ${#PSQL_ARGS[@]} -gt 0 ] && [ "${PSQL_ARGS[0]:0:14}" = "postgres://" -o "${PSQL_ARGS[0]:0:13}" = "postgresql://" ]; then
    psql "${PSQL_ARGS[0]}" -v ON_ERROR_STOP=1 -q "$@" -f "$file"
  else
    psql "${PSQL_ARGS[@]}" -v ON_ERROR_STOP=1 -q "$@" -f "$file"
  fi
}

if [ "$VERIFY_ONLY" = "1" ]; then
  exec bash "$SQL_DIR/db-verify.sh" "${PSQL_ARGS[@]}"
fi

echo "== LabelFlow 建库 =="
echo "清单：$MANIFEST"
echo "基础 DDL：$BASE_DDL"
echo "连接：${DATABASE_URL:-PGHOST=${PGHOST:-local} PGDATABASE=${PGDATABASE:-$PGUSER}}"
echo

step=0
failed=0
started_at=$(date +%s)

while IFS= read -r raw || [ -n "$raw" ]; do
  line="$(echo "$raw" | sed -E 's/#.*$//' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  [ -z "$line" ] && continue

  optional=0
  file=""
  case "$line" in
    "@base") file="$BASE_DDL" ;;
    "@demo"*) optional=1; file="$SQL_DIR/$(echo "$line" | sed -E 's/^@demo[[:space:]]*//')" ;;
    *) file="$SQL_DIR/$line" ;;
  esac

  if [ "$optional" = "1" ] && [ "$SEED_DEMO" != "1" ]; then
    echo "[skip] $(basename "$file")（需 --seed-demo）"
    continue
  fi

  # 基础 DDL 不幂等（CREATE TABLE 无 IF NOT EXISTS）：已应用过就跳过，由缺表自检兜底
  if [ "$line" = "@base" ]; then
    base_done=$(psql "${PSQL_ARGS[@]}" -Atq -c "SELECT to_regclass('public.tenants') IS NOT NULL" 2>/dev/null || echo "f")
    if [ "$base_done" = "t" ]; then
      echo "[skip] 03-database.sql 已应用（public.tenants 存在），基础 DDL 仅首次执行"
      continue
    fi
  fi

  if [ ! -f "$file" ]; then
    echo "[FAIL] 文件不存在：$file" >&2
    exit 1
  fi

  step=$((step + 1))
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry] $step $(basename "$file")"
    continue
  fi

  t0=$(date +%s%3N)
  psql_vars=()
  # 演示数据脚本用 psql 变量 :tid 指定租户（默认 default 租户 1）
  if [ "$optional" = "1" ]; then psql_vars=(-v "tid=${DEMO_TENANT_ID:-1}"); fi

  if out="$(psql_run "$file" ${psql_vars[@]+"${psql_vars[@]}"} 2>&1)"; then
    t1=$(date +%s%3N)
    echo "[ok]   $step $(basename "$file") ($((t1 - t0))ms)"
  else
    echo "[FAIL] $step $(basename "$file")" >&2
    echo "$out" | tail -20 >&2
    failed=1
    break
  fi
done < "$MANIFEST"

[ "$DRY_RUN" = "1" ] && exit 0

if [ "$failed" != "0" ]; then
  echo >&2
  echo "建库中断。修掉上面这条 SQL 后可整体重跑（所有脚本均为幂等，重复执行安全）。" >&2
  exit 1
fi

echo
echo "== 缺表自检 =="
if ! bash "$SQL_DIR/db-verify.sh" "${PSQL_ARGS[@]}"; then
  echo "表不齐，说明有脚本漏跑或清单缺登记。" >&2
  exit 1
fi

echo
echo "建库完成：$step 个脚本，耗时 $(( $(date +%s) - started_at ))s"
echo "默认账号：admin / admin123（租户 default），operator / admin123"
echo "生产上线必改：设置 NODE_ENV=production + 强 JWT_SECRET + 非弱口令 DB 密码，否则服务拒绝启动。"
