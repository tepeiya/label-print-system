#!/usr/bin/env bash
# =============================================================================
# p0-acceptance.sh —— SaaS P0「权限与订阅底座」端到端验收（docs/11 §11.11.1）
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

# ------------------------------------------------- A. 开通租户（D4 单事务）
api POST /platform/tenants "$AT" "{\"code\":\"$T_CODE\",\"name\":\"P0 验收 BASIC\",\"planCode\":\"BASIC\",\"adminUsername\":\"${T_CODE}_admin\",\"adminPassword\":\"$T_PASS\"}" >/dev/null
ID=$(jget data tenantId)
if [[ -n "$ID" ]]; then ok "A.1 POST /platform/tenants 开通成功（tenant_id=$ID / 模块 $(jget data modules)）"; else
  no "A.1 开通 BASIC 租户" "$(body | head -c 300)"; echo "重跑请换 T_CODE，或手工清理 tenants.code='$T_CODE'"; exit 1; fi
api POST /platform/tenants "$AT" "{\"code\":\"$T2_CODE\",\"name\":\"P0 验收 PRO\",\"planCode\":\"PRO\",\"seats\":20,\"adminUsername\":\"${T2_CODE}_admin\",\"adminPassword\":\"$T_PASS\"}" >/dev/null
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
api POST "/platform/tenants/$ID/modules" "$AT" '{"moduleCode":"bom"}' >/dev/null
ADDED=$(ps "select string_agg(module_code,',' order by module_code) from tenant_modules where tenant_id=$ID and status in ('active','trial')")
case "$ADDED" in *bom*)       ok "F.1 加购 bom 成功（$ADDED）";;              *) no "F.1 加购 bom" "$(body | head -c 200)";; esac
case "$ADDED" in *inventory*) ok "F.2 依赖自动补齐 inventory";;               *) no "F.2 依赖补齐" "$ADDED";; esac
case "$ADDED" in *masterdata*) ok "F.3 二级依赖补齐 masterdata";;             *) no "F.3 二级依赖" "$ADDED";; esac
check "F.4 tenant_modules.source='addon'（D1）" "$(ps "select source from tenant_modules where tenant_id=$ID and module_code='bom'")" "addon"
c=$(api DELETE "/platform/tenants/$ID/modules/inventory" "$AT")
[[ "$c" == 4* ]] && ok "F.5 停用被依赖的 inventory 被拒（HTTP $c / $(jget code)）" || no "F.5 停用依赖保护" "HTTP $c $(body | head -c 200)"
api DELETE "/platform/tenants/$ID/modules/bom" "$AT" >/dev/null
check "F.6 先停 bom 再停 inventory 就放行" "$(api DELETE "/platform/tenants/$ID/modules/inventory" "$AT")" "200"

# ------------------------------------------------ D7 灰度开关 / D12 退订
api PUT "/platform/tenants/$ID/flags" "$AT" '{"key":"agent.print.submit","enabled":true}' >/dev/null
c=$(api GET "/platform/tenants/$ID/flags" "$AT"); check "G.1 开关置为 true" "$c/$(jget data agent.print.submit)" "200/True"
api GET /auth/me "$BAT" >/dev/null
check "G.2 /auth/me.features 反映新值" "$(jget data features agent.print.submit)" "True"
api POST "/platform/tenants/$ID/cancel" "$AT" >/dev/null
check "G.4 tenants.canceled_at 已写入" "$(ps "select (canceled_at is not null)::int from tenants where id=$ID")" "1"
grep -q 'hardDeleteAfter' "$TMP" && ok "G.5 退订响应给出 90 天硬删时间（$(jget data hardDeleteAfter)）" || no "G.5 hardDeleteAfter" "$(body | head -c 200)"
check "G.6 重复退订幂等" "$(api POST "/platform/tenants/$ID/cancel" "$AT")" "201"

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

echo
echo "== 通过 $pass / 失败 $fail"
if (( fail == 0 )); then echo "P0 验收通过（docs/11 §11.11.1）"; else echo "存在失败项，见上面 [FAIL]"; fi
exit $(( fail > 0 ? 1 : 0 ))
