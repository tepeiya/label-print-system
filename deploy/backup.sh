#!/usr/bin/env bash
# =============================================================================
# deploy/backup.sh —— 数据库 + 配置备份（可定时跑）
#
# 产物（每次一个目录）：
#   backups/labelflow-YYYYmmdd-HHMMSS/
#     db.dump         pg_dump 自定义格式（pg_restore 可选择性恢复）
#     .env            配置快照（权限 600，含密钥，注意保管）
#     manifest.txt    时间/版本/大小/SHA256
#
# 用法：
#   ./deploy/backup.sh                      # 备份到 ./backups
#   ./deploy/backup.sh --out=/data/bk --keep=30
#
# 建议 crontab（每天 02:30）：
#   30 2 * * * cd /opt/labelflow && ./deploy/backup.sh --keep 30 >> /var/log/labelflow-backup.log 2>&1
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

OUT="${BACKUP_DIR:-./backups}"
KEEP="${KEEP:-14}"
for arg in "$@"; do
  case "$arg" in
    --out=*) OUT="${arg#*=}" ;;
    --keep=*) KEEP="${arg#*=}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（用 --out=DIR / --keep=N）" >&2; exit 1 ;;
  esac
done

[ -f .env ] || { echo "缺少 .env" >&2; exit 1; }
set -a; . ./.env; set +a
DB_NAME_V="${DB_NAME:-labelflow}"; DB_USER_V="${DB_USER:-labelflow}"
if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi

STAMP="$(date +%Y%m%d-%H%M%S)"
DIR="$OUT/labelflow-$STAMP"
mkdir -p "$DIR"

echo "== LabelFlow 备份 $STAMP =="
echo "  数据库：$DB_NAME_V  输出：$DIR"

# 1) 数据库（自定义格式，支持 pg_restore --list 校验）
if ! "${DC[@]}" exec -T postgres pg_dump -U "$DB_USER_V" -d "$DB_NAME_V" -Fc --no-owner --no-privileges > "$DIR/db.dump" 2>"$DIR/pg_dump.err"; then
  echo "  pg_dump 失败：" >&2
  tail -5 "$DIR/pg_dump.err" >&2
  exit 1
fi
[ -s "$DIR/db.dump" ] || { echo "  db.dump 为空，备份失败" >&2; exit 1; }

# 2) 自检：能在容器里列出备份内容，说明文件没坏
if "${DC[@]}" exec -T postgres pg_restore --list < "$DIR/db.dump" > "$DIR/db.toc" 2>/dev/null; then
  echo "  ✓ db.dump 可读（TOC 条目 $(wc -l < "$DIR/db.toc") 行）"
else
  echo "  ✗ db.dump 无法解析，备份不可信" >&2
  exit 1
fi

# 3) 配置快照（注意内含密钥）
cp .env "$DIR/.env" && chmod 600 "$DIR/.env"

# 4) manifest
SIZE="$(du -h "$DIR/db.dump" | awk '{print $1}')"
SHA="$(sha256sum "$DIR/db.dump" | awk '{print $1}')"
REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$DIR/manifest.txt" <<EOF
backup_at=$STAMP
db_name=$DB_NAME_V
db_size=$SIZE
db_sha256=$SHA
code_rev=$REV
node_env=${NODE_ENV:-unknown}
EOF
echo "  ✓ manifest 写入（sha256 ${SHA:0:12}…）"

# 5) 清理旧备份（按目录名排序，保留最新 KEEP 份）
if [ "$KEEP" -gt 0 ] 2>/dev/null; then
  mapfile -t OLD < <(find "$OUT" -maxdepth 1 -type d -name 'labelflow-*' | sort | head -n -"$KEEP" 2>/dev/null || true)
  for d in "${OLD[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d" && echo "  清理旧备份：$(basename "$d")"
  done
fi

echo "  完成：$DIR"
echo "  恢复：./deploy/restore.sh $DIR/db.dump --confirm"
