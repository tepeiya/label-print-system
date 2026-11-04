-- =============================================================================
-- SaaS P0 底座补齐：租户生命周期 + roles/role_id 两步迁移 + data_scopes
--                   + feature_flags（D7）+ tenant_domains（D6 预留）
--                   + external_mcp_servers（D10 仅建表，不实现）
--
-- 依赖顺序（实测踩过坑，务必按此顺序）：
--   docs/03-database.sql → backend/scripts/seed.sql → backend/scripts/saas_p0.sql → 本脚本
--   原因：saas_p0.sql 里「默认订阅 + tenant_modules 展开」依赖 tenants.code='default' 已存在，
--   而 default 租户是 seed.sql 建的；顺序错了会得到 subscriptions=0 / tenant_modules=0。
--   另注：03-database.sql 没有 IF NOT EXISTS，同一库重跑会报 48 个 relation already exists，重建需先 drop schema。
-- 幂等：本脚本全部 IF NOT EXISTS / ON CONFLICT / WHERE NOT EXISTS，PG14 实测连跑 3 遍 0 error、行数零漂移
--
-- 与 docs/11 §11.5.2 的两处有意偏差（已在 docs/10 §10.15 说明）：
--   1) tenants.status 保持 SMALLINT（1 启用 / 0 禁用），不推翻 auth.service 的 `status !== 1` 判定；
--      订阅生命周期由 subscriptions.status 表达，硬删时间由 tenants.canceled_at 表达（D12）。
--   2) role_permissions 仍以 role 字符串为主键（与 user_roles.role 一致），
--      另加 role_id 可空列，§11.12.3 兼容期结束后再切主键。
-- =============================================================================

-- ----- 1. tenants 扩展（§11.5.2）-----
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS type          VARCHAR(20) NOT NULL DEFAULT 'shared' CHECK (type IN ('shared','dedicated'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_id       BIGINT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS seat_limit    INTEGER NOT NULL DEFAULT 5;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branding      JSONB NOT NULL DEFAULT '{}';
-- D12：canceled 后 90 天硬删，删除任务读此字段
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canceled_at   TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_tenants_canceled ON tenants (canceled_at) WHERE canceled_at IS NOT NULL;

-- ----- 2. 模块目录：补 §11.16 的加购模块 + 依赖关系 + 试用天数 -----
ALTER TABLE modules ADD COLUMN IF NOT EXISTS depends_on TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE modules ADD COLUMN IF NOT EXISTS trial_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS status     SMALLINT NOT NULL DEFAULT 1;

INSERT INTO modules (code, name, description, icon, sort_order, is_core, depends_on) VALUES
  ('inventory',  '库存管理',     '物料库存、批次效期、盘点与调拨',           '📦',  90, FALSE, '{masterdata}'),
  ('masterdata', '基础资料',     '物料 / 仓库 / 供应商主数据',               '🗂️', 100, TRUE,  '{}'),
  ('bom',        '齐套率',       'BOM 维护、齐套率与缺料明细',               '🧩', 110, FALSE, '{inventory}'),
  ('alert',      '呆滞/效期预警','呆滞料与效期预警、预警规则配置',           '🔔', 120, FALSE, '{inventory}'),
  ('agent',      '智能体接入',   'MCP 工具与 Agent Token（PRO 起，D8）',     '🤖', 130, FALSE, '{print}')
ON CONFLICT (code) DO NOTHING;

-- PRO 套餐加 agent（D8：MCP 对外售卖是 PRO 卖点）；inventory/bom/alert 为加购模块，不进套餐（D1）
INSERT INTO plan_modules (plan_id, module_code)
SELECT p.id, m.code FROM plans p, modules m
WHERE p.code IN ('PRO','ENTERPRISE') AND m.code = 'agent'
ON CONFLICT DO NOTHING;

-- ----- 2.5 模块来源放开 'addon'（D1：套餐外的单模块加购；saas_p0.sql 的 CHECK 里没有它）-----
ALTER TABLE tenant_modules DROP CONSTRAINT IF EXISTS tenant_modules_source_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_source_check
  CHECK (source IN ('plan','purchase','addon','trial','gift','manual'));

-- ----- 3. permissions 字典补列（§11.4.2 名称 + 高危标记）-----
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS name         VARCHAR(80) NOT NULL DEFAULT '';
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS is_high_risk BOOLEAN NOT NULL DEFAULT false;

INSERT INTO permissions (code, module_code, resource, action, description, name, is_high_risk) VALUES
  ('print:job:submit',    'print',   'job',      'submit',    '提交打印任务',                 '提交打印',   TRUE),
  ('print:job:cancel',    'print',   'job',      'cancel',    '取消 / 重打打印任务',           '取消打印',   FALSE),
  ('print:printer:manage','print',   'printer',  'manage',    '打印机增删改与校准',            '打印机管理', FALSE),
  ('sys:agent:manage',    'users',   'agent',    'manage',    'Agent 与 Token 管理（P4）',     'Agent 管理', TRUE),
  ('masterdata:item:read','masterdata','item',   'read',      '查物料主数据',                  '查主数据',   FALSE),
  ('masterdata:item:write','masterdata','item',  'write',     '维护物料主数据',                '维护主数据', TRUE),
  ('inventory:stock:read','inventory', 'stock',  'read',      '查库存',                        '查库存',     FALSE),
  ('inventory:stock:adjust','inventory','stock', 'adjust',    '库存调整 / 盘点',               '库存调整',   TRUE),
  ('inventory:batch:read','inventory', 'batch',  'read',      '查批次与效期',                  '查批次',     FALSE),
  ('bom:kit:read',        'bom',       'kit',    'read',      '查齐套率',                      '查齐套',     FALSE),
  ('bom:bom:write',       'bom',       'bom',    'write',     '维护 BOM',                      '维护 BOM',   TRUE),
  ('alert:event:read',    'alert',     'event',  'read',      '查预警',                        '查预警',     FALSE),
  ('alert:rule:configure','alert',     'rule',   'configure', '配置预警规则',                  '预警规则',   TRUE)
ON CONFLICT (code) DO NOTHING;

-- 存量权限点回填名称 / 高危标记
UPDATE permissions SET name = COALESCE(NULLIF(name,''), description, code) WHERE name = '';
UPDATE permissions SET is_high_risk = TRUE
WHERE action IN ('submit','manage','restore','configure')
   OR code IN ('sys:user:manage','ai:models:manage','datasource:write','backup:restore','audit:export');

-- ----- 4. roles 表 + 内置角色模板 + 每租户复制（§11.12.2 第 1/2 步）-----
-- 先放宽 role_permissions.role 的 CHECK：saas_p0.sql 里只允许 4 个旧角色，
-- 本脚本要写入 tenant_admin / manager / warehouse_keeper / purchaser
-- （user_roles.role 的 CHECK 不动：兼容期仍写旧字符串，新角色走 role_id）
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check CHECK (
  role IN ('admin','operator','sql','viewer','tenant_admin','manager','warehouse_keeper','purchaser')
);

CREATE TABLE IF NOT EXISTS roles (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  BIGINT,                                   -- NULL = 系统内置模板角色
    code       VARCHAR(40) NOT NULL,
    name       VARCHAR(60) NOT NULL,
    is_system  BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_role_tenant_code UNIQUE (tenant_id, code)
);

-- 模板角色 tenant_id IS NULL，PG14 的 UNIQUE 把 NULL 视为互不相等，
-- 因此额外用 partial unique index 保证幂等
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_system_code ON roles (code) WHERE tenant_id IS NULL;

INSERT INTO roles (tenant_id, code, name, is_system)
SELECT NULL, v.code, v.name, TRUE FROM (VALUES
  ('tenant_admin',     '租户管理员'),
  ('manager',          '主管'),
  ('operator',         '操作员'),
  ('warehouse_keeper', '仓管'),
  ('purchaser',        '采购'),
  ('viewer',           '只读')
) AS v(code, name)
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.tenant_id IS NULL AND r.code = v.code
);

-- 为每个租户复制一份（便于后续自定义角色）
INSERT INTO roles (tenant_id, code, name, is_system)
SELECT t.id, r.code, r.name, TRUE
FROM tenants t CROSS JOIN roles r
WHERE r.tenant_id IS NULL
ON CONFLICT (tenant_id, code) DO NOTHING;

-- ----- 5. user_roles.role_id（§11.12.2 第 3 步，兼容期保留 role 字符串）-----
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS role_id BIGINT;
CREATE INDEX IF NOT EXISTS ix_user_roles_role ON user_roles (role_id);

UPDATE user_roles ur SET role_id = r.id
FROM roles r
WHERE r.tenant_id = ur.tenant_id
  AND r.tenant_id IS NOT NULL
  AND ur.role_id IS NULL
  AND r.code = CASE ur.role
        WHEN 'admin'    THEN 'tenant_admin'
        WHEN 'operator' THEN 'operator'
        WHEN 'sql'      THEN 'manager'      -- D11：sql 并入 manager
        WHEN 'viewer'   THEN 'viewer'
      END;

-- 校验：期望 0（§11.12.2 第 4 步）
-- SELECT COUNT(*) FROM user_roles WHERE role_id IS NULL;

-- ----- 6. role_permissions 加 role_id 可空列 + 新角色码的权限展开 -----
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS role_id BIGINT;

-- tenant_admin：全权限
INSERT INTO role_permissions (role, permission_code)
SELECT 'tenant_admin', code FROM permissions
ON CONFLICT DO NOTHING;

-- manager：operator 全集 + 数据源（原 sql 角色能力并入，D11）+ 新模块只读
INSERT INTO role_permissions (role, permission_code)
SELECT 'manager', x.code FROM (
  SELECT permission_code AS code FROM role_permissions WHERE role IN ('operator', 'sql')
  UNION
  SELECT code FROM permissions
  WHERE module_code IN ('inventory', 'bom', 'alert', 'masterdata') AND action = 'read'
) x
ON CONFLICT DO NOTHING;

-- warehouse_keeper：库存读写 + 主数据 + 打印只读
INSERT INTO role_permissions (role, permission_code) VALUES
  ('warehouse_keeper','print:job:read'),
  ('warehouse_keeper','template:read'),
  ('warehouse_keeper','masterdata:item:read'),('warehouse_keeper','masterdata:item:write'),
  ('warehouse_keeper','inventory:stock:read'),('warehouse_keeper','inventory:stock:adjust'),
  ('warehouse_keeper','inventory:batch:read'),
  ('warehouse_keeper','alert:event:read')
ON CONFLICT DO NOTHING;

-- purchaser：齐套 / 缺料 / 主数据读
INSERT INTO role_permissions (role, permission_code) VALUES
  ('purchaser','print:job:read'),
  ('purchaser','template:read'),
  ('purchaser','masterdata:item:read'),
  ('purchaser','inventory:stock:read'),('purchaser','inventory:batch:read'),
  ('purchaser','bom:kit:read'),
  ('purchaser','alert:event:read')
ON CONFLICT DO NOTHING;

-- viewer：只读补新模块（§11.11.1 要求 viewer 只有 *:read）
INSERT INTO role_permissions (role, permission_code) VALUES
  ('viewer','masterdata:item:read'),
  ('viewer','inventory:stock:read'),('viewer','inventory:batch:read'),
  ('viewer','bom:kit:read'),
  ('viewer','alert:event:read')
ON CONFLICT DO NOTHING;

-- 回填 role_permissions.role_id（兼容期结束后主键切到 role_id）
UPDATE role_permissions rp SET role_id = r.id
FROM roles r
WHERE r.tenant_id IS NULL AND r.code = rp.role AND rp.role_id IS NULL;

-- ----- 7. data_scopes（L3 数据范围，§11.4.5）-----
CREATE TABLE IF NOT EXISTS data_scopes (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,
    subject_type VARCHAR(10) NOT NULL CHECK (subject_type IN ('user','role','agent')),
    subject_id   BIGINT NOT NULL,
    scope_type   VARCHAR(20) NOT NULL CHECK (scope_type IN ('all','dept','warehouse','self')),
    scope_value  VARCHAR(60),
    CONSTRAINT uq_datascope UNIQUE (tenant_id, subject_type, subject_id, scope_type, scope_value)
);
CREATE INDEX IF NOT EXISTS ix_datascope_subject ON data_scopes (tenant_id, subject_type, subject_id);

-- ----- 8. feature_flags（D7：agent.print.submit 必须 P0 建好且默认关闭）-----
CREATE TABLE IF NOT EXISTS feature_flags (
    tenant_id BIGINT NOT NULL,
    key       VARCHAR(60) NOT NULL,
    enabled   BOOLEAN NOT NULL DEFAULT false,
    rollout   JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (tenant_id, key)
);

INSERT INTO feature_flags (tenant_id, key, enabled)
SELECT t.id, 'agent.print.submit', FALSE FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO feature_flags (tenant_id, key, enabled)
SELECT t.id, 'ai.vision', TRUE FROM tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ----- 9. tenant_domains（D6 白标，P0 预留）-----
CREATE TABLE IF NOT EXISTS tenant_domains (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  BIGINT NOT NULL,
    domain     VARCHAR(200) NOT NULL UNIQUE,
    verified   BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----- 10. external_mcp_servers（D10：P0 仅建表，P6 之后才实现）-----
CREATE TABLE IF NOT EXISTS external_mcp_servers (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    name          VARCHAR(80) NOT NULL,
    endpoint      TEXT NOT NULL,
    auth_type     VARCHAR(20) NOT NULL DEFAULT 'none',
    auth_secret   TEXT,                       -- AES-256-GCM，复用 sql-crypto.ts
    allowed_tools TEXT[] NOT NULL DEFAULT '{}',
    status        SMALLINT NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----- 11. 序列复位（seed.sql 用了显式 id，不修 nextval 会撞主键）-----
-- 症状：POST /platform/tenants 报 duplicate key "tenants_pkey"（Key (id)=(1) already exists），
-- 因为 seed.sql 是 INSERT INTO tenants (id, ...) VALUES (1, ...)，序列还停在 1。
-- 同理 users / user_roles。这里把 P0 相关表的序列统一推到 max(id)+1，幂等。
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT s.relname AS seq, c.relname AS tbl, a.attname AS col
    FROM pg_class s
    JOIN pg_depend d   ON d.objid = s.oid AND d.deptype = 'a'
    JOIN pg_class c    ON c.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S'
      AND c.relname IN ('tenants','users','user_roles','roles','subscriptions',
                        'tenant_modules','plans','data_scopes')
  LOOP
    EXECUTE format('SELECT setval(%L, (SELECT COALESCE(MAX(%I), 0) + 1 FROM %I), false)',
                   r.seq, r.col, r.tbl);
  END LOOP;
END $$;

-- ----- 12. 兼容期补授权：P0 加权限点装饰器时不得削弱旧角色 -----
-- 背景：给 print / printers 路由挂 @RequirePermission 后，
--   operator 旧行为里「能取消任务」「能管打印机」必须继续可用，否则会回归。
--   viewer / sql 由 §11.12.1 的 sql→manager 双码机制兜住，这里只补 operator 与 manager。
INSERT INTO role_permissions (role, permission_code)
SELECT r.code, x.code FROM (VALUES ('operator'), ('manager')) AS r(code)
CROSS JOIN (VALUES ('print:job:cancel'), ('print:printer:manage')) AS x(code)
WHERE EXISTS (SELECT 1 FROM roles ro WHERE ro.code = r.code)
ON CONFLICT DO NOTHING;

-- ----- 13. schema 漂移修复：tenant_backups.data（P2 实体有、03-database.sql 漏了）-----
-- 症状：GET /backups → 500 column TenantBackup.data does not exist
ALTER TABLE tenant_backups ADD COLUMN IF NOT EXISTS data BYTEA;
