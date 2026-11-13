-- =============================================================================
-- P8.1 自动化触发器：print_triggers / trigger_deliveries
-- 部署顺序：接在 saas_p7_notifications.sql 之后（见 docs/10 §10.27 建表顺序）。
--
-- 设计要点：
--   1. 两张表都带 tenant_id，纳入 P6.1 RLS 兜底与 P6.3 导出/硬删表清单
--      （tenant-data.service 从 pg_catalog 现取带 tenant_id 的表，自动纳入）。
--   2. dedupe_key 的部分唯一索引是并发去重的最终防线：
--      先查后写在多 worker 下会同时查空，第二个 insert 撞 23505，由服务端回查判重复。
--   3. webhook 的 secret 只以密文存 config.secretEnc，不建明文列。
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.print_triggers (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    name            VARCHAR(80) NOT NULL,
    source          VARCHAR(40) NOT NULL,
    condition_expr  TEXT,
    action          VARCHAR(20) NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_print_triggers_tenant_source
    ON public.print_triggers (tenant_id, source, enabled);

CREATE TABLE IF NOT EXISTS public.trigger_deliveries (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    trigger_id      BIGINT NOT NULL,
    event_source    VARCHAR(40) NOT NULL,
    dedupe_key      VARCHAR(160),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    http_status     INTEGER,
    error_msg       TEXT,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_trigger_deliveries_tenant_created
    ON public.trigger_deliveries (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_trigger_deliveries_trigger
    ON public.trigger_deliveries (tenant_id, trigger_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trigger_delivery_dedupe
    ON public.trigger_deliveries (tenant_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

-- RLS 兜底：与 saas_p6_rls.sql / saas_p7_notifications.sql 同口径。
-- 角色不存在时跳过（dev 老库可能还没建 labelflow_app），不影响建表。
DO $$
DECLARE t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        FOREACH t IN ARRAY ARRAY['print_triggers', 'trigger_deliveries'] LOOP
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
            EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
            EXECUTE format(
                'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO labelflow_app '
                || 'USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint) '
                || 'WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint)', t);
        END LOOP;
    END IF;
END
$$;
