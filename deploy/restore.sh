#!/usr/bin/env bash
# =============================================================================
# deploy/restore.sh —— 从 backups/ 的 db.dump 恢复数据库
#
# 安全设计：
#   · 必须显式加 --confirm，否则只做检查不执行（防手滑）
#   · 若同目录有 manifest.txt，先校验 sha256，不一致直接拒绝（可用 --skip-sha 绕过，仅限排障）
#   · 恢复前自动再备份一份「当前库」，避免恢复后发现要回退却已经没有退路
#   · 先停 api/worker，恢复完再起，最后做健康检查
#
# 用法：
#   ./deploy/restore.sh backups/labelflow-20261126-023000/db.dump --confirm
#
# 退出码：0 成功；1 参数/校验失败；2 恢复或健康检查失败
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

DUMP=""
CONFIRM=0
SKIP_SHA=0
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=1 ;;
    --skip-sha) SKIP_SHA=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "未知参数：$arg" >&2; exit 1 ;;
    *) DUMP="$arg" ;;
  esac
done

[ -n "$DUMP" ] || { echo "用法：./deploy/restore.sh <backup/db.dump> --confirm" >&2; exit 1; }
[ -f "$DUMP" ] || { echo "备份文件不存在：$DUMP" >&2; exit 1; }
[ -f .env ] || { echo "缺少 .env" >&2; exit 1; }

set -a; . ./.env; set +a
DB_NAME_V="${DB_NAME:-labelflow}"; DB_USER_V="${DB_USER:-labelflow}"
if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi

DIR="$(cd "$(dirname "$DUMP")" && pwd)"
echo "== LabelFlow 恢复 =="
echo "  来源：$DUMP"
[ -f "$DIR/manifest.txt" ] && sed 's/^/  /' "$DIR/manifest.txt"

# 1) sha256 校验
if [ "$SKIP_SHA" = "0" ] && [ -f "$DIR/manifest.txt" ]; then
  EXPECT="$(awk -F= '/^db_sha256=/{print $2}' "$DIR/manifest.txt")"
  ACTUAL="$(sha256sum "$DUMP" | awk '{print $1}')"
  if [ -n "$EXPECT" ] && [ "$EXPECT" != "$ACTUAL" ]; then
    echo "✗ sha256 不一致，备份可能损坏或被人替换：expected=$EXPECT actual=$ACTUAL" >&2
    echo "  确认无误可加 --skip-sha（仅排障用）" >&2
    exit 1
  fi
  [ -n "$EXPECT" ] && echo "  ✓ sha256 校验通过"
else
  echo "  ! 跳过 sha256 校验"
fi

# 2) 备份当前库（回退用）
TS="$(date +%Y%m%d-%H%M%S)"
ROLLBACK_DIR="${BACKUP_DIR:-./backups}/pre-restore-$TS"
echo "  先备份当前库到 $ROLLBACK_DIR …"
mkdir -p "$ROLLBACK_DIR"
if "${DC[@]}" exec -T postgres pg_dump -U "$DB_USER_V" -d "$DB_NAME_V" -Fc --no-owner --no-privileges > "$ROLLBACK_DIR/db.dump" 2>/dev/null; then
  echo "  ✓ 当前库已备份（万一恢复后不符预期，可用它回退）"
else
  echo "  ! 当前库备份失败（库可能不存在，继续）"
fi

if [ "$CONFIRM" != "1" ]; then
  echo ""
  echo "检查通过。恢复会用备份覆盖 ${DB_NAME_V} 库的全部数据。"
  echo "确认执行请重跑并加 --confirm："
  echo "  ./deploy/restore.sh $DUMP --confirm"
  exit 0
fi

# 3) 停服务 → 恢复 → 起服务
echo "  停止 api / worker …"
"${DC[@]}" stop api worker >/dev/null 2>&1 || true

echo "  恢复数据库 …"
if "${DC[@]}" exec -T postgres pg_restore -U "$DB_USER_V" -d "$DB_NAME_V" --clean --if-exists --no-owner --no-privileges < "$DUMP" 2>"$DIR/restore.err"; then
  echo "  ✓ 数据已恢复"
else
  # pg_restore 对「对象不存在」的 --clean 报错是正常的，只有 ERROR 才算失败
  if grep -q 'ERROR' "$DIR/restore.err"; then
    echo "  ✗ 恢复过程中有 ERROR，详情：" >&2
    grep 'ERROR' "$DIR/restore.err" | head -10 >&2
    echo "  服务仍处于停止状态。修复后重试，或用 $ROLLBACK_DIR/db.dump 回退。" >&2
    exit 2
  fi
  echo "  ✓ 数据已恢复（仅有可忽略的 clean 提示）"
fi

echo "  启动服务 …"
"${DC[@]}" up -d >/dev/null

API_PORT="${PORT_API:-3200}"
echo "  等待健康检查 …"
deadline=$(( $(date +%s) + 180 ))
until curl -fsS "http://127.0.0.1:${API_PORT}/api/v1/health" >/dev/null 2>&1; do
  [ "$(date +%s)" -ge "$deadline" ] && { echo "  ✗ 180s 内未就绪，看日志：${DC[*]} logs api --tail 60" >&2; exit 2; }
  sleep 3
done
echo "  ✓ 恢复完成，服务健康：http://127.0.0.1:${API_PORT}/api/v1/health"
echo ""
echo "  回退方式（若数据不对）：./deploy/restore.sh $ROLLBACK_DIR/db.dump --confirm --skip-sha"
