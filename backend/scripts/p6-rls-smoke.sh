#!/usr/bin/env bash
# =============================================================================
# p6-rls-smoke.sh —— P6 RLS 兜底冒烟（docs/11 §11.2 / D3；docs/10 §10.22.3）
#
# 证明一件事：**用非 owner、非超管、无 BYPASSRLS 的 labelflow_app 角色连库时，
# 即使 SQL 里漏写 tenant_id 条件，也读不到、写不进别家租户的数据。**
# 主链路目前仍以 owner 角色连库（owner 默认绕过 RLS），所以这里断言的是「兜底闸门本身有效」，
# 不代表主链路已切到该角色 —— 切换条件见 docs/10 §10.22.4。
#
# 前提：已执行 backend/scripts/saas_p6_rls.sql（角色 + 策略）。
# 用法：
#   bash backend/scripts/p6-rls-smoke.sh
#   PSQL="psql -h h -p p -U labelflow -d labelflow" \
#   APP_DSN="postgresql://labelflow_app:labelflow_app@127.0.0.1:5433/labelflow" bash ...
#
# 只读为主，唯一写入是一条自造自删的 materials 探针行（编号 RLS-SMOKE-<时间戳>，跑完即删）。
# =============================================================================
set -uo pipefail

PSQL="${PSQL:-psql -h 127.0.0.1 -p 5433 -U labelflow -d labelflow -tA -F'|'}"
export PGPASSWORD="${PGPASSWORD:-labelflow}"
APP_DSN="${APP_DSN:-postgresql://labelflow_app:labelflow_app@127.0.0.1:5433/labelflow}"
PLAT_DSN="${PLAT_DSN:-postgresql://labelflow_platform:labelflow_platform@127.0.0.1:5433/labelflow}"

pass=0; fail=0; skip=0
ok()   { pass=$((pass+1)); printf '  [OK]   %s\n' "$1"; }
no()   { fail=$((fail+1)); printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; }
sk()   { skip=$((skip+1)); printf '  [SKIP] %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1" "期望「$3」实际「$2」"; fi; }

own()  { $PSQL -c "$1" 2>&1; }                                  # owner 视角（绕过 RLS）
# appq <tenant|''> <sql> —— 同一条会话里先打 GUC 再查（''=故意不打，验 fail-closed）
appq() { local t=$1 s=$2
  if [[ -n $t ]]; then
    psql "$APP_DSN" -tA -c "SELECT set_config('app.tenant_id','$t',false)" -c "$s" 2>&1 | tail -1
  else
    psql "$APP_DSN" -tA -c "$s" 2>&1 | tail -1
  fi
}
apperr() { psql "$APP_DSN" -tA -c "$1" 2>&1; }                 # 需要看错误原文时用
# appw <tenant> <sql> —— 带 GUC 执行写语句，保留全部输出（含报错原文）
appw()  { local t=$1 s=$2
  psql "$APP_DSN" -tA -c "SELECT set_config('app.tenant_id','$t',false)" -c "$s" 2>&1
}
platq()  { psql "$PLAT_DSN" -tA -c "$1" 2>&1 | tail -1; }

# --- 前置：角色与数据是否就位 -------------------------------------------------
if ! echo "$(apperr 'SELECT 1')" | grep -q '^1$'; then
  echo "无法用 labelflow_app 登录（先跑 backend/scripts/saas_p6_rls.sql）：$(apperr 'SELECT 1')"
  exit 2
fi
# TA 优先挑「既有模板又有库存批次」的租户，这样 N.10（本租户批次可见性）不会因数据稀疏跳过；
# 找不到就退回「只要有模板」，N.10 自己会记 SKIP。
TA=$(own "select t.tenant_id from (select tenant_id, count(*) c from templates group by 1 having count(*)>0) t join (select tenant_id, count(*) c from stock_batches group by 1 having count(*)>0) s using (tenant_id) order by t.c desc, s.c desc limit 1")
[[ -z "$TA" ]] && TA=$(own "select tenant_id from templates group by tenant_id having count(*)>0 order by count(*) desc limit 1")
TB=$(own "select tenant_id from templates where tenant_id <> ${TA:-0} group by tenant_id having count(*)>0 order by count(*) limit 1")
[[ -z $TA || -z $TB ]] && { echo "库里要有 ≥2 个带模板的租户才能验隔离（当前 TA=$TA TB=$TB）"; exit 2; }
CA=$(own "select count(*) from templates where tenant_id=$TA")
CB=$(own "select count(*) from templates where tenant_id=$TB")
CT=$(own "select count(*) from templates")
echo "RLS 冒烟：租户 A=$TA（$CA 张模板）、租户 B=$TB（$CB 张）、全库 $CT 张"
echo

# --- 1. 策略覆盖度 ------------------------------------------------------------
NTID=$(own "select count(distinct table_name) from information_schema.columns where table_schema='public' and column_name='tenant_id'")
NPOL=$(own "select count(distinct tablename) from pg_policies where schemaname='public' and policyname='tenant_isolation'")
NENAB=$(own "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and exists (select 1 from information_schema.columns k where k.table_name=c.relname and k.column_name='tenant_id')")
BYPASS_APP=$(own "select rolbypassrls from pg_roles where rolname='labelflow_app'")
BYPASS_PLAT=$(own "select rolbypassrls from pg_roles where rolname='labelflow_platform'")
check "N.1 每张带 tenant_id 的表都有 tenant_isolation 策略（+bom_items 走父表）" "$NPOL" "$((NTID + 1))"
check "N.2 带 tenant_id 的表全部 ENABLE ROW LEVEL SECURITY" "$NENAB" "$NTID"
check "N.3 labelflow_app 没有 BYPASSRLS（防线没被抹平）" "$BYPASS_APP" "f"
check "N.4 labelflow_platform 有 BYPASSRLS（平台跨租户运维走它）" "$BYPASS_PLAT" "t"

# --- 2. 读：漏写 where 也只见本租户 -------------------------------------------
check "N.5 不带 GUC 时一行都读不到（fail-closed，不是退回全表）" "$(appq '' 'select count(*) from templates')" "0"
check "N.6 带 GUC=A 读到的行数 = owner 视角 A 的行数" "$(appq "$TA" 'select count(*) from templates')" "$CA"
check "N.7 带 GUC=A、SQL 里完全不写 tenant_id 条件 → 仍然 0 行别家数据" \
      "$(appq "$TA" "select count(*) from templates where tenant_id <> $TA")" "0"
check "N.8 换 GUC=B 就读到 B 的行数（闸门跟着会话变量走）" "$(appq "$TB" 'select count(*) from templates')" "$CB"
check "N.9 JOIN 也不会漏（materials join stock_batches，跨租户应为 0）" \
      "$(appq "$TA" 'select count(*) from materials m join stock_batches sb on sb.material_id=m.id where sb.tenant_id <> m.tenant_id')" "0"
# GUC=A 时本租户自己的 stock_batches 可见性：拿 A 的真实批次数对照
SBA=$(own "select count(*) from stock_batches where tenant_id=$TA")
if [[ "$SBA" == "0" ]]; then sk "N.10 本租户 stock_batches 可见性" "租户 $TA 没有批次数据";
else check "N.10 带 GUC=A 时本租户批次全部可见（不是把自己也滤掉了）" "$(appq "$TA" 'select count(*) from stock_batches')" "$SBA"; fi

# --- 3. 子表策略：bom_items 没有 tenant_id，靠父表 boms -----------------------
TBI=$(own "select b.tenant_id from boms b join bom_items bi on bi.bom_id=b.id group by 1 having count(*)>0 order by count(*) desc limit 1")
if [[ -z $TBI ]]; then sk "N.11 bom_items 父表策略" "库里没有 bom_items 数据";
else
  CBI=$(own "select count(*) from bom_items bi join boms b on b.id=bi.bom_id where b.tenant_id=$TBI")
  check "N.11 带 GUC=TBI → bom_items 行数 = owner 视角该租户数" "$(appq "$TBI" 'select count(*) from bom_items')" "$CBI"
  # 子查询读 boms 同样受策略约束，所以「跨租户拼一把」的结果必然是 0
  check "N.12 带 GUC=TBI 时 join 父表也拿不到别家 bom_items" \
        "$(appq "$TBI" "select count(*) from bom_items bi join boms b on b.id=bi.bom_id where b.tenant_id <> $TBI")" "0"
fi

# --- 4. 写：WITH CHECK 拦下别人的 tenant_id ----------------------------------
PROBE_CODE="RLS-SMOKE-$(date +%s)"
INS_OTHER=$(appw "$TA" "insert into materials(tenant_id, code, name) values ($TB, '$PROBE_CODE', 'rls-probe')")
if echo "$INS_OTHER" | grep -qiE 'row-level security|42501'; then ok "N.13 GUC=A 时插入 tenant_id=B 被 WITH CHECK 拒绝";
else no "N.13 GUC=A 时插入 tenant_id=B 应被拒绝" "实际输出：$INS_OTHER"; fi

INS_NULL=$(appw "$TA" "insert into materials(tenant_id, code, name) values (null, '$PROBE_CODE', 'rls-probe')")
if echo "$INS_NULL" | grep -qiE 'row-level security|42501|not-null'; then ok "N.14 插入 tenant_id=null 被拒（不能造无主数据）";
else no "N.14 插入 tenant_id=null 应被拒" "实际输出：$INS_NULL"; fi

INS_OK=$(appw "$TA" "insert into materials(tenant_id, code, name) values ($TA, '$PROBE_CODE', 'rls-probe')")
if echo "$INS_OK" | grep -qi 'INSERT 0 1'; then
  ok "N.15 GUC=A 时插入本租户数据成功（策略没把合法写入也挡掉）"
  SEE=$(appq "$TB" "select count(*) from materials where code='$PROBE_CODE'")
  check "N.16 这条 A 的数据对租户 B 不可见" "$SEE" "0"
  OWN_SEE=$(appq "$TA" "select count(*) from materials where code='$PROBE_CODE'")
  check "N.17 对自己可见" "$OWN_SEE" "1"
  DEL=$(appw "$TA" "delete from materials where code='$PROBE_CODE'")
  if echo "$DEL" | grep -qi 'DELETE 1'; then ok "N.18 探针行已删除（清理成功）";
  else no "N.18 探针行删除失败，需手工清理" "$DEL"; fi
else
  no "N.15 GUC=A 时插入本租户数据应成功" "$INS_OK"
  sk "N.16/N.17/N.18 依赖 N.15 的探针行" "插入未成功"
fi

# --- 5. 越权面：授权而不是策略挡住的 ------------------------------------------
DENY_PU=$(apperr 'select count(*) from platform_users')
if echo "$DENY_PU" | grep -qi 'permission denied'; then ok "N.19 labelflow_app 读不到 platform_users（授权层拒绝，不是策略）";
else no "N.19 应拒绝读 platform_users" "实际：$DENY_PU"; fi

WR_TEN=$(apperr "insert into tenants(name, code) values ('rls', 'rlsx$(date +%s)')")
if echo "$WR_TEN" | grep -qi 'permission denied'; then ok "N.20 labelflow_app 对 tenants 只有 SELECT（写不了租户表）";
else no "N.20 应拒绝写 tenants" "实际：$WR_TEN"; fi

DDL=$(apperr 'drop table if exists materials')
if echo "$DDL" | grep -qi 'must be owner\|permission denied'; then ok "N.21 labelflow_app 无 DDL 权限（删不了表）";
else no "N.21 应拒绝 DDL" "实际：$DDL"; fi

# --- 6. 平台角色仍可跨租户 ----------------------------------------------------
PLAT=$(platq 'select count(*) from templates')
if [[ "$PLAT" == "$CT" ]]; then ok "N.22 labelflow_platform（BYPASSRLS）跨租户可见全量（$PLAT）";
else no "N.22 平台角色应看到全量" "期望 $CT 实际 $PLAT"; fi

echo
printf '结果：通过 %d / 失败 %d / 跳过 %d\n' "$pass" "$fail" "$skip"
[[ $fail -eq 0 ]] || exit 1
