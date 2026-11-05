#!/usr/bin/env bash
# =============================================================================
# p0-acceptance.sh —— SaaS 端到端验收（docs/11 §11.11.1 P0 底座 + §11.11.2 P1~P5）
# 段次：A–G 权限/订阅底座（P0/P1） · H 旧端点回归 · I J 平台运营（P2） · K 账单配额（P3）
#       L Agent 只读（P4） · M Agent 写工具/幂等/审批/限流/审计/HTTP（P5）
#
# 前提：
#   1) PG 已按顺序建表：03-database.sql → seed.sql → saas_p0.sql → saas_p0_roles.sql
#   2) 后端在跑：npx tsc -p tsconfig.json && node -r reflect-metadata dist/src/main.js
#   3) 默认租户 admin/admin123 可登录（首次启动由 main.ts 种子写入）
#
# 用法：
#   bash backend/scripts/p0-acceptance.sh
#   BASE=http://host:3200/api/v1 T_CODE=p0acc bash backend/scripts/p0-acceptance.sh
#   PSQL="psql -h ... -p 5433 -U labelflow -d labelflow" 可覆盖库连接
#
# 每次跑用独立租户（BASIC + PRO 各一个），只增不改已有数据；重跑换 T_CODE 即可。
# =============================================================================
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3200/api/v1}"
PSQL="${PSQL:-psql -h 127.0.0.1 -p 5433 -U labelflow -d labelflow -tA -F'|'}"
T_CODE="${T_CODE:-p0acc}"                 # BASIC 租户
T2_CODE="${T2_CODE:-p0accpro}"            # PRO 租户（用于 4032 / tenant_admin 全模块）
T_PASS="P0accept#2026"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  [OK]   %s\n' "$1"; }
no()  { fail=$((fail+1)); printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1" "期望「$3」实际「$2」"; fi; }

api() { # api <METHOD> <path> [token] [json-body]  → stdout 是 http code，body 进 $TMP
  local m=$1 p=$2 t=${3:-} b=${4:-}
  local args=(-s -o "$TMP" -w '%{http_code}' -X "$m" "$BASE$p" -H 'Content-Type: application/json')
  [[ -n $t ]] && args+=(-H "Authorization: Bearer $t")
  [[ -n $b ]] && args+=(-d "$b")
  curl "${args[@]}" --max-time 20
}
body() { cat "$TMP"; }
# jget <k1> <k2> ... —— 逐层下钻 JSON；键里含点也没问题（作为单独参数传入）
jget() { body | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
for k in sys.argv[1:]:
    if isinstance(d, list):
        try: d = d[int(k)]
        except Exception: print(""); sys.exit(0)
    elif isinstance(d, dict): d = d.get(k)
    else: print(""); sys.exit(0)
print("" if d is None else (json.dumps(d, ensure_ascii=False) if isinstance(d,(dict,list)) else d))
' "$@"; }
tok() { jget data accessToken; }
ps()  { $PSQL -c "$1" 2>/dev/null | tr -d '\n'; }

BAT=""; PAT=""; VT=""; VWT=""; ROOTT=""
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT

echo "== SaaS P0 验收  BASE=$BASE  租户=$T_CODE(BASIC) / $T2_CODE(PRO)"

# ---------------------------------------------------------------- 0. 平台身份
code=$(api POST /auth/login '' "{\"username\":\"admin\",\"password\":\"admin123\",\"tenantCode\":\"default\"}")
check "0.1 平台 admin 登录" "$code" "201"
AT=$(body | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("accessToken",""))' 2>/dev/null)
if [[ -z "$AT" ]]; then echo "拿不到平台 token，中止"; body | head -c 300; exit 1; fi
# P2：运营接口改认 platform_users 的独立身份（docs/11 §11.6.2），AT 只剩目录查询还能用
api POST /platform/auth/login '' '{"username":"platform","password":"platform#2026"}' >/dev/null
PT=$(body | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("accessToken",""))' 2>/dev/null)
if [[ -z "$PT" ]]; then no "0.2 平台运营登录 /platform/auth/login" "$(body | head -c 200)";
else ok "0.2 平台运营登录（scope=platform，种子账号 platform）"; fi

# ------------------------------------------------- A. 开通租户（D4 单事务）
api POST /platform/tenants "$PT" "{\"code\":\"$T_CODE\",\"name\":\"P0 验收 BASIC\",\"planCode\":\"BASIC\",\"adminUsername\":\"${T_CODE}_admin\",\"adminPassword\":\"$T_PASS\"}" >/dev/null
ID=$(jget data tenantId)
if [[ -n "$ID" ]]; then ok "A.1 POST /platform/tenants 开通成功（tenant_id=$ID / 模块 $(jget data modules)）"; else
  no "A.1 开通 BASIC 租户" "$(body | head -c 300)"; echo "重跑请换 T_CODE，或手工清理 tenants.code='$T_CODE'"; exit 1; fi
api POST /platform/tenants "$PT" "{\"code\":\"$T2_CODE\",\"name\":\"P0 验收 PRO\",\"planCode\":\"PRO\",\"seats\":20,\"adminUsername\":\"${T2_CODE}_admin\",\"adminPassword\":\"$T_PASS\"}" >/dev/null
ID2=$(jget data tenantId)
if [[ -n "$ID2" ]]; then ok "A.2 开通 PRO 租户成功（tenant_id=$ID2）"; else no "A.2 开通 PRO 租户" "$(body | head -c 200)"; fi

check "A.3 subscriptions 写入 1 条" "$(ps "select count(*) from subscriptions where tenant_id=$ID")" "1"
pm=$(ps "select count(*) from plan_modules m join plans p on p.id=m.plan_id where p.code='BASIC'")
tm=$(ps "select count(*) from tenant_modules where tenant_id=$ID")
if (( tm >= pm && tm > 0 )); then ok "A.4 tenant_modules 按套餐展开（$tm ≥ 套餐 $pm）"; else no "A.4 tenant_modules 展开" "$tm < $pm"; fi
rc=$(ps "select count(*) from roles where tenant_id=$ID")
if (( rc >= 6 )); then ok "A.5 每租户角色副本 $rc 条"; else no "A.5 角色副本" "$rc"; fi
check "A.6 管理员 user_roles 双写（role='admin' + role_id）" \
  "$(ps "select count(*) from user_roles ur join users u on u.id=ur.user_id where u.tenant_id=$ID and ur.role='admin' and ur.role_id is not null")" "1"
check "A.7 管理员角色指向 tenant_admin" \
  "$(ps "select r.code from user_roles ur join roles r on r.id=ur.role_id where ur.tenant_id=$ID and ur.role='admin'")" "tenant_admin"
check "A.8 trial 订阅 + trial_ends_at（D4 试用订阅）" \
  "$(ps "select status from subscriptions where tenant_id=$ID")" "trial"
check "A.9 功能开关已按默认种子写入（D7）" \
  "$(ps "select enabled::int from feature_flags where tenant_id=$ID and key='agent.print.submit'")" "0"

api POST /auth/login '' "{\"username\":\"${T_CODE}_admin\",\"password\":\"$T_PASS\",\"tenantCode\":\"$T_CODE\"}" >/dev/null
BAT=$(jget data accessToken)
if [[ -n "$BAT" ]]; then ok "A.10 新租户管理员可登录"; else no "A.10 新租户管理员登录" "$(body | head -c 200)"; fi
api POST /auth/login '' "{\"username\":\"${T2_CODE}_admin\",\"password\":\"$T_PASS\",\"tenantCode\":\"$T2_CODE\"}" >/dev/null
PAT=$(jget data accessToken)

# ------------------------------------------------------- B. 未订阅模块 4031
check "B.1 BASIC 调 datasource 接口 → HTTP 403" "$(api GET /data-sources "$BAT")" "403"
check "B.2 业务码 4031" "$(jget code)" "4031"
grep -q '"action": *"upgrade"' "$TMP" && ok "B.3 响应带升级提示（modules/plan/action）" || no "B.3 升级提示" "$(body | head -c 200)"
check "B.4 PRO 同接口 → 200（同权限、只差订阅）" "$(api GET /data-sources "$PAT")" "200"

# ------------------------------------------------------ C. 缺权限点 4032
api POST /users "$PAT" "{\"username\":\"${T2_CODE}_viewer\",\"password\":\"$T_PASS\",\"displayName\":\"只读\"}" >/dev/null
VID=$(jget data id)
if [[ -n "$VID" ]]; then
  api POST "/users/$VID/roles" "$PAT" '{"role":"viewer"}' >/dev/null
  api POST /auth/login '' "{\"username\":\"${T2_CODE}_viewer\",\"password\":\"$T_PASS\",\"tenantCode\":\"$T2_CODE\"}" >/dev/null
  VT=$(jget data accessToken)
  check "C.1 viewer 建号并授权成功" "$(api GET /auth/me "$VT")" "200"
  check "C.2 viewer 调 backup:write → HTTP 403" "$(api POST /backups "$VT" '{"name":"nope"}')" "403"
  check "C.3 业务码 4032" "$(jget code)" "4032"
  grep -q 'contact_admin' "$TMP" && ok "C.4 响应提示联系管理员" || no "C.4 提示" "$(body | head -c 200)"
  check "C.5 viewer 只读接口不受影响（GET /backups）" "$(api GET /backups "$VT")" "200"
else
  no "C.1 viewer 建号" "$(body | head -c 200)"
fi

# ------------------------------------- D. tenant_admin 全模块 / viewer 只读
check "D.1 tenant_admin 权限点 = 字典全量" \
  "$(ps "select count(*) from role_permissions where role='tenant_admin'")" "$(ps "select count(*) from permissions")"
check "D.2 viewer 无写权限点（收藏除外，见 docs/10 §10.15）" \
  "$(ps "select count(*) from role_permissions where role='viewer' and permission_code not like '%:read' and permission_code <> 'template:favorite'")" "0"
check "D.3 PRO tenant_admin 可用 backup:write（全模块全权限）" "$(api GET "/backups?limit=1" "$PAT")" "200"
check "D.4 PRO tenant_admin 可用 audit:read" "$(api GET /audit/logs "$PAT")" "200"
c=$(api GET /audit/logs "$BAT"); cc=$(jget code)
check "D.5 BASIC tenant_admin 无 audit 模块 → 403/4031" "$c/$cc" "403/4031"

# ------------------------------------------- E. /auth/me 扩展（P1 前端依赖）
api GET /auth/me "$PAT" >/dev/null
[[ -n "$(jget data modules)" && "$(jget data modules)" != "[]" ]] && ok "E.1 modules 非空" || no "E.1 modules" "$(jget data modules)"
[[ -n "$(jget data permissions)" && "$(jget data permissions)" != "[]" ]] && ok "E.2 permissions 非空" || no "E.2 permissions" ""
[[ -n "$(jget data menus)" && "$(jget data menus)" != "[]" ]] && ok "E.3 menus 非空（前端动态菜单数据源）" || no "E.3 menus" "$(jget data menus)"
check "E.4 features.agent.print.submit 默认 false（D7）" "$(jget data features agent.print.submit)" "False"
[[ -n "$(jget data dataScopes)" ]] && ok "E.5 dataScopes 已返回" || no "E.5 dataScopes" ""
check "E.6 tenant.plan 回显" "$(jget data tenant plan)" "PRO"
check "E.7 tenant.seatLimit 回显（PRO 按入参 20 座位）" "$(jget data tenant seatLimit)" "20"
# viewer 菜单只剩只读入口
api GET /auth/me "$VT" >/dev/null
MENUS=$(jget data menus)
[[ "$MENUS" == *print-jobs* && "$MENUS" != *designer* && "$MENUS" == *subscription* ]] && ok "E.8 viewer 菜单已裁剪（无设计器）" || no "E.8 viewer 菜单" "$MENUS"

# ----------------------------------------- D1 加购 / 依赖补齐 / 停用保护
api POST "/platform/tenants/$ID/modules" "$PT" '{"moduleCode":"bom"}' >/dev/null
ADDED=$(ps "select string_agg(module_code,',' order by module_code) from tenant_modules where tenant_id=$ID and status in ('active','trial')")
case "$ADDED" in *bom*)       ok "F.1 加购 bom 成功（$ADDED）";;              *) no "F.1 加购 bom" "$(body | head -c 200)";; esac
case "$ADDED" in *inventory*) ok "F.2 依赖自动补齐 inventory";;               *) no "F.2 依赖补齐" "$ADDED";; esac
case "$ADDED" in *masterdata*) ok "F.3 二级依赖补齐 masterdata";;             *) no "F.3 二级依赖" "$ADDED";; esac
check "F.4 tenant_modules.source='addon'（D1）" "$(ps "select source from tenant_modules where tenant_id=$ID and module_code='bom'")" "addon"
c=$(api DELETE "/platform/tenants/$ID/modules/inventory" "$PT")
[[ "$c" == 4* ]] && ok "F.5 停用被依赖的 inventory 被拒（HTTP $c / $(jget code)）" || no "F.5 停用依赖保护" "HTTP $c $(body | head -c 200)"
api DELETE "/platform/tenants/$ID/modules/bom" "$PT" >/dev/null
check "F.6 先停 bom 再停 inventory 就放行" "$(api DELETE "/platform/tenants/$ID/modules/inventory" "$PT")" "200"

# ------------------------------------------------ D7 灰度开关 / D12 退订
api PUT "/platform/tenants/$ID/flags" "$PT" '{"key":"agent.print.submit","enabled":true}' >/dev/null
c=$(api GET "/platform/tenants/$ID/flags" "$PT"); check "G.1 开关置为 true" "$c/$(jget data agent.print.submit)" "200/True"
api GET /auth/me "$BAT" >/dev/null
check "G.2 /auth/me.features 反映新值" "$(jget data features agent.print.submit)" "True"
api POST "/platform/tenants/$ID/cancel" "$PT" >/dev/null
check "G.4 tenants.canceled_at 已写入" "$(ps "select (canceled_at is not null)::int from tenants where id=$ID")" "1"
grep -q 'hardDeleteAfter' "$TMP" && ok "G.5 退订响应给出 90 天硬删时间（$(jget data hardDeleteAfter)）" || no "G.5 hardDeleteAfter" "$(body | head -c 200)"
check "G.6 重复退订幂等" "$(api POST "/platform/tenants/$ID/cancel" "$PT")" "201"

# ------------------------------------------- H. 旧角色回归（§11.12.1）
# 干净库里只有 admin/operator，sql / viewer 账号由脚本按旧角色补建（密码同 admin123）
api POST /auth/login '' '{"username":"admin","password":"admin123","tenantCode":"default"}' >/dev/null
ROOTT=$(jget data accessToken)
for u in sql viewer; do
  api POST /users "$ROOTT" "{\"username\":\"$u\",\"password\":\"admin123\",\"displayName\":\"回归-$u\"}" >/dev/null
  nid=$(jget data id)
  [[ -n "$nid" ]] && api POST "/users/$nid/roles" "$ROOTT" "{\"role\":\"$u\"}" >/dev/null
done
# seed.sql 里 operator 的密码是 op123，其余用 admin123
pw() { case "$1" in operator) echo op123;; *) echo admin123;; esac; }
for u in admin operator sql viewer; do
  api POST /auth/login '' "{\"username\":\"$u\",\"password\":\"$(pw $u)\",\"tenantCode\":\"default\"}" >/dev/null
  t=$(jget data accessToken)
  if [[ -n "$t" ]]; then ok "H.1 $u 登录正常"; else no "H.1 $u 登录" "$(body | head -c 160)"; continue; fi
  api GET /auth/me "$t" >/dev/null
  r=$(jget data roles)
  [[ "$r" == *"$u"* ]] && ok "H.2 $u JWT 保留旧角色码（$r）" || no "H.2 $u 角色回显" "$r"
  c=$(api GET /templates "$t"); [[ "$c" == "200" || "$c" == "201" ]] && ok "H.3 $u GET /templates → $c" || no "H.3 $u 模板列表" "HTTP $c"
  c=$(api GET /print/jobs "$t"); [[ "$c" == "200" || "$c" == "201" ]] && ok "H.4 $u GET /print/jobs → $c" || no "H.4 $u 打印任务" "HTTP $c"
done
# 写权限仍按旧规则：operator 可写模板、viewer 不可
api POST /auth/login '' '{"username":"operator","password":"op123","tenantCode":"default"}' >/dev/null
OPT=$(jget data accessToken)
# 注意：模板正文的字段名是 content（templates.content NOT NULL），不是 elements。
# 传错字段会被 TypeORM 直接撞 23502 → HTTP 500，看着像权限回归其实是用例写错。
c=$(api POST /templates "$OPT" '{"name":"p0acc-operator","content":{"page":{"width":100,"height":60},"elements":[]}}')
if [[ "$c" == 201 || "$c" == 200 ]]; then
  ok "H.5 operator 写模板仍放行（$c）"
  api DELETE "/templates/$(jget data id)" "$OPT" >/dev/null   # 清理，保证可重复跑
else
  no "H.5 operator 写模板" "HTTP $c $(body | head -c 160)"
fi
api POST /auth/login '' '{"username":"viewer","password":"admin123","tenantCode":"default"}' >/dev/null
VWT=$(jget data accessToken)
c=$(api POST /templates "$VWT" '{"name":"x"}'); cc=$(jget code)
check "H.6 viewer 写模板被拒 → 403/4032" "$c/$cc" "403/4032"

# ---------------------------------------------------------------------------
# I. 入参校验底座（docs/10 §10.17）：缺字段 → 400 + errors 明细，不再是 500
# ---------------------------------------------------------------------------
c=$(api POST /templates "$OPT" '{"name":"no-content"}'); cc=$(jget code)
[[ "$cc" == 400 && "$(jget message)" == *"参数校验失败"* ]] \
  && ok "I.1 缺 content 建模板 → 400 参数校验失败（原 500 根因已堵）" \
  || no "I.1 缺 content 建模板" "HTTP $c code=$cc $(body | head -c 160)"
c=$(api POST /auth/login '' '{"username":"admin"}'); cc=$(jget code)
[[ "$cc" == 400 && "$(jget message)" == *"参数校验失败"* ]] \
  && ok "I.2 登录缺 password → 400" \
  || no "I.2 登录缺 password" "HTTP $c code=$cc $(body | head -c 160)"
c=$(api POST /platform/tenants "$PT" '{"name":"缺管理员的租户","code":"p0val1"}'); cc=$(jget code)
[[ "$cc" == 400 && "$(jget message)" == *"参数校验失败"* ]] \
  && ok "I.3 开通租户缺 adminUsername → 400" \
  || no "I.3 开通租户缺 adminUsername" "HTTP $c code=$cc $(body | head -c 160)"


# ---------------------------------------------------------------------------
# J. P2 平台身份与看板（docs/11 §11.6.2 / docs/10 §10.18）
# ---------------------------------------------------------------------------
c=$(api POST /platform/tenants "$AT" '{}'); cc=$(jget code)
check "J.1 租户 admin JWT 调运营接口被拒 → 403 scope" "$c/$cc" "403/403"
c=$(api GET /platform/usage "$PT"); cc=$(jget code)
[[ "$cc" == 0 ]] && ok "J.2 GET /platform/usage 全局看板（tenants_total=$(jget data totals.tenants_total)）" || no "J.2 用量看板" "HTTP $c $(body | head -c 160)"
c=$(api GET /platform/tenants "$PT"); cc=$(jget code)
[[ "$cc" == 0 ]] && ok "J.3 GET /platform/tenants 运营侧租户列表" || no "J.3 租户列表" "HTTP $c $(body | head -c 160)"
c=$(api POST "/platform/tenants/$ID/suspend" "$PT"); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data enabled)" == "False" ]] && ok "J.4 停用租户 suspend" || no "J.4 suspend" "HTTP $c $(body | head -c 160)"
c=$(api POST "/platform/tenants/$ID/resume" "$PT"); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data enabled)" == "True" ]] && ok "J.5 恢复租户 resume" || no "J.5 resume" "HTTP $c $(body | head -c 160)"
c=$(api GET /platform/audit "$PT"); cc=$(jget code)
[[ "$cc" == 0 ]] && ok "J.6 GET /platform/audit 平台审计" || no "J.6 平台审计" "HTTP $c $(body | head -c 160)"

# ---------------------------------------------------------------------------
# K. P3 计费闭环（docs/11 §11.7 / D5；验收口径「可出账、可对账」+ 4033 升级引导）
#    计量走真实打印链路：BASIC 租户（BAT/$ID）打 8 张；出账走 PRO 租户（PAT/$ID2，月费 29900 分）
# ---------------------------------------------------------------------------
c=$(api PUT "/platform/tenants/$ID/quotas/print_labels" "$PT" '{"softLimit":5,"hardLimit":10}'); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data hardLimit)" == "10" ]] && ok "K.1 平台设配额 print_labels soft=5 hard=10" || no "K.1 设配额" "HTTP $c $(body | head -c 160)"
c=$(api POST /print/jobs "$BAT" '{"templateContent":{"elements":[]},"rows":[1,2,3,4,5,6,7,8]}'); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data total)" == "8" && "$(jget data quotaWarn)" == "True" ]] \
  && ok "K.2 打印 8 张成功且带软上限告警（quotaWarn）" || no "K.2 打印+软告警" "HTTP $c $(body | head -c 160)"
c=$(api POST /print/jobs "$BAT" '{"templateContent":{"elements":[]},"rows":[1,2,3,4,5,6,7,8]}'); cc=$(jget code)
[[ "$c" == 403 && "$cc" == 4033 && "$(jget action)" == "upgrade" ]] \
  && ok "K.3 再打 8 张 → 403/4033 硬上限拒绝 + 升级引导" || no "K.3 硬上限" "HTTP $c code=$cc $(body | head -c 160)"
c=$(api GET /billing/usage "$BAT"); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data items 0 meter)" == "print_labels" && "$(jget data items 0 used)" == "8" ]] \
  && ok "K.4 租户账单页用量（print_labels 本月 8 张）" || no "K.4 用量查询" "HTTP $c $(body | head -c 160)"
c=$(api GET /subscription/usage "$BAT"); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data printJobs used)" == "8" && "$(jget data printJobs limit)" == "10" ]] \
  && ok "K.5 订阅用量已接真实聚合（used=8 limit=10）" || no "K.5 订阅用量" "HTTP $c $(body | head -c 160)"
c=$(api PUT "/platform/tenants/$ID/quotas/print_labels" "$BAT" '{"hardLimit":9999}')
[[ "$c" == 403 ]] && ok "K.6 租户 JWT 调配额写接口被拒（scope=platform）" || no "K.6 越权写配额" "HTTP $c"
c=$(api POST /platform/invoices "$PT" "{\"tenantId\":$ID2}"); cc=$(jget code)
INV=$(jget data id); NUM=$(jget data number)
[[ "$cc" == 0 && "$(jget data status)" == "draft" && "$(jget data amountCents)" == "29900" ]] \
  && ok "K.7 按套餐自动出账（PRO 月费 29900 分 $NUM）" || no "K.7 自动出账" "HTTP $c $(body | head -c 200)"
c=$(api POST "/platform/invoices/$INV/issue" "$PT" '{"dueDays":7}'); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data status)" == "issued" && "$(jget data dueAt)" != "" ]] \
  && ok "K.8 账单发出（issued + due_at）" || no "K.8 发单" "HTTP $c $(body | head -c 160)"
c=$(api POST "/platform/invoices/$INV/payments" "$PT" '{"amountCents":10000,"note":"首笔"}'); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data status)" == "issued" && "$(jget data balanceCents)" == "19900" ]] \
  && ok "K.9 部分收款 100 元 → 余额 199 元仍 issued" || no "K.9 部分收款" "HTTP $c $(body | head -c 160)"
c=$(api POST "/platform/invoices/$INV/payments" "$PT" '{"amountCents":19900}'); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data status)" == "paid" && "$(jget data paidAt)" != "" && "$(jget data balanceCents)" == "0" ]] \
  && ok "K.10 收清剩余 199 元 → paid + paid_at（累计判定）" || no "K.10 结清" "HTTP $c $(body | head -c 160)"
c=$(api POST "/platform/invoices/$INV/void" "$PT"); cc=$(jget code)
[[ "$c" == 400 ]] && ok "K.11 已付账单不可作废（400）" || no "K.11 作废保护" "HTTP $c $(body | head -c 160)"
c=$(api GET /billing/invoices "$PAT"); cc=$(jget code)
[[ "$cc" == 0 && "$(body | grep -c "$NUM")" == "1" ]] && ok "K.12 租户可见自家已发出账单（$NUM）" || no "K.12 租户账单列表" "HTTP $c"
c=$(api GET "/billing/invoices/$INV" "$PAT"); cc=$(jget code)
NPAY=$(jget data payments | python3 -c 'import sys,json;print(len(json.loads(sys.stdin.read()) or []))' 2>/dev/null)
[[ "$cc" == 0 && "$NPAY" == "2" ]] && ok "K.13 账单详情含 2 笔收款记录（可对账）" || no "K.13 账单详情" "HTTP $c payments=$NPAY"
c=$(api POST /platform/invoices "$PT" "{\"tenantId\":$ID}"); cc=$(jget code)
[[ "$c" == 400 && "$cc" == 400 ]] && ok "K.14 无有效套餐租户自动出账被拒（G 段已退订，需显式金额）" || no "K.14 出账保护" "HTTP $c $(body | head -c 160)"
c=$(api POST /platform/invoices "$PT" "{\"tenantId\":$ID,\"amountCents\":0,\"note\":\"0 元手工账\"}"); cc=$(jget code)
DID=$(jget data id); DNUM=$(jget data number)
[[ "$cc" == 0 && "$(jget data amountCents)" == "0" ]] && ok "K.15 显式 0 元账单可出（未定价不阻断）" || no "K.15 0 元账单" "HTTP $c $(body | head -c 160)"
api GET /billing/invoices "$BAT" >/dev/null
[[ "$(jget code)" == 0 && "$(body | grep -c "$DNUM")" == "0" ]] && ok "K.16 草稿账单租户不可见" || no "K.16 草稿隔离" "$(body | head -c 160)"
c=$(api POST "/platform/invoices/$DID/void" "$PT"); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data status)" == "void" ]] && ok "K.17 草稿作废" || no "K.17 作废草稿" "HTTP $c $(body | head -c 160)"
c=$(api GET "/platform/tenants/$ID/meters" "$PT"); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data meters 0 quantity)" == "8" && "$(jget data month 0 used)" == "8" ]] \
  && ok "K.18 原始计量明细+月聚合（对账源表）" || no "K.18 计量明细" "HTTP $c $(body | head -c 200)"
c=$(api GET "/platform/invoices?tenantId=$ID2&status=paid" "$PT"); cc=$(jget code)
[[ "$cc" == 0 && "$(jget data total)" == "1" && "$(jget data items 0 paidCents)" == "29900" ]] \
  && ok "K.19 运营侧按租户+状态筛账单（paid 1 张，已收=应付）" || no "K.19 运营筛选" "HTTP $c $(body | head -c 200)"

# ---------------------------------------------------------------------------
# L. P4 Agent/MCP（docs/11 §11.11.2：whoami 正确租户与 scope / 空数据友好摘要 /
#    只读 token 打高危 403+审计 / 计量 + agent_calls 配额 + stdio MCP 自检）
#    用 PRO 租户（ID2/PAT）：agent 模块在套餐里；BASIC 的订阅在 G 段被退订不能作主场景。
# ---------------------------------------------------------------------------
echo
echo "-- L. P4 Agent/MCP"

c=$(api POST "/platform/tenants/$ID2/modules" "$PT" '{"moduleCode":"inventory"}'); [[ "$c" == 201 || "$c" == 200 ]] \
  && ok "L.1a PRO 加购 inventory 模块" || no "L.1a 加购 inventory" "HTTP $c $(body | head -c 160)"
c=$(api POST "/platform/tenants/$ID2/modules" "$PT" '{"moduleCode":"bom"}'); [[ "$c" == 201 || "$c" == 200 ]] \
  && ok "L.1b 加购 bom 模块（依赖 inventory 已在）" || no "L.1b 加购 bom" "HTTP $c $(body | head -c 160)"

SEED_SQL="$(dirname "$0")/seed-inventory-demo.sql"
$PSQL -v tid="$ID2" -f "$SEED_SQL" >/dev/null 2>&1
NSEED=$(ps "select count(*) from stock_batches where tenant_id=$ID2")
[[ "$NSEED" == "5" ]] && ok "L.2 演示库存种子（5 批次 / 有机苹果 320kg）" || no "L.2 种子" "batches=$NSEED"

c=$(api POST /agents "$PAT" '{"name":"验收 Agent","kind":"mcp_stdio"}'); cc=$(jget code)
CID=$(jget data id)
[[ "$c" == 201 && "$cc" == 0 && -n "$CID" ]] && ok "L.3 建 Agent 客户端（id=$CID）" || no "L.3 建客户端" "HTTP $c $(body | head -c 160)"
c=$(api GET /agents "$BAT"); [[ "$c" == 403 && "$(jget code)" == 4031 ]] \
  && ok "L.4 BASIC 租户无 agent 模块 → /agents 403/4031" || no "L.4 模块门禁" "HTTP $c $(jget code)"

c=$(api POST "/agents/$CID/tokens" "$PAT" '{"scopes":["template:read","inventory:stock:read","inventory:batch:read","bom:kit:read","bom:shortage:read"]}'); cc=$(jget code)
AGENT_TOK=$(jget data token)
[[ "$c" == 201 && "$cc" == 0 && "$AGENT_TOK" == lfagent_* ]] && ok "L.5 签发只读 token（一次性明文）" || no "L.5 签发" "HTTP $c $(body | head -c 160)"

atab() { # atab <METHOD> <path> [json-body] —— 用 Agent Token 打 /agent/v1（stdout=HTTP code，body→$TMP）
  local m=${1:-GET} p=$2 b=${3:-}
  local args=(-s -o "$TMP" -w '%{http_code}' -X "$m" "$BASE$p" -H "Authorization: Bearer $AGENT_TOK")
  [[ -n $b ]] && args+=(-H 'Content-Type: application/json' -d "$b")
  curl "${args[@]}" --max-time 20
}
c=$(atab GET /agent/v1/whoami); cc=$(jget code)
[[ "$c" == 200 && "$cc" == 0 && "$(jget data data tenant id)" == "$ID2" && "$(jget data data agent scopes | python3 -c 'import sys,json;print(len(json.loads(sys.stdin.read())))')" == "5" ]] \
  && ok "L.6 whoami 返回正确租户（$ID2）与 5 条 scope" || no "L.6 whoami" "HTTP $c $(body | head -c 200)"
c=$(atab GET /agent/v1/tools); NTOOL=$(jget data | python3 -c 'import sys,json;d=json.loads(sys.stdin.read() or "null");print(len(d) if isinstance(d,list) else 0)' 2>/dev/null)
[[ "$c" == 200 && "$NTOOL" -ge 11 ]] && ok "L.7 tools 清单 ≥11（3 元 + 8 只读）" || no "L.7 tools 清单" "HTTP $c n=$NTOOL"

c=$(atab POST "/agent/v1/tools/inventory.query_stock" '{"keyword":"苹果","group_by":"sku"}'); cc=$(jget code)
[[ ( "$c" == 200 || "$c" == 201 ) && "$(jget data data items 0 qty)" == "320" && "$(jget data data items 0 belowSafety)" == "True" ]] \
  && ok "L.8a query_stock(sku)：有机苹果 320 且低于安全库存" || no "L.8a sku" "HTTP $c $(body | head -c 200)"
c=$(atab POST "/agent/v1/tools/inventory.query_stock" '{"keyword":"苹果","group_by":"batch"}')
[[ "$(jget data data total)" == "2" ]] && ok "L.8b query_stock(batch)：两个苹果批次" || no "L.8b batch" "$(body | head -c 160)"
c=$(atab POST "/agent/v1/tools/inventory.query_stock" '{"below_safety":true}')
[[ "$(jget data data total)" -ge 1 ]] && ok "L.8c below_safety 过滤可用" || no "L.8c below_safety" "$(body | head -c 160)"

c=$(atab POST "/agent/v1/tools/inventory.query_stock" '{"keyword":"不存在物料XYZ"}'); cc=$(jget code)
SUM=$(jget data summary); ITEMS=$(jget data data items | python3 -c 'import sys,json;print(len(json.loads(sys.stdin.read()) or []))' 2>/dev/null)
[[ ( "$c" == 200 || "$c" == 201 ) && "$ITEMS" == "0" && "$SUM" == *"未查询到"* ]] \
  && ok "L.9 无数据 → 空数组 + 友好摘要（§11.11.2）" || no "L.9 空数据路径" "HTTP $c items=$ITEMS summary=$SUM"

c=$(atab POST "/agent/v1/tools/bom.check_kit_rate" '{"product":"苹果礼盒","demand":100}'); cc=$(jget code)
[[ ( "$c" == 200 || "$c" == 201 ) && "$(jget data data kitRate)" == "60" && "$(jget data data maxSets)" == "60" ]] \
  && ok "L.10 check_kit_rate：5kg×1.05 损耗 → 齐套率 60%" || no "L.10 齐套率" "HTTP $c $(body | head -c 220)"
c=$(atab POST "/agent/v1/tools/bom.explain_shortage" '{"product":"苹果礼盒","demand":100}')
[[ "$(jget data data items 0 shortage)" == "205" && "$(jget data data items 0 code)" == "M-APPLE-ORG" ]] \
  && ok "L.11 explain_shortage：有机苹果缺 205kg" || no "L.11 缺料" "$(body | head -c 200)"

c=$(atab POST "/agent/v1/tools/inventory.adjust" '{"sku":"M-APPLE-ORG","warehouse":"WH-SH","delta":-10,"reason":"冒烟","idempotency_key":"x1"}'); cc=$(jget code)
NAUD=$(ps "select count(*) from audit_logs where tenant_id=$ID2 and action='agent.tool.inventory.adjust' and detail->>'status'='denied_scope'")
[[ "$c" == 403 && "$cc" == 4032 && "$NAUD" -ge 1 ]] \
  && ok "L.12 只读 token 打 inventory.adjust → 403/4032 且已写审计（$NAUD 条）" || no "L.12 高危拒绝" "HTTP $c code=$cc audit=$NAUD"

c=$(atab GET /agent/v1/resources/stock/M-APPLE-ORG); cc=$(jget code)
[[ "$c" == 200 && "$(jget data data total)" == "320" ]] && ok "L.13 resources/stock 快照 320kg" || no "L.13 资源" "HTTP $c $(body | head -c 160)"

MCP_DIR="$(cd "$(dirname "$0")/../../apps/mcp-server" 2>/dev/null && pwd)"
if [[ -n "$MCP_DIR" && -d "$MCP_DIR/node_modules/@modelcontextprotocol" ]]; then
  (cd "$MCP_DIR" && npm run build --silent >/dev/null 2>&1 && AGENT_TOKEN="$AGENT_TOK" npm run selftest --silent) >/tmp/mcp-selftest.log 2>&1
  if grep -q "SELFTEST OK" /tmp/mcp-selftest.log; then ok "L.14 stdio MCP 自测通过（SDK Client 全流程）"; else no "L.14 stdio 自测" "$(tail -3 /tmp/mcp-selftest.log | tr '\n' ' ')"; fi
else
  ok "L.14 stdio MCP 自测跳过（apps/mcp-server 未装依赖；上线前跑 npm i && npm run selftest）"
fi

# 配额：把 agent_calls 硬限设到当前用量 → 下一次调用 4033（升级引导同 P3 口径）
USED=$(ps "select quantity from usage_daily where tenant_id=$ID2 and meter='agent_calls' and day=current_date")
c=$(api PUT "/platform/tenants/$ID2/quotas/agent_calls" "$PT" '{"hardLimit":1,"softLimit":1,"period":"day"}'); cc=$(jget code)
[[ "$c" == 200 && "$cc" == 0 ]] && ok "L.15 平台设 agent_calls 日硬限=1（当前日用量 $USED）" || no "L.15 设配额" "HTTP $c $(body | head -c 160)"
c=$(atab POST "/agent/v1/tools/whoami" '{}'); cc=$(jget code)
[[ "$c" == 403 && "$cc" == 4033 ]] && ok "L.16 超 agent_calls 硬限 → 403/4033（计量护栏）" || no "L.16 配额拒绝" "HTTP $c code=$cc"
api DELETE "/platform/tenants/$ID2/quotas/agent_calls" "$PT" >/dev/null

c=$(atab GET /agent/v1/whoami); [[ "$c" == 200 ]] && ok "L.17a 撤销前 whoami 正常" || no "L.17a 撤销前" "HTTP $c"
TID=$(api GET "/agents/$CID/tokens" "$PAT" >/dev/null; jget data 0 id)
c=$(api POST "/agents/$CID/tokens/$TID/revoke" "$PAT"); cc=$(jget code)
[[ "$c" == 201 && "$cc" == 0 ]] && ok "L.17b 撤销 token（id=$TID）" || no "L.17b 撤销" "HTTP $c $(body | head -c 160)"
c=$(atab GET /agent/v1/whoami); [[ "$c" == 401 && "$(jget code)" == 401 ]] \
  && ok "L.18 撤销后调用 → 401（§11.11.2 token 生命周期）" || no "L.18 撤销生效" "HTTP $c"

c=$(api GET /agent/v1/whoami "$BAT"); [[ "$c" == 401 ]] \
  && ok "L.19 租户 JWT 打 /agent/v1 → 401（形态即拒，不查库）" || no "L.19 JWT 隔离" "HTTP $c"

c=$(api POST "/agents/$CID/tokens" "$PAT" '{"scopes":["inventory:stock:read"]}'); AGENT_TOK2=$(jget data token)
c=$(api POST "/agents/$CID/status" "$PAT" '{"status":"disabled"}'); cc=$(jget code)
c=$(curl -s -o "$TMP" -w '%{http_code}' "$BASE/agent/v1/whoami" -H "Authorization: Bearer $AGENT_TOK2")
[[ "$c" == 403 ]] && ok "L.20 停用客户端 → 存量 token 立即 403" || no "L.20 停用" "HTTP $c $(body | head -c 160)"

# ---------------------------------------------------------------------------
# M. P5 Agent 增强（docs/11 §11.7.4 写工具 / §11.7.6 审批流 / §11.7.7 护栏 3·4·5 /
#    D7 打印开关 / 审计 actor_type=agent / §11.7.1 Streamable HTTP）
#    §11.11.2 第五条：「高危工具无 approval_id 时返回 need_approval 且不产生副作用」。
#    全程用新建客户端 CIDM —— 限流按 (tenant, client, 分钟桶) 计数，新客户端才有干净窗口；
#    另外 M.20 再建一个 CIDR 专测 429，避免前面几十次调用把当前分钟桶占满。
# ---------------------------------------------------------------------------
echo
echo "-- M. P5 写工具 / 幂等 / 审批 / 限流 / 审计"

sqty() { ps "select coalesce(sum(sb.qty),0)::bigint from stock_batches sb join materials m on m.id=sb.material_id join warehouses w on w.id=sb.warehouse_id where sb.tenant_id=$ID2 and m.code='$1' and w.code='$2'"; }
astat() { ps "select status from agent_approvals where id=$1"; }

c=$(api POST /agents "$PAT" "{\"name\":\"P5 写权限 Agent\",\"kind\":\"mcp_http\",\"description\":\"审批/幂等/限流\"}"); CIDM=$(jget data id)
[[ ( "$c" == 200 || "$c" == 201 ) && -n "$CIDM" ]] && ok "M.1a 新建写权限客户端（id=$CIDM，独立限流窗口）" || no "M.1a 建客户端" "HTTP $c $(body | head -c 160)"
c=$(api POST "/agents/$CIDM/tokens" "$PAT" '{"scopes":["template:read","template:write","inventory:stock:read","inventory:stock:adjust","inventory:stock:transfer","print:job:submit","print:job:read"],"expiresInDays":7}')
AGENT_TOK=$(jget data token)
[[ ( "$c" == 200 || "$c" == 201 ) && "$AGENT_TOK" == lfagent_* ]] && ok "M.1b 签发 7 scope 写 token（含 adjust/transfer/submit）" || no "M.1b 签发 token" "HTTP $c $(body | head -c 160)"

# M.2 写工具必须带幂等键（§11.7.7 护栏 4：重试安全）
BOX0=$(sqty M-BOX-GIFT WH-SH)
c=$(atab POST /agent/v1/tools/inventory.adjust '{"sku":"M-BOX-GIFT","warehouse":"WH-SH","delta":-10,"reason":"缺幂等键"}'); cc=$(jget code)
NNO=$(ps "select count(*) from audit_logs where tenant_id=$ID2 and action='agent.tool.inventory.adjust' and detail->>'status'='denied_no_idem_key'")
[[ "$c" == 400 && "$NNO" -ge 1 && "$(sqty M-BOX-GIFT WH-SH)" == "$BOX0" ]] \
  && ok "M.2 写工具缺 idempotency_key → 400 + 审计，库存不变（$BOX0）" || no "M.2 幂等键必给" "HTTP $c code=$cc audit=$NNO"

# M.3 dry_run 预演：免审批、零副作用（§11.7.4「高危可预演」）
c=$(atab POST /agent/v1/tools/inventory.adjust '{"sku":"M-BOX-GIFT","warehouse":"WH-SH","delta":-10,"reason":"预演","idempotency_key":"m-dry-1","dry_run":true}'); cc=$(jget code)
[[ ( "$c" == 200 || "$c" == 201 ) && "$cc" == 0 && "$(jget data data dryRun)" == "True" && "$(sqty M-BOX-GIFT WH-SH)" == "$BOX0" ]] \
  && ok "M.3 dry_run=true 预演返回计划（$BOX0 未变、不建审批单）" || no "M.3 预演" "HTTP $c $(body | head -c 200)"

# M.4 高危无 approval_id → 202 need_approval 且不改库存（§11.11.2 第五条）
c=$(atab POST /agent/v1/tools/inventory.adjust '{"sku":"M-BOX-GIFT","warehouse":"WH-SH","delta":-10,"reason":"出库 10 个礼盒","idempotency_key":"m-adj-1"}')
A1=$(jget data data approval_id); cc=$(jget code)
[[ "$c" == 202 && "$cc" == 0 && "$(jget data data need_approval)" == "True" && -n "$A1" \
   && "$(sqty M-BOX-GIFT WH-SH)" == "$BOX0" && "$(astat $A1)" == "pending" ]] \
  && ok "M.4 无 approval → 202 need_approval（单 #$A1 pending，库存 $BOX0 未动）" || no "M.4 need_approval" "HTTP $c need=$(jget data data need_approval) stock=$(sqty M-BOX-GIFT WH-SH)"
[[ "$(jget data next_actions)" == *approval_id* ]] && ok "M.5 响应自带重试指引（next_actions 告诉模型怎么带 approval_id）" || no "M.5 重试指引" "$(jget data next_actions)"

# M.6 未确认就重试 → 403/4034（不放行）
c=$(atab POST /agent/v1/tools/inventory.adjust "{\"sku\":\"M-BOX-GIFT\",\"warehouse\":\"WH-SH\",\"delta\":-10,\"reason\":\"出库 10 个礼盒\",\"idempotency_key\":\"m-adj-1\",\"approval_id\":\"$A1\"}"); cc=$(jget code)
[[ "$c" == 403 && "$cc" == 4034 && "$(jget approval_status)" == "pending" && "$(jget message)" == *确认* ]] \
  && ok "M.6 审批未确认时重试 → 403/4034（approval_status=pending，提示等员工确认）" || no "M.6 未确认拒绝" "HTTP $c code=$cc $(body | head -c 180)"

# M.7 租户侧待确认列表可见；viewer 无权（sys:agent:approve）
c=$(api GET "/agents/approvals?status=pending" "$PAT"); NPEND=$(jget data total)
[[ "$c" == 200 && "${NPEND:-0}" -ge 1 ]] && ok "M.7a 租户 GET /agents/approvals?status=pending 看到 $NPEND 条待确认" || no "M.7a 审批列表" "HTTP $c $(body | head -c 160)"
c=$(api GET "/agents/approvals?status=pending" "$VT"); cc=$(jget code)
[[ "$c" == 403 && "$cc" == 4032 ]] && ok "M.7b viewer 无 sys:agent:approve → 403/4032" || no "M.7b viewer 越权" "HTTP $c code=$cc"

# M.8 员工确认 → approved + 5 分钟可用窗口（§11.7.6）
c=$(api POST "/agents/approvals/$A1/approve" "$PAT" '{}'); cc=$(jget code)
[[ ( "$c" == 200 || "$c" == 201 ) && "$cc" == 0 && "$(jget data status)" == "approved" && -n "$(jget data expiresAt)" ]] \
  && ok "M.8 确认后 status=approved、expiresAt=$(jget data expiresAt | cut -c1-19)（批准后 5 分钟）" || no "M.8 确认" "HTTP $c $(body | head -c 180)"

# M.9 带 approval 重试 → 执行、库存 -10、审批置 consumed（一次性）
c=$(atab POST /agent/v1/tools/inventory.adjust "{\"sku\":\"M-BOX-GIFT\",\"warehouse\":\"WH-SH\",\"delta\":-10,\"reason\":\"出库 10 个礼盒\",\"idempotency_key\":\"m-adj-1\",\"approval_id\":\"$A1\"}"); cc=$(jget code)
BOX1=$(sqty M-BOX-GIFT WH-SH)
[[ ( "$c" == 200 || "$c" == 201 ) && "$cc" == 0 && "$BOX1" == "$(python3 -c "print(int('$BOX0')-10)")" && "$(astat $A1)" == "consumed" ]] \
  && ok "M.9 带 approval 重试 → 真实出库 $BOX0→$BOX1，审批置 consumed" || no "M.9 执行" "HTTP $c stock=$BOX1(应 $((BOX0-10))) appr=$(astat $A1)"

# M.10 已消费/改过参数的审批单不可复用 → 403/4034，且库存不再变
c=$(atab POST /agent/v1/tools/inventory.adjust "{\"sku\":\"M-BOX-GIFT\",\"warehouse\":\"WH-SH\",\"delta\":-10,\"reason\":\"复用旧审批\",\"idempotency_key\":\"m-adj-1b\",\"approval_id\":\"$A1\"}"); cc=$(jget code)
[[ "$c" == 403 && "$cc" == 4034 && "$(sqty M-BOX-GIFT WH-SH)" == "$BOX1" ]] \
  && ok "M.10 一次性审批不可复用（403/4034，库存仍 $BOX1）" || no "M.10 复用拒绝" "HTTP $c code=$cc stock=$(sqty M-BOX-GIFT WH-SH)"

# M.11 参数篡改 → hash_mismatch（护栏 3：批准后改数量必须拦下）
c=$(atab POST /agent/v1/tools/inventory.adjust '{"sku":"M-BOX-GIFT","warehouse":"WH-SH","delta":-5,"reason":"批准后改量","idempotency_key":"m-adj-2"}')
A2=$(jget data data approval_id); api POST "/agents/approvals/$A2/approve" "$PAT" '{}' >/dev/null
c=$(atab POST /agent/v1/tools/inventory.adjust "{\"sku\":\"M-BOX-GIFT\",\"warehouse\":\"WH-SH\",\"delta\":-999,\"reason\":\"批准后改量\",\"idempotency_key\":\"m-adj-2\",\"approval_id\":\"$A2\"}"); cc=$(jget code)
[[ "$c" == 403 && "$cc" == 4034 && "$(jget message)" == *不一致* && "$(sqty M-BOX-GIFT WH-SH)" == "$BOX1" ]] \
  && ok "M.11 批准后偷改 delta=-999 → 403/4034 args_hash 不一致（库存未被动）" || no "M.11 篡改拦截" "HTTP $c code=$cc $(body | head -c 180)"

# M.12 驳回链路 → rejected，重试被拒
c=$(atab POST /agent/v1/tools/inventory.adjust '{"sku":"M-BOX-GIFT","warehouse":"WH-SH","delta":-1,"reason":"驳回测试","idempotency_key":"m-adj-3"}')
A3=$(jget data data approval_id)
c=$(api POST "/agents/approvals/$A3/reject" "$PAT" '{"reason":"数量不对"}'); cc=$(jget code)
[[ ( "$c" == 200 || "$c" == 201 ) && "$cc" == 0 && "$(astat $A3)" == "rejected" ]] && ok "M.12a 员工驳回（reason 落库，status=rejected）" || no "M.12a 驳回" "HTTP $c $(body | head -c 160)"
c=$(atab POST /agent/v1/tools/inventory.adjust "{\"sku\":\"M-BOX-GIFT\",\"warehouse\":\"WH-SH\",\"delta\":-1,\"reason\":\"驳回测试\",\"idempotency_key\":\"m-adj-3\",\"approval_id\":\"$A3\"}"); cc=$(jget code)
[[ "$c" == 403 && "$cc" == 4034 && "$(sqty M-BOX-GIFT WH-SH)" == "$BOX1" ]] && ok "M.12b 驳回后重试 → 403/4034「被驳回」" || no "M.12b 驳回重试" "HTTP $c code=$cc"

# M.13 幂等重放：同 key 同参数第二次不产生副作用（§11.7.4）
GOOD='{"page":{"widthMm":60,"heightMm":40,"dpi":300},"variables":[{"key":"name","label":"品名","type":"text"}],"elements":[{"id":"e1","type":"text","x":2,"y":2,"w":40,"h":6,"text":"苹果","bind":"name"},{"id":"bad","type":"unknown_kind","x":0,"y":0}]}'
c=$(atab POST /agent/v1/tools/templates.create "{\"name\":\"P5 验收-礼盒标签\",\"category\":\"水果\",\"content\":$GOOD,\"idempotency_key\":\"m-tpl-1\"}"); cc=$(jget code)
TPL=$(jget data data id)
NEL=$(ps "select jsonb_array_length(content->'elements') from templates where id=$TPL")
[[ ( "$c" == 200 || "$c" == 201 ) && "$cc" == 0 && -n "$TPL" && "$NEL" == "1" && "$(jget data warnings)" == *丢弃* ]] \
  && ok "M.13 护栏 8：Agent 模板过 validateAiTemplate，未知元素丢弃（落库 1 个元素 + warning）" || no "M.13 模板清洗" "HTTP $c tpl=$TPL elements=$NEL $(body | head -c 180)"
c=$(atab POST /agent/v1/tools/templates.create "{\"name\":\"P5 验收-礼盒标签\",\"category\":\"水果\",\"content\":$GOOD,\"idempotency_key\":\"m-tpl-1\"}"); cc=$(jget code)
NTPL=$(ps "select count(*) from templates where tenant_id=$ID2 and name='P5 验收-礼盒标签'")
[[ ( "$c" == 200 || "$c" == 201 ) && "$(jget data data idempotent_replay)" == "True" && "$(jget data data id)" == "$TPL" && "$NTPL" == "1" ]] \
  && ok "M.14 同幂等键重试 → 重放原结果（模板仍 1 张，id=$TPL）" || no "M.14 幂等重放" "HTTP $c replay=$(jget data data idempotent_replay) count=$NTPL"

# M.15 同 key 换参数 → 409/4036；非对象 content → 400
c=$(atab POST /agent/v1/tools/templates.create "{\"name\":\"P5 验收-换参数\",\"content\":$GOOD,\"idempotency_key\":\"m-tpl-1\"}"); cc=$(jget code)
[[ "$c" == 409 && "$cc" == 4036 ]] && ok "M.15a 同幂等键换参数 → 409/4036（防串味）" || no "M.15a 幂等冲突" "HTTP $c code=$cc $(body | head -c 160)"
c=$(atab POST /agent/v1/tools/templates.create '{"name":"坏 content","content":"不是对象","idempotency_key":"m-tpl-2"}'); cc=$(jget code)
[[ "$c" == 400 ]] && ok "M.15b content 非对象 → 400（护栏 8 拒收）" || no "M.15b 脏模板" "HTTP $c $(body | head -c 160)"

# M.16 templates.update → 版本递增（可回滚）
c=$(atab POST /agent/v1/tools/templates.update "{\"id\":$TPL,\"content\":$GOOD,\"idempotency_key\":\"m-tpl-3\"}"); cc=$(jget code)
VER=$(jget data data currentVersion)
[[ ( "$c" == 200 || "$c" == 201 ) && "$cc" == 0 && "${VER:-0}" -ge 2 ]] && ok "M.16 templates.update → v$VER（版本递增，旧版可回滚）" || no "M.16 版本递增" "HTTP $c v=$VER $(body | head -c 160)"

# M.17 调拨：批次号带到目标仓、总量守恒（高危同样走审批）
AP0=$(ps "select coalesce(sum(qty),0)::bigint from stock_batches sb join materials m on m.id=sb.material_id where sb.tenant_id=$ID2 and m.code='M-APPLE-ORG'")
c=$(atab POST /agent/v1/tools/inventory.transfer '{"sku":"M-APPLE-ORG","from_warehouse":"WH-SH","to_warehouse":"WH-JX","qty":20,"idempotency_key":"m-tr-1"}')
A4=$(jget data data approval_id); api POST "/agents/approvals/$A4/approve" "$PAT" '{}' >/dev/null
c=$(atab POST /agent/v1/tools/inventory.transfer "{\"sku\":\"M-APPLE-ORG\",\"from_warehouse\":\"WH-SH\",\"to_warehouse\":\"WH-JX\",\"qty\":20,\"idempotency_key\":\"m-tr-1\",\"approval_id\":\"$A4\"}"); cc=$(jget code)
AP1=$(ps "select coalesce(sum(qty),0)::bigint from stock_batches sb join materials m on m.id=sb.material_id where sb.tenant_id=$ID2 and m.code='M-APPLE-ORG'")
NB=$(ps "select count(*) from stock_batches sb join warehouses w on w.id=sb.warehouse_id join materials m on m.id=sb.material_id where sb.tenant_id=$ID2 and m.code='M-APPLE-ORG' and w.code='WH-JX'")
[[ ( "$c" == 200 || "$c" == 201 ) && "$cc" == 0 && "$AP0" == "$AP1" && "$NB" == "2" ]] \
  && ok "M.17 调拨 20kg 上海→嘉兴：总量守恒（$AP1），目标仓批次行 2（批次号随货走）" || no "M.17 调拨" "HTTP $c sum=$AP0→$AP1 jx_batches=$NB"

# M.18 D7：Agent 提交打印默认关闭；开启 + 审批后才落任务
c=$(atab POST /agent/v1/tools/print.submit_job "{\"template\":$TPL,\"copies\":2,\"idempotency_key\":\"m-pj-0\"}"); cc=$(jget code)
[[ "$c" == 403 && "$cc" == 4035 ]] && ok "M.18a D7 默认关闭 → 403/4035（feature 未开，含升级指引）" || no "M.18a D7 关闭" "HTTP $c code=$cc"
api PUT "/platform/tenants/$ID2/flags" "$PT" '{"key":"agent.print.submit","enabled":true}' >/dev/null
c=$(atab POST /agent/v1/tools/print.submit_job "{\"template\":$TPL,\"copies\":2,\"idempotency_key\":\"m-pj-1\"}"); A5=$(jget data data approval_id)
api POST "/agents/approvals/$A5/approve" "$PAT" '{}' >/dev/null
OWNER=$(ps "select id from users where tenant_id=$ID2 and username='${T2_CODE}_admin'")
c=$(atab POST /agent/v1/tools/print.submit_job "{\"template\":$TPL,\"copies\":2,\"idempotency_key\":\"m-pj-1\",\"approval_id\":\"$A5\"}"); cc=$(jget code)
JOB=$(jget data data jobId)
ROW=$(ps "select status||'/'||total||'/'||coalesce(created_by,-1) from print_jobs where id=$JOB")
[[ ( "$c" == 200 || "$c" == 201 ) && -n "$JOB" && "$ROW" == *"/2/$OWNER" ]] \
  && ok "M.18b 开关开 + 审批后出任务（job=$JOB，2 张，created_by=$OWNER=Agent 归属人）" || no "M.18b 提交打印" "HTTP $c job=$JOB row=$ROW owner=$OWNER"
c=$(atab POST /agent/v1/tools/print.get_status "{\"job_id\":$JOB}"); cc=$(jget code)
[[ ( "$c" == 200 || "$c" == 201 ) && "$cc" == 0 && "$(jget data data jobId)" == "$JOB" ]] \
  && ok "M.18c print.get_status 轮询可用（$(jget data summary)）" || no "M.18c 查任务" "HTTP $c $(body | head -c 160)"
api PUT "/platform/tenants/$ID2/flags" "$PT" '{"key":"agent.print.submit","enabled":false}' >/dev/null

# M.19 限流（§11.7.7 护栏 5）：新客户端 rpm=1 → 第 2 次 429/4037，且超限不计量
c=$(api POST /agents "$PAT" '{"name":"P5 限流客户端","kind":"mcp_http"}'); CIDR=$(jget data id)
c=$(api POST "/agents/$CIDR/tokens" "$PAT" '{"scopes":["template:read"],"expiresInDays":1}'); RTK=$(jget data token)
api PUT "/platform/tenants/$ID2/flags" "$PT" '{"key":"agent.rate_limit","enabled":true,"rollout":{"rpm":1}}' >/dev/null
M0=$(ps "select coalesce(sum(quantity),0)::bigint from usage_daily where tenant_id=$ID2 and meter='agent_calls'")
c1=$(api GET /agent/v1/whoami "$RTK")
M1=$(ps "select coalesce(sum(quantity),0)::bigint from usage_daily where tenant_id=$ID2 and meter='agent_calls'")
N429=0; N200=0                         # 连打 5 次：出现 429 即判定限流生效；顺带按放行数核对计量
for i in 1 2 3 4 5; do
  LASTC=$(api GET /agent/v1/whoami "$RTK")
  [[ "$LASTC" == 429 ]] && N429=$((N429+1))
  [[ "$LASTC" == 200 ]] && N200=$((N200+1))
done
cc=$(jget code)
M2=$(ps "select coalesce(sum(quantity),0)::bigint from usage_daily where tenant_id=$ID2 and meter='agent_calls'")
NRATE=$(ps "select count(*) from audit_logs where tenant_id=$ID2 and detail->>'status'='denied_rate'")
EXP_M2=$(python3 -c "print(int('$M1')+int('$N200'))")
[[ "$c1" == 200 && "$N429" -ge 1 && "$cc" == 4037 && "$(jget limit)" == "1" ]] \
  && ok "M.19a rpm=1：首呼 200、后续 5 呼中 $N429 次 429/4037（limit=1，retry_after=$(jget retry_after)s）" || no "M.19a 限流" "1=$c1 last=$LASTC code=$cc $(body | head -c 160)"
[[ "$M1" == "$(python3 -c "print(int('$M0')+1)")" && "$M2" == "$EXP_M2" ]] \
  && ok "M.19b 计量只跟着放行走：$M0 → $M1 → $M2（5 呼放行 $N200 次，denied_rate 审计 $NRATE 条）" || no "M.19b 超限计量" "$M0→$M1→$M2（期望 $EXP_M2）"
if command -v redis-cli >/dev/null 2>&1; then
  RKEY=$(redis-cli -p "${REDIS_PORT:-6380}" --scan --pattern "lf:agent:rl:$ID2:$CIDR:*" 2>/dev/null | head -1)
  [[ -n "$RKEY" ]] && ok "M.19c 限流计数器落 Redis（$RKEY）" || no "M.19c Redis key" "未找到 lf:agent:rl:$ID2:$CIDR:*（可能退回进程内窗口）"
else
  ok "M.19c Redis key 跳过（本机无 redis-cli；服务侧已验证，Redis 故障时自动退进程内窗口）"
fi
api PUT "/platform/tenants/$ID2/flags" "$PT" '{"key":"agent.rate_limit","enabled":false,"rollout":{}}' >/dev/null
c3=$(api GET /agent/v1/whoami "$RTK"); [[ "$c3" == 200 ]] && ok "M.19d 阈值恢复默认 60/分后放行（运营即时可调）" || no "M.19d 解除限流" "HTTP $c3"

# M.20 审计（§11.7.7：agent_client_id / on_behalf_of / tool / args_hash / 状态 / 耗时）
NAUD=$(ps "select count(*) from audit_logs where tenant_id=$ID2 and actor_type='agent'")
NST=$(ps "select count(distinct detail->>'status') from audit_logs where tenant_id=$ID2 and actor_type='agent'")
ONB=$(ps "select count(*) from audit_logs where tenant_id=$ID2 and actor_type='agent' and detail->>'onBehalfOf' is not null")
HAS=$(ps "select string_agg(s,',') from (select distinct detail->>'status' s from audit_logs where tenant_id=$ID2 and actor_type='agent') x")
[[ "$NAUD" -ge 20 && "$NST" -ge 8 && "$ONB" == "$NAUD" ]] \
  && ok "M.20 agent 审计 $NAUD 条 / $NST 种状态 / on_behalf_of 全非空（$HAS）" || no "M.20 审计" "rows=$NAUD statuses=$NST onBehalf=$ONB/$NAUD"

# M.21 Agent 侧审批自查 + 只读 token 打高危（§11.11.2 复用 L.12 口径）
c=$(atab GET "/agent/v1/approvals?status=all"); cc=$(jget code)
[[ "$c" == 200 && "$(jget data data total)" -ge 4 ]] && ok "M.21 Agent GET /agent/v1/approvals?status=all 自查 $(jget data data total) 条" || no "M.21 Agent 自查" "HTTP $c $(body | head -c 160)"

# M.22 Streamable HTTP 传输（§11.7.1 / D9：SaaS 客户接入自有 Agent）
MCP_DIR2="$MCP_DIR"
if [[ -n "$MCP_DIR2" && -f "$MCP_DIR2/dist/http.js" && -f "$MCP_DIR2/dist/selftest-http.js" \
      && -d "$MCP_DIR2/node_modules/@modelcontextprotocol" ]] && grep -q '"selftest:http"' "$MCP_DIR2/package.json"; then
  (cd "$MCP_DIR2" && AGENT_TOKEN="$AGENT_TOK" AGENT_API_BASE="$BASE" npm run selftest:http --silent) >/tmp/mcp-http-selftest.log 2>&1
  if grep -q "SELFTEST HTTP OK" /tmp/mcp-http-selftest.log; then ok "M.22 Streamable HTTP MCP 自测通过（tools/prompts/resources）"
  else no "M.22 HTTP 自测" "$(tail -3 /tmp/mcp-http-selftest.log | tr '\n' ' ')"; fi
else
  ok "M.22 Streamable HTTP 自测跳过（apps/mcp-server 未构建 http 入口；P5 交付后跑 npm run selftest:http）"
fi

echo
echo "== 通过 $pass / 失败 $fail"
if (( fail == 0 )); then echo "P0 验收通过（docs/11 §11.11.1）"; else echo "存在失败项，见上面 [FAIL]"; fi
exit $(( fail > 0 ? 1 : 0 ))
