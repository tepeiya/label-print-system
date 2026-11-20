-- =============================================================================
-- Prompt 库增强：版本历史 + 角色分发 + 调用量统计（幂等）
--
--   · agent_prompts 补列 version / roles / usage_count（IF NOT EXISTS 由 DO 块保证）
--   · 新增 agent_prompt_versions：每次 upsert 前存旧快照，rollback 也存一条 → 可追溯链
--   · 两表都带 tenant_id，挂 tenant_isolation RLS；授权 labelflow_app / labelflow_platform
--
-- 应用层口径：backend/src/agent/prompt.calc.ts（snapshot/version/visibleToRoles 纯函数）
--            backend/src/agent/prompts.service.ts（upsert 存版本、rollback、bumpUsage）
-- 幂等：可重复执行。项目 synchronize=false，本脚本需手工在目标库执行。
-- =============================================================================

BEGIN;

-- ----- 1. agent_prompts 补列 -----
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'agent_prompts' AND column_name = 'version') THEN
        ALTER TABLE agent_prompts ADD COLUMN version INT NOT NULL DEFAULT 1;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'agent_prompts' AND column_name = 'roles') THEN
        ALTER TABLE agent_prompts ADD COLUMN roles JSONB NOT NULL DEFAULT '[]';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'agent_prompts' AND column_name = 'usage_count') THEN
        ALTER TABLE agent_prompts ADD COLUMN usage_count INT NOT NULL DEFAULT 0;
    END IF;
END
$$;

COMMENT ON COLUMN agent_prompts.version IS '当前版本号，每次内容变更 +1';
COMMENT ON COLUMN agent_prompts.roles IS '按角色分发：空数组=全员；非空=仅这些角色码可见';
COMMENT ON COLUMN agent_prompts.usage_count IS '渲染/调用次数统计';

-- ----- 2. 版本历史表 -----
CREATE TABLE IF NOT EXISTS agent_prompt_versions (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT       NOT NULL,
    name        VARCHAR(64)  NOT NULL,
    version     INT          NOT NULL,
    title       VARCHAR(120) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    content     TEXT         NOT NULL,
    arguments   JSONB        NOT NULL DEFAULT '[]',
    enabled     BOOLEAN      NOT NULL DEFAULT true,
    sort_order  INT          NOT NULL DEFAULT 100,
    action      VARCHAR(20)  NOT NULL DEFAULT 'upsert',
    actor_id    BIGINT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_promptver_tenant_name
    ON agent_prompt_versions (tenant_id, name);
CREATE INDEX IF NOT EXISTS ix_promptver_lookup
    ON agent_prompt_versions (tenant_id, name, version, id DESC);

COMMENT ON TABLE agent_prompt_versions IS '提示词版本历史：upsert/rollback 前的快照，支持回滚';
COMMENT ON COLUMN agent_prompt_versions.action IS 'initial=首次创建 / upsert=被覆盖前 / rollback=回滚前';

-- ----- 3. RLS -----
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE tablename = 'agent_prompt_versions' AND policyname = 'tenant_isolation_versions') THEN
        CREATE POLICY tenant_isolation_versions ON agent_prompt_versions
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint);
    END IF;
END
$$;
ALTER TABLE agent_prompt_versions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_prompt_versions TO labelflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_prompt_versions TO labelflow_platform;

COMMIT;
