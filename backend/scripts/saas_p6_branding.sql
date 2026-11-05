-- =============================================================================
-- P6.4 白标（D6）：tenant_domains 补校验字段 + 权限点 sys:branding:manage
--
-- 设计口径（docs/11 §11.5.4 / D6「表结构现在预留，P6 实现域名校验与主题注入」）：
--   · tenant_domains 与 tenants.branding 在 P0 就建好了，本脚本只**补 P6 才需要的列**，
--     不重建表，老库直接跑；
--   · 一个域名只能属于一个租户（domain 唯一约束已存在），所以「加域名」天然是抢注 ——
--     必须靠 DNS TXT 校验证明域名归你，否则任何人都能把 login.某客户.com 指到自己租户。
--     这就是 verify_token / verified_at 的用途：**未 verified 的域名一律不参与 Host → 租户解析**。
--   · is_primary 只是「同一租户多域名时，导出/回复里优先展示哪个」，不影响解析（解析按 Host 精确匹配）。
--
-- 幂等：全部 IF NOT EXISTS / ON CONFLICT DO NOTHING，可重复执行。
-- ⚠️ 上生产前请把 TXT 记录前缀（_labelflow-verify）与品牌资源域名写进客户接入文档。
-- =============================================================================

BEGIN;

-- ----- 1. tenant_domains 补列 -----
ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS verify_token VARCHAR(64);
ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS verified_at  TIMESTAMPTZ;
ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS is_primary   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS created_by   BIGINT;

-- 域名长度/字符集护栏：防着手打一串 punycode+空格当「域名」绕过唯一性口径
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_domains_domain_format') THEN
        ALTER TABLE tenant_domains
            ADD CONSTRAINT tenant_domains_domain_format
            CHECK (domain ~ '^[a-z0-9]([a-z0-9.-]{1,198}[a-z0-9])$');
    END IF;
END
$$;

-- 按租户列域名（品牌设置页每次都要读）
CREATE INDEX IF NOT EXISTS ix_tenant_domains_tid ON tenant_domains (tenant_id);

-- ----- 2. 权限点 sys:branding:manage（模块归属沿用 users，与 sys:agent:* 一致）-----
INSERT INTO permissions (code, module_code, resource, action, description, name, is_high_risk) VALUES
  ('sys:branding:manage', 'users', 'branding', 'manage', '白标：品牌主题与自定义域名（D6）', '品牌与域名', TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('admin',        'sys:branding:manage'),
  ('tenant_admin', 'sys:branding:manage')
ON CONFLICT DO NOTHING;

-- manager / warehouse_keeper / purchaser / viewer 一律不给：白标改的是「登录页对外长相」，
-- 属于租户级运营配置，只归管理员。

-- ----- 3. 已存在的租户角色副本补授权（roles 表建在 saas_p0_roles.sql，逐租户一份）-----
-- 每租户的 tenant_admin 副本走 role_id，权限仍按 role 字符串匹配（PermissionGuard 读
-- role_permissions where role = <角色 code>），所以第 2 步的 INSERT 已经覆盖所有租户副本。
-- 这里只做一句自检：确认权限点存在，避免「代码上了、字典没种」这种静默 4032。
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'sys:branding:manage') THEN
        RAISE EXCEPTION 'sys:branding:manage 未进权限字典';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE permission_code = 'sys:branding:manage') THEN
        RAISE EXCEPTION 'sys:branding:manage 未授予 admin / tenant_admin';
    END IF;
END
$$;

-- ----- 4. 汇总输出（跑完肉眼确认用）-----
DO $$
DECLARE
    n_cols   INT;
    n_dom    INT;
BEGIN
    SELECT count(*) INTO n_cols FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenant_domains'
        AND column_name IN ('verify_token','verified_at','is_primary','created_by');
    SELECT count(*) INTO n_dom FROM tenant_domains;
    RAISE NOTICE '白标 DDL 就位：补列 %/4，现有域名 % 条（未 verified 的不参与解析）', n_cols, n_dom;
END
$$;

COMMIT;
