-- =============================================================================
-- saas_p2_platform.sql —— P2 平台运营后台（docs/11 §11.11 / §11.6.2）
--
-- 内容：
--   1) platform_users 表：平台运营身份，与租户 users 完全隔离
--   2) 种子账号 platform / platform#2026（首次执行写入；已存在则跳过）
--
-- 执行顺序：03-database.sql → seed.sql → saas_p0.sql → saas_p0_roles.sql → 本文件
-- 说明：JWT 里会带 scope='platform'，/platform 的运营接口只认这个 scope
--       （P0 时代是拿租户 admin JWT 直接调 /platform/*，P2 起关掉，见 platform-jwt.guard.ts）
-- =============================================================================

CREATE TABLE IF NOT EXISTS platform_users (
    id            BIGSERIAL PRIMARY KEY,
    username      VARCHAR(60) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    display_name  VARCHAR(60) NOT NULL DEFAULT '',
    role          VARCHAR(20) NOT NULL DEFAULT 'operator',  -- super / operator（L0，docs/11 §11.4）
    status        SMALLINT NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 种子账号（幂等）：platform / platform#2026，bcrypt cost 10
INSERT INTO platform_users (username, password_hash, display_name, role)
SELECT 'platform',
       '$2a$10$5kjCWohCyqI/PULWCJtrXObyZrj1BYBFPng73XWIZPyTg3KQcdQhy',
       '平台运营',
       'super'
WHERE NOT EXISTS (SELECT 1 FROM platform_users WHERE username = 'platform');

-- 平台侧审计（与租户 audit_logs 分开：audit_logs.tenant_id 有 FK，平台动作没有租户上下文）
CREATE TABLE IF NOT EXISTS platform_audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    actor_id    BIGINT NOT NULL,
    actor_name  VARCHAR(60) NOT NULL DEFAULT '',
    action      VARCHAR(60) NOT NULL,
    detail      JSONB NOT NULL DEFAULT '{}',
    target_type VARCHAR(40),
    target_id   BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_plataudit_time ON platform_audit_logs (created_at DESC);
