-- =============================================================================
-- P8.5 硬件层：hardware_agents / hardware_agent_jobs / hardware_rfid_logs
-- 部署顺序：接在 saas_p8_governance.sql 之后（见 docs/10 §10.27 建表顺序）。
--
-- 设计要点：
--   1. 三张表都带 tenant_id，纳入 P6.1 RLS 兜底与 P6.3 导出/硬删表清单
--      （tenant-data.service 从 pg_catalog 现取带 tenant_id 的表，自动纳入）。
--   2. secret_enc 存 AES-256-GCM 密文（复用 SQL_SECRET_KEY）。签名校验需要明文，
--      所以不能只存 hash；secret_hash 仅作运维指纹，不参与鉴权、不返回给任何接口。
--   3. uq_hardware_jobs_tenant_key 是入队幂等的最终防线：打印 Worker 重试或
--      多实例同时入队时，同一个 jobKey 只应产生一条待办，撞 23505 视为已入队。
--   4. 任务信封是 JSONB，写入前已由 agent-protocol.calc.agentJobEnvelope 做
--      字段白名单脱敏（connection 只留 driverName），DDL 层不再做额外过滤。
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.hardware_agents (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           BIGINT NOT NULL,
    agent_id            VARCHAR(64) NOT NULL,
    name                VARCHAR(120) NOT NULL,
    capabilities        JSONB NOT NULL DEFAULT '[]'::jsonb,
    driver_names        JSONB NOT NULL DEFAULT '[]'::jsonb,
    secret_enc          TEXT NOT NULL,
    secret_hash         VARCHAR(64) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'active',
    last_heartbeat_at   TIMESTAMPTZ,
    load                INTEGER NOT NULL DEFAULT 0,
    draining            BOOLEAN NOT NULL DEFAULT FALSE,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_hardware_agents_tenant_agent UNIQUE (tenant_id, agent_id)
);

CREATE INDEX IF NOT EXISTS ix_hardware_agents_tenant
    ON public.hardware_agents (tenant_id);

CREATE TABLE IF NOT EXISTS public.hardware_agent_jobs (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    job_key         VARCHAR(64) NOT NULL,
    agent_id        VARCHAR(64),
    job_id          BIGINT NOT NULL,
    printer_id      BIGINT,
    template_id     BIGINT,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    capability      VARCHAR(32) NOT NULL DEFAULT 'windows_spooler',
    envelope        JSONB NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    claimed_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_hardware_jobs_tenant_key UNIQUE (tenant_id, job_key)
);

CREATE INDEX IF NOT EXISTS ix_hardware_jobs_tenant_status
    ON public.hardware_agent_jobs (tenant_id, status);

CREATE TABLE IF NOT EXISTS public.hardware_rfid_logs (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    epc             VARCHAR(24) NOT NULL,
    read_back       VARCHAR(24),
    verified        BOOLEAN NOT NULL DEFAULT FALSE,
    job_id          BIGINT,
    detail          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_hardware_rfid_tenant
    ON public.hardware_rfid_logs (tenant_id);

-- RLS 兜底：与 saas_p6_rls.sql / saas_p8_governance.sql 同口径。
-- 角色不存在时跳过（dev 老库可能还没建 labelflow_app），不影响建表。
DO $$
DECLARE t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        FOREACH t IN ARRAY ARRAY['hardware_agents', 'hardware_agent_jobs', 'hardware_rfid_logs'] LOOP
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
