-- =============================================================================
-- P6.5 Prompt 库（D8）DDL：agent_prompts + 权限点 sys:prompt:manage
--
-- 设计口径（docs/10 §10.26）：
--   · 系统提示词的**权威副本在代码里**（backend/src/agent/prompt.defaults.ts），
--     本表只存「租户改过的同名覆盖」与「租户自己加的」两类行——
--     这样提示词文案迭代不会留下 N 份互不一致的存量数据，租户删除覆盖行即回落系统默认。
--   · 一个租户内 name 唯一（UNIQUE(tenant_id, name)）；同名 = 覆盖，不是新增。
--   · arguments 只允许数组（每项 {name,title,description,required,default}），
--     正文里的 {{arg}} 必须能在数组里找到 —— 应用层校验（prompt.calc.ts），
--     这一层只拦「结构都不对」的数据（非数组 / 参数过多 / 明显坏名字）。
--   · 不做模板脚本：正文只做 {{arg}} 文本替换，没有条件分支/循环/表达式。
--
-- 幂等：CREATE TABLE/INDEX IF NOT EXISTS、ON CONFLICT DO NOTHING、策略 DROP 后重建。
-- RLS：本表带 tenant_id，挂 tenant_isolation；同时授权 labelflow_app / labelflow_platform。
--      （saas_p6_rls.sql 的「全表扫描」也会覆盖它，这里的策略让本文件单独执行也成立。）
-- =============================================================================

BEGIN;

-- ----- 1. 表 -----
CREATE TABLE IF NOT EXISTS agent_prompts (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT       NOT NULL,
    name        VARCHAR(64)  NOT NULL,
    title       VARCHAR(120) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    content     TEXT         NOT NULL,
    arguments   JSONB        NOT NULL DEFAULT '[]',
    enabled     BOOLEAN      NOT NULL DEFAULT true,
    sort_order  INT          NOT NULL DEFAULT 100,
    created_by  BIGINT,
    updated_by  BIGINT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_prompts IS
  '租户级提示词覆盖/自定义（P6.5）。系统默认在 prompt.defaults.ts；同名行=覆盖，删除即回落';
COMMENT ON COLUMN agent_prompts.name IS '提示词名（小写字母开头，a-z0-9_.-，3–64），如 inventory.health_check';
COMMENT ON COLUMN agent_prompts.arguments IS '参数定义数组 [{name,title,description,required,default}]，最多 12 个';
COMMENT ON COLUMN agent_prompts.enabled IS 'false = 从 Agent 的 prompts/list 隐藏（管理列表仍可见）';

-- ----- 2. 结构护栏 -----
DO $$
BEGIN
    -- name 形态（与应用层 PROMPT_NAME_RE 同一口径）
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_prompts_name_format') THEN
        ALTER TABLE agent_prompts
            ADD CONSTRAINT agent_prompts_name_format
            CHECK (name ~ '^[a-z][a-z0-9_.-]{2,63}$');
    END IF;
    -- 标题至少 2 字
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_prompts_title_len') THEN
        ALTER TABLE agent_prompts
            ADD CONSTRAINT agent_prompts_title_len
            CHECK (char_length(btrim(title)) >= 2);
    END IF;
    -- 正文 10–20000（应用层 MAX_CONTENT 同口径；DB 只防误写超长）
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_prompts_content_len') THEN
        ALTER TABLE agent_prompts
            ADD CONSTRAINT agent_prompts_content_len
            CHECK (char_length(content) BETWEEN 10 AND 20000);
    END IF;
    -- 参数必须是数组且不超过 12 项
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_prompts_arguments_shape') THEN
        ALTER TABLE agent_prompts
            ADD CONSTRAINT agent_prompts_arguments_shape
            CHECK (jsonb_typeof(arguments) = 'array' AND jsonb_array_length(arguments) <= 12);
    END IF;
END
$$;

-- 租户内 name 唯一（同名即覆盖，冲突由应用层 upsert 处理，这里守住数据不重复）
CREATE UNIQUE INDEX IF NOT EXISTS ux_agentprompt_tenant_name ON agent_prompts (tenant_id, name);
CREATE INDEX IF NOT EXISTS ix_agentprompt_tenant ON agent_prompts (tenant_id);

-- ----- 3. 授权 + RLS -----
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_prompts TO labelflow_app;
        GRANT USAGE, SELECT ON SEQUENCE public.agent_prompts_id_seq TO labelflow_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_platform') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_prompts TO labelflow_platform;
        GRANT USAGE, SELECT ON SEQUENCE public.agent_prompts_id_seq TO labelflow_platform;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        ALTER TABLE public.agent_prompts ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON public.agent_prompts;
        CREATE POLICY tenant_isolation ON public.agent_prompts
            AS PERMISSIVE FOR ALL TO labelflow_app
            USING  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
    END IF;
END
$$;

-- ----- 4. 权限字典 -----
-- 「改提示词」改的是 Agent 对全公司说话的模板，属于租户级运营配置 → 只给 admin / tenant_admin。
INSERT INTO permissions (code, module_code, resource, action, description, name, is_high_risk) VALUES
  ('sys:prompt:manage', 'users', 'prompt', 'manage', 'Prompt 库：系统提示词覆盖与自定义（D8）', 'Prompt 库', FALSE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('admin',        'sys:prompt:manage'),
  ('tenant_admin', 'sys:prompt:manage')
ON CONFLICT DO NOTHING;

-- ----- 5. 自检 -----
DO $$
DECLARE
    n_cols INT;
    n_cons INT;
    n_rls  INT;
BEGIN
    SELECT count(*) INTO n_cols FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agent_prompts';
    IF n_cols < 13 THEN
        RAISE EXCEPTION 'agent_prompts 列不全（% < 13）', n_cols;
    END IF;

    SELECT count(*) INTO n_cons FROM pg_constraint
      WHERE conrelid = 'public.agent_prompts'::regclass AND contype = 'c';
    IF n_cons < 4 THEN
        RAISE EXCEPTION 'agent_prompts 结构约束不全（% < 4）', n_cons;
    END IF;

    SELECT count(*) INTO n_rls FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'agent_prompts' AND policyname = 'tenant_isolation';
    IF n_rls = 0 AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        RAISE EXCEPTION 'agent_prompts 缺少 tenant_isolation 策略';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'sys:prompt:manage') THEN
        RAISE EXCEPTION 'sys:prompt:manage 未进权限字典';
    END IF;
    IF (SELECT count(*) FROM role_permissions WHERE permission_code = 'sys:prompt:manage') < 2 THEN
        RAISE EXCEPTION 'sys:prompt:manage 未授予 admin / tenant_admin';
    END IF;

    RAISE NOTICE 'Prompt 库 DDL 就位：% 列 / % 约束 / RLS %', n_cols, n_cons, n_rls;
END
$$;

COMMIT;

SELECT 'agent_prompts_columns' AS metric, count(*)::text AS value
FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_prompts'
UNION ALL
SELECT 'agent_prompts_rls', count(*)::text FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'agent_prompts' AND policyname = 'tenant_isolation'
UNION ALL
SELECT 'prompt_perm_roles', count(*)::text FROM role_permissions
WHERE permission_code = 'sys:prompt:manage';
