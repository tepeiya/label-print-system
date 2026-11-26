#!/usr/bin/env bash
# =============================================================================
# deploy/upgrade.sh —— 版本升级（有备份、有健康检查、失败给回滚命令）
#
# 流程：
#   1. 预检 .env / compose
#   2. 备份数据库（调 backup.sh）——这一步失败就中止，绝不在没有退路的情况下升级
#   3. 记录当前镜像与代码版本
#   4. docker compose build && up -d（db-init 会重跑，SQL 脚本必须幂等）
#   5. 等健康检查，通过则打印新版本；失败打印回滚命令并退出 2
#
# 用法：
#   ./deploy/upgrade.sh                 # 备份 + 构建 + 升级
#   ./deploy/upgrade.sh --no-backup     # 跳过备份（仅限已手动备份）
#   ./deploy/upgrade.sh --pull          # 先 git pull 再升级（仅部署机为 git 仓库时）
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

DO_BACKUP=1
DO_PULL=0
for arg in "$@"; do
  case "$arg" in
    --no-backup) DO_BACKUP=0 ;;
    --pull) DO_PULL=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 1 ;;
  esac
done

[ -f .env ] || { echo "缺少 .env" >&2; exit 1; }
set -a; . ./.env; set +a
API_PORT="${PORT_API:-3200}"
if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi

echo "== LabelFlow 升级 $(date '+%F %T') =="

# 1) 预检
"${DC[@]}" config >/dev/null || { echo "compose 配置无法解析，中止" >&2; exit 1; }

# 2) git pull（可选）
if [ "$DO_PULL" = "1" ]; then
  echo "  拉取新版本 …"
  git pull --ff-only || { echo "git pull 失败，中止" >&2; exit 1; }
fi

OLD_REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "  当前代码版本：$OLD_REV"
echo "  当前镜像："
"${DC[@]}" images 2>/dev/null | sed 's/^/    /' || true

# 3) 备份
BK_PATH=""
if [ "$DO_BACKUP" = "1" ]; then
  echo "  升级前备份 …"
  if OUT="$("$HERE/backup.sh" --keep="${KEEP:-14}" | tee /tmp/lf-backup-$$.log | grep -o '完成：.*' | sed 's/完成：//')" && [ -n "$OUT" ]; then
    BK_PATH="$OUT"
    echo "  ✓ 备份：$BK_PATH"
  else
    echo "  ✗ 备份失败，中止升级（先修备份，别裸奔）" >&2
    tail -5 /tmp/lf-backup-$$.log >&2 || true
    exit 1
  fi
else
  echo "  ! 跳过备份（--no-backup）"
fi
rm -f /tmp/lf-backup-$$.log

# 4) 构建 + 启动
echo "  构建镜像（首次/有代码变更时较慢）…"
"${DC[@]}" build || { echo "  ✗ 构建失败，服务仍在旧版本运行" >&2; exit 1; }

echo "  重启服务（db-init 会按幂等脚本补齐结构变更）…"
"${DC[@]}" up -d || { echo "  ✗ 启动失败" >&2; exit 1; }

# 5) 健康检查
echo "  等待健康检查（冷启动最长 300s）…"
deadline=$(( $(date +%s) + 300 ))
until curl -fsS "http://127.0.0.1:${API_PORT}/api/v1/health" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "  ✗ 升级后 300s 未通过健康检查" >&2
    echo "  查看日志：${DC[*]} logs api --tail 100" >&2
    if [ -n "$BK_PATH" ]; then
      echo "  回滚数据：./deploy/restore.sh $BK_PATH/db.dump --confirm" >&2
      echo "  回滚代码：git checkout $OLD_REV && ./deploy/upgrade.sh --no-backup" >&2
    fi
    exit 2
  fi
  sleep 3
done

NEW_REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo ""
echo "== 升级完成 =="
echo "  版本：$OLD_REV → $NEW_REV"
echo "  健康：http://127.0.0.1:${API_PORT}/api/v1/health"
[ -n "$BK_PATH" ] && echo "  本次备份：$BK_PATH"
echo "  建议：登录后跑一遍关键路径（扫码收货 → 打印 → 装箱 → 出库），见 docs/38 §8"
