#!/usr/bin/env bash
# WMS 集成测试库初始化：按依赖顺序灌入完整 schema + 基础种子 + WMS 迁移 + RLS。
# 用法：bash scripts/wms-test-db-bootstrap.sh [容器名] [端口]
#   PG_CONTAINER 默认 wms-it-pg，宿主端口仅用于提示（脚本走 docker exec，不依赖端口）
set -euo pipefail
PG_CONTAINER="${1:-wms-it-pg}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

echo "[bootstrap] 库: $PG_CONTAINER"
echo "[bootstrap] 清空 public schema"
docker exec -i "$PG_CONTAINER" psql -U labelflow -d labelflow -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA public CASCADE; CREATE SCHEMA public;
SQL

run() {
  local f="$1"
  if docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U labelflow -d labelflow -q < "$f" >/tmp/wms-boot.out 2>&1; then
    echo "  OK   $(basename "$f")"
  else
    echo "  FAIL $(basename "$f")"; grep -E 'ERROR|FATAL' /tmp/wms-boot.out | head -3; return 1
  fi
}

run "$REPO/docs/03-database.sql"
run "$REPO/backend/scripts/seed.sql"
run "$REPO/backend/scripts/saas_p0.sql"
run "$REPO/backend/scripts/saas_p0_roles.sql"
run "$REPO/backend/scripts/saas_p2_platform.sql"
run "$REPO/backend/scripts/saas_p3_billing.sql"
run "$REPO/backend/scripts/saas_p4_agent.sql"
run "$REPO/backend/scripts/saas_p6_rls.sql"   # 先建 RLS 角色，供后续 prompt_versions FK
for f in inventory_stock_moves.sql inventory_product_groups.sql inventory_masterdata.sql inventory_location_link.sql \
         inventory_bom.sql inventory_material_custom_fields.sql inventory_product_print.sql inventory_alert.sql; do
  run "$REPO/backend/scripts/$f"
done
run "$REPO/backend/scripts/saas_p5_agent_tools.sql"
run "$REPO/backend/scripts/saas_p6_branding.sql"
run "$REPO/backend/scripts/saas_p6_dedicated.sql"
run "$REPO/backend/scripts/saas_p6_prompts.sql"
run "$REPO/backend/scripts/saas_p6_prompt_versions.sql"
run "$REPO/backend/scripts/saas_p6_tenant_data.sql"
run "$REPO/backend/scripts/saas_p7_notifications.sql"
run "$REPO/backend/scripts/saas_p8_governance.sql"
run "$REPO/backend/scripts/saas_p8_hardware.sql"
run "$REPO/backend/scripts/saas_p8_triggers.sql"
run "$REPO/backend/scripts/wms_p1_inbound.sql"
run "$REPO/backend/scripts/saas_p6_rls.sql"   # WMS 表建好后重跑，确保 4 张表挂 tenant_isolation

echo "[bootstrap] 插入集成测试基础数据（租户A开通/租户B不开通）"
docker exec -i "$PG_CONTAINER" psql -U labelflow -d labelflow -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO tenants (id,name,code,status) VALUES (901,'租户A','wms_test_a',1),(902,'租户B','wms_test_b',1) ON CONFLICT (id) DO NOTHING;
INSERT INTO tenant_modules (tenant_id,module_code,status,source) VALUES (901,'wms.inbound','active','manual') ON CONFLICT (tenant_id,module_code) DO NOTHING;
INSERT INTO warehouses (id,tenant_id,code,name) VALUES (801,901,'WH-A','A仓'),(802,902,'WH-B','B仓') ON CONFLICT (id) DO NOTHING;
INSERT INTO warehouse_locations (id,tenant_id,warehouse_id,code,name,zone) VALUES
 (8011,901,801,'A-01','A库位01','FAST'),(8012,901,801,'A-02','A库位02','SLOW'),(8021,902,802,'B-01','B库位01','FAST') ON CONFLICT (id) DO NOTHING;
INSERT INTO materials (id,tenant_id,code,name,unit) VALUES
 (9011,901,'MAT-A001','轴承6204','PCS'),(9012,901,'MAT-A002','齿轮','PCS'),(9021,902,'MAT-B001','B司物料','PCS') ON CONFLICT (id) DO NOTHING;
INSERT INTO wms_putaway_rules (tenant_id,warehouse_id,priority,condition_json,action_json)
 VALUES (901,801,10,'{"abc":"A"}'::jsonb,'{"zoneCode":"FAST","sortBy":"DISTANCE"}'::jsonb);
SQL
echo "[bootstrap] 完成：4 张 WMS 表已挂 RLS，租户A(901)开通 wms.inbound，租户B(902)未开通"
