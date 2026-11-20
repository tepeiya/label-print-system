-- =============================================================================
-- 基础资料-产品自定义字段
-- 字段定义（租户级）存 material_field_definitions；产品上的值存 materials.custom_fields (JSONB)。
-- 依赖：saas_p4_agent.sql（materials）。幂等，可重复执行。
-- 字段类型：text / number / date / select / multiselect / boolean
-- =============================================================================

CREATE TABLE IF NOT EXISTS material_field_definitions (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL,
    field_key   VARCHAR(40) NOT NULL,
    label       VARCHAR(60) NOT NULL,
    type        VARCHAR(16) NOT NULL DEFAULT 'text'
                CHECK (type IN ('text','number','date','select','multiselect','boolean')),
    required    BOOLEAN NOT NULL DEFAULT false,
    options     JSONB NOT NULL DEFAULT '[]',
    sort_order  INT NOT NULL DEFAULT 0,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, field_key)
);
CREATE INDEX IF NOT EXISTS ix_mfielddefs_tenant ON material_field_definitions (tenant_id, sort_order);

ALTER TABLE materials ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}';

-- RLS：与其余带 tenant_id 的业务表同口径
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        ALTER TABLE public.material_field_definitions ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON public.material_field_definitions;
        CREATE POLICY tenant_isolation ON public.material_field_definitions
            AS PERMISSIVE FOR ALL TO labelflow_app
            USING  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
    END IF;
END
$$;
