-- =============================================================================
-- P8.3 企业治理：governance_settings / template_governance /
--                 template_reviews / print_dedupe
-- 部署顺序：接在 saas_p8_triggers.sql 之后（见 docs/10 §10.27 建表顺序）。
--
-- 设计要点：
--   1. 四张表都带 tenant_id，纳入 P6.1 RLS 兜底与 P6.3 导出/硬删表清单
--      （tenant-data.service 从 pg_catalog 现取带 tenant_id 的表，自动纳入）。
--   2. templates 表**不加列**：治理状态放独立表，存量模板没有记录即「未纳管」，
--      所有前置校验对无记录放行，保证上线本功能不挡住任何现有打印链路。
--   3. uq_print_dedupe_tenant_key 唯一索引是并发防重的最终防线：
--      先查后写在多 worker 下会同时查空，第二个 insert 撞 23505，由服务端回查判重复。
--   4. 审批理由（review_comment）明文存审计，但不含密钥/连接串等敏感字段。
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.governance_settings (
    tenant_id       BIGINT PRIMARY KEY,
    policy          JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by      BIGINT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.template_governance (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           BIGINT NOT NULL,
    template_id         BIGINT NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'draft',
    published_version   INTEGER,
    submitted_by        BIGINT,
    submitted_at        TIMESTAMPTZ,
    reviewed_by         BIGINT,
    reviewed_at         TIMESTAMPTZ,
    review_comment      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_template_governance_tenant_template UNIQUE (tenant_id, template_id)
);

CREATE INDEX IF NOT EXISTS ix_template_governance_tenant_status
    ON public.template_governance (tenant_id, status);

CREATE TABLE IF NOT EXISTS public.template_reviews (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    template_id     BIGINT NOT NULL,
    from_status     VARCHAR(20),
    to_status       VARCHAR(20) NOT NULL,
    action          VARCHAR(30) NOT NULL,
    actor_id        BIGINT,
    comment         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_template_reviews_tenant_template
    ON public.template_reviews (tenant_id, template_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.print_dedupe (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           BIGINT NOT NULL,
    dedupe_key          VARCHAR(160) NOT NULL,
    template_id         BIGINT NOT NULL,
    job_id              BIGINT NOT NULL,
    first_printed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_printed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    print_count         INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT uq_print_dedupe_tenant_key UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS ix_print_dedupe_tenant_template
    ON public.print_dedupe (tenant_id, template_id);

-- RLS 兜底：与 saas_p6_rls.sql / saas_p7_notifications.sql / saas_p8_triggers.sql 同口径。
-- 角色不存在时跳过（dev 老库可能还没建 labelflow_app），不影响建表。
DO $$
DECLARE t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        FOREACH t IN ARRAY ARRAY['governance_settings', 'template_governance', 'template_reviews', 'print_dedupe'] LOOP
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
