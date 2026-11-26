#!/usr/bin/env bash
# =============================================================================
# deploy/init.sh —— 首次部署向导（客户现场一条命令起服务）
#
# 做的事：
#   1. 检查 docker / docker compose 是否可用
#   2. 没有 .env 就从 .env.example 生成，并自动填三个密钥（JWT / DB / service token）
#   3. 检查宿主端口是否被占用（被占用就提示改 .env 里的 PORT_*）
#   4. docker compose up -d --build，等 api 健康检查通过
#   5. 打印访问地址、默认账号、以及上线前必须做的三件事
#
# 用法：
#   ./deploy/init.sh                 # 生产模式（不灌演示数据需先改 .env 的 SEED_DEMO=0）
#   ./deploy/init.sh --demo          # 强制灌演示数据（培训/演示）
#   ./deploy/init.sh --no-build      # 不重新构建镜像（用现有镜像）
#   ./deploy/init.sh --skip-health   # 不等待健康检查（排障时用）
#
# 退出码：0 成功；1 环境不满足；2 启动失败
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

DEMO=""
BUILD=1
WAIT_HEALTH=1
for arg in "$@"; do
  case "$arg" in
    --demo) DEMO=1 ;;
    --no-demo) DEMO=0 ;;
    --no-build) BUILD=0 ;;
    --skip-health) WAIT_HEALTH=0 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 1 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

say "== LabelFlow 首次部署 =="

# ---------- 1. 依赖检查 ----------
command -v docker >/dev/null 2>&1 || die "未找到 docker，请先安装 Docker Engine（见 docs/38 §2）"
docker info >/dev/null 2>&1 || die "docker 守护进程不可用（当前用户可能没有权限，试 sudo 或加入 docker 组）"
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  die "未找到 docker compose 插件，请安装 docker-compose-plugin"
fi
ok "docker $(${DC[@]} version --short 2>/dev/null || echo 'ok')"

# ---------- 2. 生成 .env ----------
rand() { # $1=长度
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"
  fi
}

if [ ! -f .env ]; then
  [ -f .env.example ] || die "缺少 .env.example，仓库不完整"
  cp .env.example .env
  JWT="$(rand 56)"; DBP="$(rand 28)"; SVC="$(rand 40)"
  python3 - "$JWT" "$DBP" "$SVC" <<'PY'
import re, sys
jwt, dbp, svc = sys.argv[1:4]
p = '.env'
s = open(p, encoding='utf-8').read()
s = re.sub(r'^JWT_SECRET=.*$', 'JWT_SECRET=' + jwt, s, flags=re.M)
s = re.sub(r'^DB_PASS=.*$', 'DB_PASS=' + dbp, s, flags=re.M)
s = re.sub(r'^WMS_SERVICE_TOKEN=.*$', 'WMS_SERVICE_TOKEN=' + svc, s, flags=re.M)
open(p, 'w', encoding='utf-8').write(s)
print('  密钥已写入 .env（JWT/DB/service token 均为随机生成）')
PY
  chmod 600 .env
  ok "已生成 .env（权限 600）"
else
  ok "已存在 .env，保持不变（如需重置请手动删除后重跑）"
  chmod 600 .env 2>/dev/null || warn "无法把 .env 权限设为 600，请手动 chmod"
fi

# 演示数据开关（命令行覆盖 .env）
if [ -n "$DEMO" ]; then
  python3 - "$DEMO" <<'PY'
import re, sys
p = '.env'
s = open(p, encoding='utf-8').read()
s = re.sub(r'^SEED_DEMO=.*$', 'SEED_DEMO=' + sys.argv[1], s, flags=re.M)
open(p, 'w', encoding='utf-8').write(s)
PY
  warn "本次强制 SEED_DEMO=$DEMO（会写入 .env）"
fi

set -a; . ./.env; set +a
API_PORT="${PORT_API:-3200}"
CONSOLE_PORT="${PORT_CONSOLE:-5173}"
PLATFORM_PORT="${PORT_PLATFORM:-5181}"
PDA_PORT="${PORT_PDA:-5185}"
[ "${SEED_DEMO:-1}" = "0" ] && ok "SEED_DEMO=0：不灌演示数据（正式上线应保持 0）" || warn "SEED_DEMO=1：将灌入演示数据，培训环境用；正式上线请改 0"

# ---------- 3. 端口检查 ----------
port_free() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${p}$"
  else
    (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null && return 1 || return 0
  fi
}
busy=0
for pair in "API:$API_PORT" "CONSOLE:$CONSOLE_PORT" "PLATFORM:$PLATFORM_PORT" "PDA:$PDA_PORT"; do
  name="${pair%%:*}"; port="${pair##*:}"
  if port_free "$port"; then ok "端口 $port（$name）可用"; else warn "端口 $port（$name）已被占用 → 改 .env 里的 PORT_${name}"; busy=1; fi
done
[ "$busy" = "1" ] && die "存在端口冲突，先改 .env 再重跑"

# ---------- 4. 启动 ----------
if [ "$BUILD" = "1" ]; then
  say "  构建并启动（首次约 5~10 分钟，取决于机器与网络）…"
  ${DC[@]} up -d --build
else
  say "  启动（不重新构建）…"
  ${DC[@]} up -d
fi

# ---------- 5. 等健康 ----------
if [ "$WAIT_HEALTH" = "1" ]; then
  say "  等待后端健康（首次冷启动 45~120s）…"
  deadline=$(( $(date +%s) + 300 ))
  until curl -fsS "http://127.0.0.1:${API_PORT}/api/v1/health" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      printf '\n'
      die "300s 内后端未就绪。排查：${DC[*]} logs api --tail 80（常见：DB_PASS 不一致 / 端口冲突）"
    fi
    sleep 3
  done
  ok "后端健康：http://127.0.0.1:${API_PORT}/api/v1/health"
fi

# ---------- 6. 收尾 ----------
say ""
say "== 部署完成 =="
say "  租户后台  http://<本机IP>:${CONSOLE_PORT}"
say "  平台后台  http://<本机IP>:${PLATFORM_PORT}"
say "  PDA       http://<本机IP>:${PDA_PORT}    （手机/手持需与服务器同网段）"
say "  API       http://<本机IP>:${API_PORT}/api/v1"
say ""
say "  默认账号  admin / admin123（租户 default）"
say ""
say "  上线前必做（否则不算交付）："
say "   1) 立刻改 admin 密码与 operator 密码"
say "   2) ./deploy/preflight.sh  复核密钥强度与端口"
say "   3) 配好第一份备份计划：./deploy/backup.sh（见 docs/38 §6）"
say "   4) 客户数据用迁移工具导入：node tools/data-migration/import.mjs --template ./migration"
