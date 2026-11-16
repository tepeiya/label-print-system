-- =============================================================================
-- 基础资料增强：仓库库位 + 库存批次的库位归属
-- 依赖：saas_p4_agent.sql（warehouses / materials / stock_batches）
--       inventory_stock_moves.sql（tenant_modules 加购口径）
-- 幂等，可重复执行。
-- =============================================================================

CREATE TABLE IF NOT EXISTS warehouse_locations (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    warehouse_id  BIGINT NOT NULL REFERENCES warehouses(id),
    code          VARCHAR(40) NOT NULL,
    name          VARCHAR(80) NOT NULL,
    zone          VARCHAR(40),
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, warehouse_id, code)
);
CREATE INDEX IF NOT EXISTS ix_wlocations_tenant ON warehouse_locations (tenant_id);
CREATE INDEX IF NOT EXISTS ix_wlocations_warehouse ON warehouse_locations (tenant_id, warehouse_id);

-- 批次可定位到具体库位；NULL = 未指定（兼容既有数据）
ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS location_id BIGINT REFERENCES warehouse_locations(id);
CREATE INDEX IF NOT EXISTS ix_stock_batches_location ON stock_batches (tenant_id, location_id);

-- 台账也记库位，保证「哪个库位收的货 / 从哪个库位出的」可追溯
ALTER TABLE stock_moves ADD COLUMN IF NOT EXISTS location_id BIGINT REFERENCES warehouse_locations(id);
CREATE INDEX IF NOT EXISTS ix_stock_moves_location ON stock_moves (tenant_id, location_id);

-- RLS：与其余带 tenant_id 的业务表同口径
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        ALTER TABLE public.warehouse_locations ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON public.warehouse_locations;
        CREATE POLICY tenant_isolation ON public.warehouse_locations
            AS PERMISSIVE FOR ALL TO labelflow_app
            USING  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
    END IF;
END
$$;

-- 本地开发租户开通 masterdata（inventory 的依赖模块，通常由依赖展开自动补；这里兜底）
INSERT INTO tenant_modules (tenant_id, module_code, status, source)
SELECT t.id, 'masterdata', 'active', 'addon'
FROM tenants t
WHERE t.code = 'default'
ON CONFLICT (tenant_id, module_code)
DO UPDATE SET status = 'active' WHERE tenant_modules.status <> 'active';
