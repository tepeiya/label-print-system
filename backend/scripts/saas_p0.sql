-- =============================================================================
-- SaaS P0 扩展 DDL —— 平台模块/套餐/订阅 + 权限字典 + role_permissions
-- 全部放在 public schema，简化查询（单租户迁移时可再拆 platform schema）
-- =============================================================================

-- ----- 模块目录 -----
CREATE TABLE IF NOT EXISTS modules (
  code          VARCHAR(40) PRIMARY KEY,
  name          VARCHAR(80) NOT NULL,
  description   VARCHAR(300),
  icon          VARCHAR(40),
  sort_order    INT NOT NULL DEFAULT 0,
  is_core       BOOLEAN NOT NULL DEFAULT FALSE,   -- core 模块 BASIC 套餐必含
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----- 套餐 -----
CREATE TABLE IF NOT EXISTS plans (
  id          BIGSERIAL PRIMARY KEY,
  code        VARCHAR(40) NOT NULL UNIQUE,   -- BASIC / PRO / ENTERPRISE
  name        VARCHAR(80) NOT NULL,
  description VARCHAR(500),
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----- 套餐-模块关联 -----
CREATE TABLE IF NOT EXISTS plan_modules (
  plan_id     BIGINT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  module_code VARCHAR(40) NOT NULL REFERENCES modules(code) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, module_code)
);

-- ----- 订阅（租户当前激活的套餐）-----
CREATE TABLE IF NOT EXISTS subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL,
  plan_id         BIGINT NOT NULL REFERENCES plans(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('trial','active','canceled','expired')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, status)   -- 一个租户同一时刻只能有一个 active/trial 订阅
);
CREATE INDEX IF NOT EXISTS ix_sub_tenant_status ON subscriptions (tenant_id, status);

-- ----- 租户实际开通的模块 -----
CREATE TABLE IF NOT EXISTS tenant_modules (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL,
  module_code VARCHAR(40) NOT NULL REFERENCES modules(code) ON DELETE CASCADE,
  status      VARCHAR(20) NOT NULL DEFAULT 'active'
              CHECK (status IN ('trial','active','expired','disabled')),
  source      VARCHAR(20) NOT NULL DEFAULT 'plan'
              CHECK (source IN ('plan','purchase','trial','gift','manual')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, module_code)
);
CREATE INDEX IF NOT EXISTS ix_tmod_tenant_status ON tenant_modules (tenant_id, status);

-- ----- 权限字典（code 形如 print:template:read）-----
CREATE TABLE IF NOT EXISTS permissions (
  code         VARCHAR(60) PRIMARY KEY,
  module_code  VARCHAR(40) NOT NULL REFERENCES modules(code),
  resource     VARCHAR(40) NOT NULL,
  action       VARCHAR(20) NOT NULL,
  description  VARCHAR(200),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----- 角色→权限（4 个固定角色 admin/operator/sql/viewer）-----
-- role VARCHAR 保持与现有 user_roles.role 一致，避免推翻现有 RBAC
CREATE TABLE IF NOT EXISTS role_permissions (
  role           VARCHAR(30) NOT NULL CHECK (role IN ('admin','operator','sql','viewer')),
  permission_code VARCHAR(60) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_code)
);

-- =============================================================================
-- 种子：模块目录 + BASIC/PRO/ENTERPRISE 套餐 + 权限字典 + 角色权限展开
-- =============================================================================

-- 模块
INSERT INTO modules (code, name, description, icon, sort_order, is_core) VALUES
  ('print',      '标签打印',   '模板设计、打印任务、多联拼版、流水线',        '🖨️', 10, TRUE),
  ('templates',  '模板管理',   '模板库、版本、收藏、分享',                    '📐', 20, TRUE),
  ('ai',         'AI 模板生成','图片→模板、透视矫正、单元素重算、文本生模板', '🤖', 30, TRUE),
  ('users',      '用户与角色', '用户管理、角色分配、重置密码',                '👥', 40, FALSE),
  ('serial',     '流水号',     '条码流水号、分段、批量分配',                  '🔢', 50, TRUE),
  ('datasource', '数据源',     'Excel / SQL 数据源，模板变量填充',            '📊', 60, FALSE),
  ('backup',     '备份恢复',   '整租户备份与恢复',                           '💾', 70, FALSE),
  ('audit',      '审计日志',   '操作日志查看与导出',                          '📜', 80, FALSE)
ON CONFLICT DO NOTHING;

-- 套餐
INSERT INTO plans (code, name, description, sort_order) VALUES
  ('BASIC',      '基础版',   '单租户、基础打印与模板能力、AI 生成上限每月 50 次', 1),
  ('PRO',        '专业版',   '加 AI 高级功能、数据源、备份恢复、审计',            2),
  ('ENTERPRISE', '企业版',   '自定义域名、SLA、专属 Agent 工具链',                3)
ON CONFLICT (code) DO NOTHING;

-- 套餐-模块
-- BASIC：core 模块（print/templates/ai/serial）+ 基础 users
INSERT INTO plan_modules (plan_id, module_code)
SELECT p.id, m.code FROM plans p, modules m
WHERE p.code='BASIC' AND m.code IN ('print','templates','ai','serial','users')
ON CONFLICT DO NOTHING;

-- PRO：BASIC + datasource/backup/audit
INSERT INTO plan_modules (plan_id, module_code)
SELECT p.id, m.code FROM plans p, modules m
WHERE p.code='PRO' AND m.code IN ('print','templates','ai','serial','users','datasource','backup','audit')
ON CONFLICT DO NOTHING;

-- ENTERPRISE：全模块
INSERT INTO plan_modules (plan_id, module_code)
SELECT p.id, m.code FROM plans p, modules m
WHERE p.code='ENTERPRISE' AND m.code IN ('print','templates','ai','serial','users','datasource','backup','audit')
ON CONFLICT DO NOTHING;

-- 默认订阅：default 租户 → BASIC
INSERT INTO subscriptions (tenant_id, plan_id, status)
SELECT t.id, p.id, 'active' FROM tenants t, plans p WHERE t.code='default' AND p.code='BASIC'
ON CONFLICT DO NOTHING;

-- 展开 tenant_modules
INSERT INTO tenant_modules (tenant_id, module_code, status, source)
SELECT t.id, pm.module_code, 'active', 'plan'
FROM tenants t, subscriptions s, plan_modules pm
WHERE t.code='default' AND s.tenant_id=t.id AND s.status='active' AND pm.plan_id=s.plan_id
ON CONFLICT DO NOTHING;

-- 权限字典（展开所有模块 × 资源 × 动作）
INSERT INTO permissions (code, module_code, resource, action, description) VALUES
  -- print
  ('print:job:read',     'print', 'job',     'read',   '查看打印任务'),
  ('print:job:write',    'print', 'job',     'write',  '创建/取消打印任务'),
  ('print:stats:read',   'print', 'stats',   'read',   '查看打印统计仪表盘'),
  -- templates
  ('template:read',      'templates', 'template', 'read',  '查看/搜索/预览模板'),
  ('template:write',     'templates', 'template', 'write', '创建/编辑/删除模板'),
  ('template:favorite',  'templates', 'template', 'favorite', '收藏模板'),
  -- ai
  ('ai:generate',        'ai', 'template', 'generate',   'AI 图片→模板'),
  ('ai:regenerate',      'ai', 'element',  'regenerate', 'AI 单元素重算'),
  ('ai:text-to-template','ai', 'template', 'text-to-template', 'AI 文本→模板'),
  ('ai:rectify',         'ai', 'image',    'rectify',    'AI 透视矫正'),
  ('ai:models:manage',   'ai', 'models',   'manage',     'AI 模型配置管理'),
  -- users
  ('sys:user:read',      'users',   'user',  'read',   '查看用户列表'),
  ('sys:user:manage',    'users',   'user',  'manage', '增删改用户、角色、重置密码'),
  ('sys:user:self',      'users',   'user',  'self',   '编辑自己的 displayName/email'),
  -- serial
  ('serial:read',        'serial', 'sequence', 'read',  '查看流水号序列'),
  ('serial:write',       'serial', 'sequence', 'write', '创建/修改流水号序列'),
  -- datasource
  ('datasource:read',    'datasource', 'source', 'read',  '查看数据源列表'),
  ('datasource:write',   'datasource', 'source', 'write', '创建/上传/删除数据源 + SQL 执行'),
  -- backup
  ('backup:read',        'backup', 'backup', 'read',  '查看备份列表'),
  ('backup:write',       'backup', 'backup', 'write', '创建备份'),
  ('backup:restore',     'backup', 'backup', 'restore','恢复备份（危险操作）'),
  ('backup:download',    'backup', 'backup', 'download','下载备份文件'),
  -- audit
  ('audit:read',         'audit', 'log', 'read',   '查看审计日志'),
  ('audit:export',       'audit', 'log', 'export', '导出审计日志 CSV')
ON CONFLICT (code) DO NOTHING;

-- 角色→权限展开
-- admin：全权限
INSERT INTO role_permissions (role, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

-- operator：print + templates + ai（generate/rectify）+ serial + datasource(read only) + users(self)
INSERT INTO role_permissions (role, permission_code) VALUES
  ('operator','print:job:read'),('operator','print:job:write'),('operator','print:stats:read'),
  ('operator','template:read'),('operator','template:write'),('operator','template:favorite'),
  ('operator','ai:generate'),('operator','ai:regenerate'),('operator','ai:text-to-template'),('operator','ai:rectify'),
  ('operator','serial:read'),('operator','serial:write'),
  ('operator','datasource:read'),
  ('operator','sys:user:self')
ON CONFLICT DO NOTHING;

-- sql：datasource(read+write) + print(template read)
INSERT INTO role_permissions (role, permission_code) VALUES
  ('sql','datasource:read'),('sql','datasource:write'),
  ('sql','template:read')
ON CONFLICT DO NOTHING;

-- viewer：纯只读（print/template/serial/backup/audit 全 read）
INSERT INTO role_permissions (role, permission_code) VALUES
  ('viewer','print:job:read'),('viewer','print:stats:read'),
  ('viewer','template:read'),('viewer','template:favorite'),
  ('viewer','serial:read'),('viewer','datasource:read'),
  ('viewer','backup:read'),('viewer','audit:read')
ON CONFLICT DO NOTHING;
