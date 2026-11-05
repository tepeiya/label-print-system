-- =============================================================================
-- saas_p3_billing.sql —— P3 计费闭环（docs/11 §11.11 / §11.7 / D5）
--
-- 内容：
--   1) plans 加 price（月费，单位分）——出账基准
--   2) usage_meters（原始用量）/ usage_daily（日聚合，配额检查读它）
--   3) quotas（软/硬上限；hard_limit 拒绝并引导升级，soft_limit 只告警）
--   4) invoices（账单，draft→issued→paid/void/overdue）/ payments（收款，D5 先手动登记）
--   5) 权限点 sys:billing:read（租户看自己的账单/用量）
--
-- 执行顺序：03-database.sql → seed.sql → saas_p0.sql → saas_p0_roles.sql
--           → saas_p2_platform.sql → 本文件
-- 说明：docs/11 §11.5 用 platform. schema 书写；实际库沿用与 P0/P2 同层的
--       public schema（表名唯一，不与租户业务表冲突），保持一致不引 schema。
-- =============================================================================

-- ----- 1. 套餐月费（分）。0 = 免费/未定价，出账时按 0 记账但不阻断 -----
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_cents BIGINT NOT NULL DEFAULT 0;
-- 定价占位（BASIC 未定价=0，PRO/ENTERPRISE 给示例价；实际以商务合同为准，运营可改）
UPDATE plans SET price_cents = 0    WHERE code = 'BASIC'       AND price_cents = 0;
UPDATE plans SET price_cents = 29900 WHERE code = 'PRO'        AND price_cents = 0;
UPDATE plans SET price_cents = 99900 WHERE code = 'ENTERPRISE' AND price_cents = 0;

-- ----- 2a. 原始用量（先落 raw，再日聚合，便于对账，§11.7 计量规则）-----
CREATE TABLE IF NOT EXISTS usage_meters (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    meter           VARCHAR(40) NOT NULL,   -- print_labels / ai_generate / ...
    module_code     VARCHAR(40),
    quantity        NUMERIC(14,2) NOT NULL,
    user_id         BIGINT,
    meta            JSONB NOT NULL DEFAULT '{}',
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_usage_tenant_meter_time
    ON usage_meters (tenant_id, meter, occurred_at DESC);

-- ----- 2b. 日聚合（配额检查读这张，避免每次扫原始表）-----
CREATE TABLE IF NOT EXISTS usage_daily (
    tenant_id  BIGINT NOT NULL,
    meter      VARCHAR(40) NOT NULL,
    day        DATE NOT NULL,
    quantity   NUMERIC(14,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, meter, day)
);
CREATE INDEX IF NOT EXISTS ix_usage_daily_tenant_day ON usage_daily (tenant_id, day);

-- ----- 3. 配额（按 meter 一条，周期 month/day）-----
CREATE TABLE IF NOT EXISTS quotas (
    tenant_id  BIGINT NOT NULL,
    meter      VARCHAR(40) NOT NULL,
    soft_limit NUMERIC(14,2),   -- 超过只告警，不拦
    hard_limit NUMERIC(14,2),   -- 超过拒绝 + 升级引导
    period     VARCHAR(10) NOT NULL DEFAULT 'month',  -- month / day
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, meter)
);

-- ----- 4a. 账单 -----
CREATE TABLE IF NOT EXISTS invoices (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,
    number       VARCHAR(40) NOT NULL UNIQUE,   -- INV-<tenantId>-<yymm>-<seq>
    amount_cents BIGINT NOT NULL,               -- 分，避免浮点
    currency     VARCHAR(8) NOT NULL DEFAULT 'CNY',
    status       VARCHAR(20) NOT NULL
                 CHECK (status IN ('draft','issued','paid','void','overdue')),
    period_start DATE,
    period_end   DATE,
    due_at       TIMESTAMPTZ,
    paid_at      TIMESTAMPTZ,
    detail       JSONB NOT NULL DEFAULT '{}',   -- 出账快照：套餐/单价/周期/行项
    created_by   BIGINT,                        -- 平台运营 platform_users.id
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_invoice_tenant_status ON invoices (tenant_id, status);

-- ----- 4b. 收款（D5：V1 只手动登记，不做支付回调）-----
CREATE TABLE IF NOT EXISTS payments (
    id           BIGSERIAL PRIMARY KEY,
    invoice_id   BIGINT NOT NULL REFERENCES invoices(id),
    tenant_id    BIGINT NOT NULL,
    provider     VARCHAR(20) NOT NULL
                 CHECK (provider IN ('manual','wechat','alipay','stripe','bank')),
    provider_ref VARCHAR(200),
    amount_cents BIGINT NOT NULL,
    note         VARCHAR(300),
    paid_by      BIGINT,                        -- 平台运营 platform_users.id
    paid_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_invoice ON payments (invoice_id);

-- ----- 5. 权限点 sys:billing:read（挂 users 模块下，与其它 sys:* 对齐）-----
INSERT INTO permissions (code, module_code, resource, action, description)
VALUES ('sys:billing:read', 'users', 'billing', 'read', '查看本租户账单与用量')
ON CONFLICT (code) DO NOTHING;

-- admin / tenant_admin 授予 sys:billing:read
INSERT INTO role_permissions (role, permission_code)
SELECT 'admin', 'sys:billing:read' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role, permission_code)
SELECT 'tenant_admin', 'sys:billing:read' ON CONFLICT DO NOTHING;
