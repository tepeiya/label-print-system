-- =============================================================================
-- 知识库（平台端只读）与 AI 助手：表结构
--
-- 设计要点：
--   · kb_articles 不带 tenant_id —— 知识库是"平台级"内容，只在平台运营后台显示，
--     后端用 PlatformJwtGuard 把关（租户 token 调不进来）。若要按租户定制，
--     再做 kb_tenant_overrides，不在这张表上塞 tenant_id 造出两套语义。
--   · kb_assistant_logs 记录每次问答的命中文档、是否用了大模型、耗时，
--     便于运营看"用户到底卡在哪一步"。
--   · 全部幂等（IF NOT EXISTS / ON CONFLICT），可随 db-init.sh 重复执行。
-- =============================================================================

CREATE TABLE IF NOT EXISTS kb_articles (
    id          BIGSERIAL PRIMARY KEY,
    slug        VARCHAR(80)  NOT NULL,
    title       VARCHAR(200) NOT NULL,
    category    VARCHAR(40)  NOT NULL,
    tags        TEXT         NOT NULL DEFAULT '',
    summary     VARCHAR(400),
    content     TEXT         NOT NULL,
    sort        INTEGER      NOT NULL DEFAULT 100,
    published   BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uq_kb_articles_slug UNIQUE (slug)
);
CREATE INDEX IF NOT EXISTS ix_kb_articles_category ON kb_articles (category, sort);

COMMENT ON TABLE kb_articles IS '平台端知识库文章（系统功能说明与使用教程）；无 tenant_id，靠 PlatformJwtGuard 限平台身份';

CREATE TABLE IF NOT EXISTS kb_assistant_logs (
    id           BIGSERIAL PRIMARY KEY,
    question     VARCHAR(1000) NOT NULL,
    tenant_id    BIGINT,
    hits         JSONB        NOT NULL DEFAULT '[]'::jsonb,
    answered_by  VARCHAR(20)  NOT NULL DEFAULT 'kb',   -- kb / llm / llm_failed
    model        VARCHAR(120),
    duration_ms  INTEGER,
    detail       JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_kb_assistant_logs_created ON kb_assistant_logs (created_at DESC);

COMMENT ON TABLE kb_assistant_logs IS 'AI 助手问答留痕：命中哪些文章、答案来自知识库还是大模型、耗时';
