-- =============================================================================
-- 标签管理与打印系统 数据库 DDL（PostgreSQL 16）
-- 约定：
--   1) 所有业务表均含 tenant_id，强制行级隔离；联合索引首列必为 tenant_id。
--   2) 金额/数量用 numeric；坐标类派生字段不入库（模板内以 mm 存 JSONB）。
--   3) 枚举用 CHECK 约束 + 注释，便于跨版本迁移。
--   4) 时区统一用 timestamptz（UTC 存储，展示层转本地）。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. 扩展
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- 模板名/标签 模糊检索（配合 GIN）

-- ---------------------------------------------------------------------------
-- 1. 租户 / 用户 / 角色
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
    id            BIGSERIAL PRIMARY KEY,
    name          VARCHAR(120) NOT NULL,
    code          VARCHAR(60)  NOT NULL UNIQUE,     -- 企业标识，用于备份文件名
    status        SMALLINT NOT NULL DEFAULT 1,      -- 1 启用 0 禁用
    settings      JSONB NOT NULL DEFAULT '{}',      -- 租户级默认 DPI/纸张等
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 角色枚举：super_admin / template_designer / print_operator / readonly_guest
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username      VARCHAR(60)  NOT NULL,
    email         VARCHAR(160),
    password_hash VARCHAR(100) NOT NULL,            -- bcrypt 加盐哈希
    display_name  VARCHAR(80),
    status        SMALLINT NOT NULL DEFAULT 1,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 同一租户内用户名唯一
    CONSTRAINT uq_users_tenant_username UNIQUE (tenant_id, username)
);
CREATE INDEX ix_users_tenant          ON users (tenant_id);
CREATE INDEX ix_users_tenant_email    ON users (tenant_id, email);

CREATE TABLE user_roles (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  BIGINT NOT NULL,                     -- 冗余租户便于隔离查询
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       VARCHAR(30) NOT NULL
               CHECK (role IN ('admin','operator','sql','viewer')),   -- 与 backend/src/common/roles.guard.ts 保持一致
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_roles UNIQUE (tenant_id, user_id, role)
);
CREATE INDEX ix_user_roles_tenant_user ON user_roles (tenant_id, user_id);

-- Refresh Token 轮换存储（可吊销）
CREATE TABLE refresh_tokens (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(100) NOT NULL UNIQUE,       -- 只存哈希，防泄漏
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_tokens_tenant_user ON refresh_tokens (tenant_id, user_id);

-- ---------------------------------------------------------------------------
-- 2. 模板（核心，JSONB 存设计器产物）
-- ---------------------------------------------------------------------------
CREATE TABLE templates (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    uuid          UUID NOT NULL DEFAULT gen_random_uuid(),
    name          VARCHAR(160) NOT NULL,
    category      VARCHAR(60),                       -- 分类
    tags          TEXT[]  NOT NULL DEFAULT '{}',      -- 标签（GIN 检索）
    description   VARCHAR(500),
    schema_version INTEGER NOT NULL DEFAULT 1,       -- 模板 schema 版本，导入时做迁移
    -- 设计器完整产物：页面设置 + 元素列表 + 变量定义 + 数据源定义 + 打印参数
    content       JSONB  NOT NULL,
    thumbnail     BYTEA,                             -- 预览缩略图（PNG，可选）
    current_version INTEGER NOT NULL DEFAULT 1,      -- 指向最新版本号
    acl           JSONB  NOT NULL DEFAULT '{}',       -- {userId:['view','edit','print','export','share']}
    is_favorite   BOOLEAN NOT NULL DEFAULT false,
    created_by    BIGINT,
    updated_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_templates_tenant_uuid UNIQUE (tenant_id, uuid)
);
-- 租户隔离 + 名称检索 + 标签 GIN 索引
CREATE INDEX ix_templates_tenant            ON templates (tenant_id);
CREATE INDEX ix_templates_tenant_name       ON templates (tenant_id, name);
CREATE INDEX ix_templates_tenant_category   ON templates (tenant_id, category);
CREATE INDEX ix_templates_tags              ON templates USING GIN (tags);
CREATE INDEX ix_templates_content_gin       ON templates USING GIN (content jsonb_path_ops); -- 元素/变量全文检索

-- 版本快照：每次保存生成一份（可回滚/对比）
CREATE TABLE template_versions (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    template_id   BIGINT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,
    content       JSONB NOT NULL,                    -- 该版本完整 content 快照
    comment       VARCHAR(300),
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_tplver_tenant_template_version UNIQUE (tenant_id, template_id, version)
);
CREATE INDEX ix_tplver_tenant_template ON template_versions (tenant_id, template_id);

-- 模板资源（图片/字体等）：可 base64 内联，也可独立文件
CREATE TABLE template_assets (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    template_id   BIGINT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    asset_key     VARCHAR(120) NOT NULL,            -- 设计器中引用的资源 key
    mime          VARCHAR(60),
    data          BYTEA,                             -- 二进制资源（图片/字体）
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_assets_tenant_template_key UNIQUE (tenant_id, template_id, asset_key)
);
CREATE INDEX ix_assets_tenant_template ON template_assets (tenant_id, template_id);

-- 模板共享（跨用户，仍在同租户内）
CREATE TABLE template_shares (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    template_id   BIGINT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    shared_with   BIGINT NOT NULL,                   -- 被共享用户 id
    perms         VARCHAR(30)[] NOT NULL DEFAULT '{view}', -- view/edit/print/export/share
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_shares_tenant UNIQUE (tenant_id, template_id, shared_with)
);
CREATE INDEX ix_shares_tenant_sharedwith ON template_shares (tenant_id, shared_with);

-- ---------------------------------------------------------------------------
-- 3. 数据源（CSV/Excel 导入落库 + SQL 数据源配置）
-- ---------------------------------------------------------------------------
CREATE TABLE data_sources (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    name          VARCHAR(120) NOT NULL,
    type          VARCHAR(20) NOT NULL CHECK (type IN ('csv','excel','sql')),
    config        JSONB NOT NULL DEFAULT '{}',      -- sql 连接/查询；csv 字段映射
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_datasources_tenant ON data_sources (tenant_id);

-- 导入的数据行（手工/CSV），供批量打印消费
CREATE TABLE data_rows (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    source_id     BIGINT REFERENCES data_sources(id) ON DELETE CASCADE,
    template_id   BIGINT,                            -- 关联模板（字段映射上下文）
    payload       JSONB NOT NULL,                    -- {col1:val, col2:val, ...}
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_datarows_tenant_source   ON data_rows (tenant_id, source_id);
CREATE INDEX ix_datarows_tenant_template ON data_rows (tenant_id, template_id);

-- ---------------------------------------------------------------------------
-- 4. 打印机
-- ---------------------------------------------------------------------------
CREATE TABLE printers (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    name          VARCHAR(120) NOT NULL,
    type          VARCHAR(20) NOT NULL
                  CHECK (type IN ('browser','raw_tcp','windows_spooler','image')),
    connection    JSONB NOT NULL DEFAULT '{}',      -- {host,port,usbId,driverName}
    dpi           INTEGER NOT NULL DEFAULT 203,      -- 203/300/600
    label_width_mm  NUMERIC(8,2) NOT NULL DEFAULT 40,
    label_height_mm NUMERIC(8,2) NOT NULL DEFAULT 30,
    orientation   SMALLINT NOT NULL DEFAULT 0 CHECK (orientation IN (0,90,180,270)),
    offset_x_mm   NUMERIC(7,2) NOT NULL DEFAULT 0,  -- 偏移校准
    offset_y_mm   NUMERIC(7,2) NOT NULL DEFAULT 0,
    density       SMALLINT,                          -- 打印浓度 0-30
    speed         SMALLINT,                          -- 打印速度档位
    default_template_id BIGINT,
    is_default    BOOLEAN NOT NULL DEFAULT false,
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_printers_tenant ON printers (tenant_id);

-- ---------------------------------------------------------------------------
-- 5. 流水号（并发安全核心）
--    设计：用行级锁保护 current_value 游标；批量打印一次性预占号段。
--    不重号保证：UPDATE ... SET current_value = current_value + step*N RETURNING
--    原子自增；崩溃丢号段由回滚策略处理。
-- ---------------------------------------------------------------------------
CREATE TABLE serial_sequences (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    name          VARCHAR(80) NOT NULL,
    scope         VARCHAR(20) NOT NULL DEFAULT 'template'
                  CHECK (scope IN ('tenant','template','custom_group')),
    group_key     VARCHAR(60),                       -- scope=custom_group 时使用
    start_value   BIGINT NOT NULL DEFAULT 1,
    step          INTEGER NOT NULL DEFAULT 1,
    current_value BIGINT NOT NULL DEFAULT 1,         -- 游标（下一个待分配）
    digits        SMALLINT NOT NULL DEFAULT 0,       -- 前导补零位数（0=不补）
    prefix        VARCHAR(40) NOT NULL DEFAULT '',
    suffix        VARCHAR(40) NOT NULL DEFAULT '',
    radix         SMALLINT NOT NULL DEFAULT 10 CHECK (radix IN (10,16,36)),
    reset_cycle   VARCHAR(20) NOT NULL DEFAULT 'never'
                  CHECK (reset_cycle IN ('never','daily','monthly','yearly','custom')),
    reset_at      TIMESTAMPTZ,                       -- 上次重置时间（用于周期判定）
    custom_cycle_days INTEGER,                       -- reset_cycle=custom 时生效
    allow_manual_reset BOOLEAN NOT NULL DEFAULT true,
    consume_mode  VARCHAR(20) NOT NULL DEFAULT 'per_copy'
                  CHECK (consume_mode IN ('per_copy','per_batch')),
    rollback_policy VARCHAR(20) NOT NULL DEFAULT 'consume'
                  CHECK (rollback_policy IN ('rollback','consume')),
    version       INTEGER NOT NULL DEFAULT 0,         -- 乐观锁（CAS 兜底）
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_serial_tenant_scope UNIQUE (tenant_id, name, scope, group_key)
);
CREATE INDEX ix_serial_tenant ON serial_sequences (tenant_id);

-- 号段使用记录（可查/可导/可审计）
CREATE TABLE serial_usage_log (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    sequence_id   BIGINT NOT NULL REFERENCES serial_sequences(id),
    job_id        BIGINT,                            -- 关联打印任务
    value         BIGINT NOT NULL,                   -- 数值
    formatted     VARCHAR(120),                      -- 格式化后（含前后缀/补零）
    status        VARCHAR(20) NOT NULL DEFAULT 'issued'
                  CHECK (status IN ('issued','consumed','rolled_back','skipped')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_serialusage_tenant_seq      ON serial_usage_log (tenant_id, sequence_id);
CREATE INDEX ix_serialusage_tenant_job      ON serial_usage_log (tenant_id, job_id);

-- ---------------------------------------------------------------------------
-- 6. 打印任务 / 日志
-- ---------------------------------------------------------------------------
CREATE TABLE print_jobs (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    uuid          UUID NOT NULL DEFAULT gen_random_uuid(),
    template_id   BIGINT NOT NULL,
    printer_id    BIGINT,
    total         INTEGER NOT NULL DEFAULT 1,        -- 总张数
    done          INTEGER NOT NULL DEFAULT 0,        -- 已完成
    failed        INTEGER NOT NULL DEFAULT 0,
    status        VARCHAR(20) NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','printing','success','partial','failed','canceled')),
    params        JSONB NOT NULL DEFAULT '{}',       -- 份数/旋转/镜像等打印参数
    data_ref      JSONB,                             -- 数据源引用或内联数据摘要
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);
CREATE INDEX ix_printjobs_tenant_status ON print_jobs (tenant_id, status);
CREATE INDEX ix_printjobs_tenant_created ON print_jobs (tenant_id, created_at DESC);

-- 打印明细日志（每张标签一条，可追溯重打）
CREATE TABLE print_logs (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    job_id        BIGINT NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,
    template_id   BIGINT NOT NULL,
    printer_id    BIGINT,
    seq_no        INTEGER NOT NULL,                  -- 第几张
    serial_values JSONB,                             -- 本张消耗的流水号（溯源）
    data_snapshot JSONB,                             -- 本张渲染所用数据快照
    status        VARCHAR(20) NOT NULL,
    error_msg     VARCHAR(500),
    reprint_of    BIGINT,                            -- 指向原 log（补打/重打）
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_printlogs_tenant_job ON print_logs (tenant_id, job_id);
CREATE INDEX ix_printlogs_tenant_created ON print_logs (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 7. 审计日志
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    actor_id      BIGINT,
    action        VARCHAR(40) NOT NULL,             -- login/template.create/export/...
    target_type   VARCHAR(30),
    target_id     BIGINT,
    detail        JSONB,
    ip            VARCHAR(45),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_tenant_created ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX ix_audit_tenant_action  ON audit_logs (tenant_id, action);

-- ---------------------------------------------------------------------------
-- 8. 整租户备份记录
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_backups (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    name          VARCHAR(160) NOT NULL,
    storage_key   VARCHAR(300) NOT NULL,            -- 对象存储 key（已脱敏）
    size_bytes    BIGINT,
    kind          VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','scheduled')),
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_backups_tenant ON tenant_backups (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 8.5 AI 模板生成（详见 docs/09-ai-template-generation.md）
-- ---------------------------------------------------------------------------

-- 生成任务：大图 / 异步场景落库，前端轮询 /ai-template/status/:jobId
CREATE TABLE ai_template_jobs (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    status        VARCHAR(20) NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','done','failed')),
    image_path    TEXT,                              -- 临时存储路径（24h 定时清理）
    image_bytes   BIGINT,
    params        JSONB NOT NULL DEFAULT '{}',       -- 用户输入：targetWidthMm/HeightMm/dpi/tagMode/...
    result        JSONB,                             -- AiTemplateGenerateResponse（template + meta）
    error_msg     TEXT,
    elapsed_ms    INTEGER,
    model         VARCHAR(120),                      -- 实际使用的模型标识
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);
CREATE INDEX ix_aitpljobs_tenant_created ON ai_template_jobs (tenant_id, created_at DESC);
CREATE INDEX ix_aitpljobs_tenant_status  ON ai_template_jobs (tenant_id, status);

-- Vision LLM 配置：支持多模型切换（qwen-vl / gpt-4o / ollama-llava / custom）
-- api_key 使用 AES-256-GCM 加密存储（复用 backend/src/datasource/sql-crypto.ts）
CREATE TABLE ai_model_configs (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,                  -- 租户隔离字段
    name          VARCHAR(60) NOT NULL,             -- 展示名，如 "qwen-vl-max"
    provider      VARCHAR(40) NOT NULL
                  CHECK (provider IN ('qwen','openai','zhipu','ollama','custom')),
    api_endpoint  TEXT,
    api_key_enc   TEXT,                             -- 加密后的 API Key
    model_id      VARCHAR(120) NOT NULL,            -- 厂商模型 id
    is_default    BOOLEAN NOT NULL DEFAULT false,
    settings      JSONB NOT NULL DEFAULT '{}',      -- temperature / max_tokens / prompt_override
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_aimodel_tenant_name UNIQUE (tenant_id, name)
);
CREATE INDEX ix_aimodels_tenant ON ai_model_configs (tenant_id);

-- =============================================================================
-- 9. 行级隔离说明（代码侧配合 TenantGuard）
--    所有 Repository 查询形如：
--      SELECT * FROM templates WHERE tenant_id = $1 AND id = $2
--    tenant_id 由网关从 JWT 注入，前端无法越权指定。
-- =============================================================================
COMMENT ON TABLE templates IS '模板主表；tenant_id 强制行级隔离';
COMMENT ON TABLE serial_sequences IS '流水号游标表；current_value 通过行锁/原子自增保护';
COMMENT ON TABLE print_jobs IS '打印任务；tenant_id 隔离，状态机驱动队列';
