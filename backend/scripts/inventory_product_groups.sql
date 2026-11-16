-- =============================================================================
-- 产品分组 + 入库自动打印开关
-- 分组独立于 category：同一产品只归一个分组，分组可标注 brand / supplier / custom。
-- 依赖：saas_p4_agent.sql（materials）、print.entity.ts（printers）
-- 幂等，可重复执行。
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_groups (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL,
    code        VARCHAR(40) NOT NULL,
    name        VARCHAR(120) NOT NULL,
    type        VARCHAR(20) NOT NULL DEFAULT 'custom'
                CHECK (type IN ('brand','supplier','custom')),
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS ix_product_groups_tenant ON product_groups (tenant_id, type);

ALTER TABLE materials ADD COLUMN IF NOT EXISTS group_id BIGINT REFERENCES product_groups(id);
CREATE INDEX IF NOT EXISTS ix_materials_group ON materials (tenant_id, group_id);

-- 入库自动打印：仅 auto_print=true 且绑定了模板的产品触发；printer_id 为空时用默认打印机
ALTER TABLE materials ADD COLUMN IF NOT EXISTS auto_print BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS printer_id BIGINT REFERENCES printers(id);

-- RLS：与其余带 tenant_id 的业务表同口径
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        ALTER TABLE public.product_groups ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON public.product_groups;
        CREATE POLICY tenant_isolation ON public.product_groups
            AS PERMISSIVE FOR ALL TO labelflow_app
            USING  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
    END IF;
END
$$;
