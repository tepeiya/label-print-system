-- =============================================================================
-- 产品 / 分组 / 仓库 / 库位 自动联动：默认存放位置
-- 解析优先级：请求指定 > 产品默认 > 分组默认 > 系统首个启用仓库（库位留空）
-- 依赖：inventory_product_groups.sql（product_groups）、saas_p4_agent.sql（warehouses 等）
-- 幂等，可重复执行。
-- =============================================================================

ALTER TABLE materials ADD COLUMN IF NOT EXISTS default_warehouse_id BIGINT REFERENCES warehouses(id);
ALTER TABLE materials ADD COLUMN IF NOT EXISTS default_location_id BIGINT REFERENCES warehouse_locations(id);
CREATE INDEX IF NOT EXISTS ix_materials_default_wh ON materials (tenant_id, default_warehouse_id);

ALTER TABLE product_groups ADD COLUMN IF NOT EXISTS default_warehouse_id BIGINT REFERENCES warehouses(id);
ALTER TABLE product_groups ADD COLUMN IF NOT EXISTS default_location_id BIGINT REFERENCES warehouse_locations(id);
