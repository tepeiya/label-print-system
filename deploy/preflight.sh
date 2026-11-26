#!/usr/bin/env bash
# =============================================================================
# deploy/preflight.sh —— 上线前自检（不启动服务，只检查配置与环境）
#
# 检查项：
#   · .env 存在、权限、关键变量非示例值
#   · 生产模式下密钥/口令强度（后端也会拦，这里提前给出人话原因）
#   · 宿主端口是否被占用
#   · 磁盘空间、时区、Docker 版本
#   · 备份目录是否存在且可写
#   · compose 配置能否解析
#
# 用法：./deploy/preflight.sh            # 退出码 0=可上线，1=有 FAIL
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

FAILS=0
WARNS=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; WARNS=$((WARNS+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILS=$((FAILS+1)); }

printf '== LabelFlow 上线前自检 ==\n'

# ---------- .env ----------
if [ ! -f .env ]; then
  fail "缺少 .env（先运行 ./deploy/init.sh 或 cp .env.example .env）"
  printf '\n自检结果：FAIL=%s WARN=%s\n' "$FAILS" "$WARNS"
  exit 1
fi
pass ".env 存在"
perm="$(stat -c '%a' .env 2>/dev/null || echo '?')"
[ "$perm" = "600" ] && pass ".env 权限 600" || warn ".env 权限为 $perm，建议 chmod 600（内含数据库口令）"

set -a; . ./.env; set +a

NODE_ENV_V="${NODE_ENV:-development}"
JWT="${JWT_SECRET:-}"
DBP="${DB_PASS:-}"
SVC="${WMS_SERVICE_TOKEN:-}"

if [ "$NODE_ENV_V" = "production" ]; then
  pass "NODE_ENV=production"
  [ "${#JWT}" -ge 32 ] || fail "JWT_SECRET 长度 ${#JWT}<32（生产必须 ≥32）"
  case "$JWT" in *change-me*|*REPLACE_WITH*) fail "JWT_SECRET 仍是示例值" ;; *) [ "${#JWT}" -ge 32 ] && pass "JWT_SECRET 长度 $(( ${#JWT} )) 且非示例值" ;; esac
  [ "${#DBP}" -ge 16 ] || fail "DB_PASS 长度 ${#DBP}<16（生产必须 ≥16）"
  case "$DBP" in labelflow|CHANGE_ME*|postgres) fail "DB_PASS 是弱口令/示例值" ;; *) [ "${#DBP}" -ge 16 ] && pass "DB_PASS 强度可用" ;; esac
  [ "${#SVC}" -ge 32 ] || warn "WMS_SERVICE_TOKEN 偏短（${#SVC}），内部打印调用建议 ≥32"
else
  warn "NODE_ENV=${NODE_ENV_V}（非生产模式，弱密钥不会被拦截；对外交付必须切 production）"
fi

# ---------- 端口 ----------
port_free() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${p}$"
  else
    (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null && return 1 || return 0
  fi
}
for pair in "API:${PORT_API:-3200}" "CONSOLE:${PORT_CONSOLE:-5173}" "PLATFORM:${PORT_PLATFORM:-5181}" "PDA:${PORT_PDA:-5185}"; do
  name="${pair%%:*}"; port="${pair##*:}"
  port_free "$port" && pass "端口 $port（$name）可用" || fail "端口 $port（$name）被占用"
done

# ---------- 系统 ----------
avail_gb="$(df -Pk / 2>/dev/null | awk 'NR==2{printf "%d", $4/1024/1024}')"
if [ "${avail_gb:-0}" -ge 10 ]; then pass "根分区剩余 ${avail_gb}GB（≥10GB）"; else warn "根分区剩余 ${avail_gb}GB，数据库增长与备份可能不够"; fi

tz="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)"
case "$tz" in
  Asia/Shanghai|Asia/Chongqing|PRC|unknown) pass "时区 $tz" ;;
  *) warn "时区为 $tz，建议 Asia/Shanghai（单据时间会按服务器时区落库）" ;;
esac

if command -v docker >/dev/null 2>&1; then
  dv="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '')"
  [ -n "$dv" ] && pass "Docker $dv" || fail "docker 不可用"
else
  fail "未安装 docker"
fi

# ---------- compose 解析 ----------
if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi
if "${DC[@]}" config >/dev/null 2>&1; then pass "compose 配置可解析"; else fail "compose 配置解析失败（${DC[*]} config 看详情）"; fi

# ---------- 备份目录 ----------
BK="${BACKUP_DIR:-./backups}"
mkdir -p "$BK" 2>/dev/null && [ -w "$BK" ] && pass "备份目录 $BK 可写" || fail "备份目录 $BK 不可写"

printf '\n自检结果：FAIL=%s WARN=%s\n' "$FAILS" "$WARNS"
[ "$FAILS" = "0" ] && printf '可以上线。\n' || printf '有 FAIL 项，先修再上线。\n'
[ "$FAILS" = "0" ]
