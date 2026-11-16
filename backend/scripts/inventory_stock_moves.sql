-- =============================================================================
-- 出入库台账（WMS 第一阶段）：每笔库存变动按批次落一行，可追溯、可查询。
-- 依赖：saas_p4_agent.sql（warehouses / materials / stock_batches）
-- 幂等：可重复执行。建表后建议重跑 saas_p6_rls.sql，
--       其 information_schema 循环会自动给本表挂上 tenant_isolation 策略。
-- =============================================================================

CREATE TABLE IF NOT EXISTS stock_moves (
    id               BIGSERIAL PRIMARY KEY,
    tenant_id        BIGINT NOT NULL,
    move_no          VARCHAR(40) NOT NULL,
    kind             VARCHAR(10) NOT NULL CHECK (kind IN ('in', 'out', 'transfer')),
    material_id      BIGINT NOT NULL REFERENCES materials(id),
    warehouse_id     BIGINT NOT NULL REFERENCES warehouses(id),
    to_warehouse_id  BIGINT REFERENCES warehouses(id),
    batch_no         VARCHAR(60) NOT NULL,
    -- 带符号：入库/调入为正，出库/调出为负。与 StockMoveLine.change 同口径
    qty              NUMERIC(14,3) NOT NULL,
    before_qty       NUMERIC(14,3) NOT NULL DEFAULT 0,
    after_qty        NUMERIC(14,3) NOT NULL DEFAULT 0,
    reason           VARCHAR(200) NOT NULL,
    operator         VARCHAR(80) NOT NULL DEFAULT 'system',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 一次变动可能跨多个批次：单据号相同，靠仓库+批次区分行
    UNIQUE (tenant_id, move_no, kind, warehouse_id, batch_no)
);

CREATE INDEX IF NOT EXISTS ix_stock_moves_tenant_time ON stock_moves (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_stock_moves_material ON stock_moves (tenant_id, material_id);
CREATE INDEX IF NOT EXISTS ix_stock_moves_kind ON stock_moves (tenant_id, kind);

-- 防御纵深：存在 app 角色时立即挂 RLS；saas_p6_rls.sql 重跑会重建同一策略。
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        ALTER TABLE public.stock_moves ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON public.stock_moves;
        CREATE POLICY tenant_isolation ON public.stock_moves
            AS PERMISSIVE FOR ALL TO labelflow_app
            USING  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
    END IF;
END
$$;

-- 本地开发/演示租户开通 inventory 模块，否则菜单与路由守卫会拦住 /inventory。
-- 其它租户请走正常加购流程（tenant_modules.source='addon'），不要在迁移里批量开。
INSERT INTO tenant_modules (tenant_id, module_code, status, source)
SELECT t.id, 'inventory', 'active', 'addon'
FROM tenants t
WHERE t.code = 'default'
ON CONFLICT (tenant_id, module_code)
DO UPDATE SET status = 'active' WHERE tenant_modules.status <> 'active';
