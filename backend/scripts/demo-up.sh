#!/usr/bin/env bash
# =============================================================================
# D5-1 一键演示环境（医疗 UDI 场景）
#
#   bash backend/scripts/demo-up.sh                 # 起依赖 → 建库 → 灌样板 → 起 API → 健康检查
#   bash backend/scripts/demo-up.sh --reset-db      # 先删库重建（清空历史演示数据）
#   bash backend/scripts/demo-up.sh --data-only     # 只准备数据库，不编译/起服务
#   bash backend/scripts/demo-up.sh --with-web      # 额外把 web 前端也起起来（vite preview）
#   bash backend/scripts/demo-up.sh --down          # 停掉本脚本起的 API / web
#
# 设计：本机无 docker 时用"系统 PG + 系统 Redis + node dist"等价起法；
#       有 docker 且 daemon 可用时，优先 docker compose（与交付环境一致）。
#
# 产出：数据库 labelflow_demo（默认租户 1 · admin/admin123）
#       20 个医用耗材物料 / 2 张工单 / 50 个 UDI 单品（见 seed-demo-hospital.sql）
# =============================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$BACKEND/.." && pwd)"

API_PORT="${API_PORT:-3201}"
WEB_PORT="${WEB_PORT:-4173}"
DB_URL="${DEMO_DATABASE_URL:-postgres://labelflow:labelflow@127.0.0.1:5432/labelflow_demo}"
DEMO_TENANT_ID="${DEMO_TENANT_ID:-1}"
RUN_DIR="${RUN_DIR:-/tmp/labelflow-demo}"
mkdir -p "$RUN_DIR"

RESET_DB=0; DATA_ONLY=0; WITH_WEB=0; DOWN=0
for arg in "$@"; do
  case "$arg" in
    --reset-db) RESET_DB=1 ;;
    --data-only) DATA_ONLY=1 ;;
    --with-web) WITH_WEB=1 ;;
    --down) DOWN=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

pidfile() { echo "$RUN_DIR/$1.pid"; }

# 按监听端口找 pid（比 $! 可靠：node 可能被包一层，$! 会落在包装进程上）
port_pid() {
  ss -lptn "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

stop_one() {
  local name="$1" f port pid; f="$(pidfile "$name")"
  port=$([ "$name" = web ] && echo "$WEB_PORT" || echo "$API_PORT")
  pid="$(port_pid "$port")"
  [ -z "$pid" ] && [ -f "$f" ] && pid="$(cat "$f")"
  [ -z "$pid" ] && { warn "$name 未在运行"; rm -f "$f"; return 0; }
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null; sleep 3
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$f"; ok "$name 已停止（pid $pid）"
}

if [ "$DOWN" = "1" ]; then
  log "停止演示进程"
  stop_one api; stop_one web
  echo; echo "数据库 labelflow_demo 保留（要清空用 --reset-db 重新起）。"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. 依赖就绪（PG / Redis）
# ---------------------------------------------------------------------------
log "1/5 依赖检查"

command -v psql >/dev/null 2>&1 || die "缺 psql（apt install postgresql-client）"

# 是否用 docker compose
USE_DOCKER=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then USE_DOCKER=1; fi

if [ "$USE_DOCKER" = "1" ]; then
  ok "检测到可用 docker，走 compose 模式"
  ( cd "$REPO" && docker compose up -d postgres redis ) || die "compose 起数据库失败"
  for i in $(seq 1 40); do
    docker compose -f "$REPO/docker-compose.yml" exec -T postgres pg_isready -U labelflow >/dev/null 2>&1 && break
    sleep 2
  done
else
  warn "无可用 docker，改用系统 PG/Redis（等价起法，与 compose 同版本 14/6）"
  if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    if command -v pg_ctlcluster >/dev/null 2>&1; then sudo pg_ctlcluster 14 main start >/dev/null 2>&1; fi
  fi
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 || die "PostgreSQL 5432 不可用（sudo pg_ctlcluster 14 main start）"
  ok "PostgreSQL 就绪"
  if ! redis-cli -p 6379 ping >/dev/null 2>&1; then redis-server --daemonize yes --port 6379 >/dev/null 2>&1 || true; fi
  redis-cli -p 6379 ping >/dev/null 2>&1 && ok "Redis 就绪" || die "Redis 6379 不可用"
fi

# ---------------------------------------------------------------------------
# 2. 建库（必要时重建）
# ---------------------------------------------------------------------------
log "2/5 建库"

PG_ADMIN="${DEMO_PG_ADMIN_URL:-postgres://labelflow:labelflow@127.0.0.1:5432/postgres}"
DB_NAME_DEMO="${DB_NAME_DEMO:-labelflow_demo}"

if [ "$RESET_DB" = "1" ]; then
  warn "--reset-db：删除 $DB_NAME_DEMO 并重建"
  psql "$PG_ADMIN" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB_NAME_DEMO WITH (FORCE)" || die "删库失败"
  psql "$PG_ADMIN" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB_NAME_DEMO OWNER labelflow" || die "建库失败"
fi

if psql "$PG_ADMIN" -Atq -c "SELECT 1 FROM pg_database WHERE datname='$DB_NAME_DEMO'" | grep -q 1; then
  ok "数据库 $DB_NAME_DEMO 已存在（保留现有数据；要清空加 --reset-db）"
else
  psql "$PG_ADMIN" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB_NAME_DEMO OWNER labelflow" || die "建库失败"
  ok "已创建数据库 $DB_NAME_DEMO"
fi

# ---------------------------------------------------------------------------
# 3. 结构 + 样板数据（db-init.sh 的 --seed-demo 会跑 manifest 里 @demo 开头的脚本）
# ---------------------------------------------------------------------------
log "3/5 建表 + 注入医疗样板数据（20 物料 / 2 工单 / 50 UDI 码）"
DATABASE_URL="$DB_URL" DEMO_TENANT_ID="$DEMO_TENANT_ID" \
  bash "$HERE/db-init.sh" --seed-demo || die "建库/灌注失败"

psql "$DB_URL" -Atq -c "
  SELECT '物料 ' || (SELECT count(*) FROM materials WHERE tenant_id=$DEMO_TENANT_ID)
      || ' / 工单 ' || (SELECT count(*) FROM wms_work_orders WHERE tenant_id=$DEMO_TENANT_ID)
      || ' / UDI ' || (SELECT count(*) FROM udi_units WHERE tenant_id=$DEMO_TENANT_ID)
      || ' / 批次 ' || (SELECT count(*) FROM stock_batches WHERE tenant_id=$DEMO_TENANT_ID)"
ok "数据自检通过"

[ "$DATA_ONLY" = "1" ] && { log "完成（--data-only）"; echo "数据库：$DB_URL"; exit 0; }

# ---------------------------------------------------------------------------
# 4. 编译并起后端
# ---------------------------------------------------------------------------
log "4/5 起后端 API"
stop_one api >/dev/null 2>&1 || true

( cd "$BACKEND" && npx tsc -p tsconfig.json ) || die "后端编译失败（cd backend && npx tsc -p tsconfig.json）"
ok "后端编译通过"

psql "$DB_URL" -Atq -c "SELECT 1" >/dev/null || die "数据库连不上：$DB_URL"

( cd "$BACKEND" && \
  DB_PORT="${DB_PORT_DEMO:-5432}" DB_NAME="$DB_NAME_DEMO" DB_HOST=127.0.0.1 \
  DB_USER=labelflow DB_PASSWORD=labelflow \
  REDIS_HOST=127.0.0.1 REDIS_PORT=6379 \
  PORT="$API_PORT" LOG_FORMAT=pretty \
  nohup node dist/src/main.js >"$RUN_DIR/api.log" 2>&1 </dev/null & echo $! >"$(pidfile api)" )
ok "后端已启动（日志 $RUN_DIR/api.log）"

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$API_PORT/health/ready" >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[ "${READY:-0}" = "1" ] && ok "健康检查 /health/ready 通过" || { tail -25 "$RUN_DIR/api.log" >&2; die "后端 120s 内未就绪，见 $RUN_DIR/api.log"; }

TOKEN="$(curl -fsS -X POST "http://127.0.0.1:$API_PORT/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' 2>/dev/null | sed -nE 's/.*"accessToken":"([^"]+)".*/\1/p')"
if [ -n "${TOKEN:-}" ]; then ok "演示账号登录成功（admin / admin123）"; else warn "登录接口未取到 token，请手动检查（可能是首次改密要求）"; fi

# ---------------------------------------------------------------------------
# 5. 可选：前端 web
# ---------------------------------------------------------------------------
if [ "$WITH_WEB" = "1" ]; then
  log "5/5 起 web 前端"
  stop_one web >/dev/null 2>&1 || true
  ( cd "$REPO/apps/web" && npm run build >"$RUN_DIR/web-build.log" 2>&1 ) || warn "web 构建失败，见 $RUN_DIR/web-build.log（不影响 API 演示）"
  if [ -d "$REPO/apps/web/dist" ]; then
    ( cd "$REPO/apps/web" && VITE_API_BASE="http://127.0.0.1:$API_PORT" nohup npx vite preview --port "$WEB_PORT" --host 127.0.0.1 >"$RUN_DIR/web.log" 2>&1 </dev/null & echo $! >"$(pidfile web)" )
    sleep 3; ok "web 预览 http://127.0.0.1:$WEB_PORT"
  fi
else
  log "5/5 跳过 web（需要前端演示加 --with-web）"
fi

cat <<EOF

────────────────────────────────────────────────────────────
 演示环境已就绪
────────────────────────────────────────────────────────────
 API       http://127.0.0.1:$API_PORT      （健康检查 /health/ready）
 账号      admin / admin123
 PDA 端    cd apps/pda && npm run dev    （发料作业：/issuing）
 演示数据  20 个医用耗材物料 / 2 张工单（WO-DEMO-001 待发料、WO-DEMO-002 发料中）/ 50 个 UDI 单品
 导出      GET /api/v1/udi/export/units.file?format=xlsx|xml （base64，见《能力清单》U6 行）
 停服务    bash backend/scripts/demo-up.sh --down
────────────────────────────────────────────────────────────
EOF
