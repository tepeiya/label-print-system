-- =============================================================================
-- P6 RLS 兜底 DDL（docs/11 §11.2「应用层强制 tenant_id + PostgreSQL RLS 兜底」/ D3 / docs/10 §10.22）
--
-- 做什么：给**所有带 tenant_id 的业务表**开行级安全，策略按会话变量 app.tenant_id 过滤；
--         并把「能连业务表但不该跨租户」的角色 labelflow_app 与之绑定。
-- 不做什么（重要，别误解成「全系统已 RLS 隔离」）：
--   · 主链路仍用表 owner 角色（dev 里是超管 labelflow）连库，owner 与超管**默认绕过 RLS**，
--     所以 P6 的 RLS 是「第二道防线」，只对 labelflow_app 这个非 owner 角色生效；
--   · 要把主链路切到 labelflow_app，必须先让每个请求固定一条连接并在事务里打 GUC
--     （TenantDataSourceManager.withTenantScope 已提供该能力），否则连接池会串租户；
--   · 平台级元数据表（tenants / modules / plans / plan_modules / permissions / role_permissions）
--     本身没有 tenant_id，不给它们加策略，只授 SELECT —— 登录按 code 查租户、菜单按套餐解析，
--     天然跨租户，靠 RLS 挡不住也不该挡。
--
-- 幂等：可重复执行（DROP POLICY IF EXISTS + CREATE POLICY；角色用 DO 块判存）。
-- ⚠️ 口令 labelflow_app / labelflow_platform 是**沙盒 dev 用的弱口令**（与 DB_PASS=labelflow 同级别）。
--    上生产必须改掉，并走密钥管理注入，不要沿用本文件里的字面值。
-- =============================================================================

BEGIN;

-- 0. 角色 -------------------------------------------------------------------
-- labelflow_app：业务数据专用角色，**没有** BYPASSRLS、不是 owner、不是超管 → 受策略约束。
-- labelflow_platform：平台后台跨租户运维专用角色，带 BYPASSRLS（导出/对账/统计要用）。
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        CREATE ROLE labelflow_app LOGIN PASSWORD 'labelflow_app';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_platform') THEN
        CREATE ROLE labelflow_platform LOGIN PASSWORD 'labelflow_platform' BYPASSRLS;
    END IF;
END
$$;

-- 重复执行时也把属性钉回预期值（防止有人手工改成 superuser 把防线抹平）
ALTER ROLE labelflow_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE labelflow_platform NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

-- 1. 授权 -------------------------------------------------------------------
-- 1a. 业务表（带 tenant_id 的 + 无 tenant_id 但要跟着父表走的家生子，如 bom_items）：
--     labelflow_app 拿 CRUD（受策略约束），labelflow_platform 同样拿 CRUD（BYPASSRLS，跨租户运维）。
--     平台表（platform_users / platform_audit_logs）**不授给 app 角色**。
GRANT USAGE ON SCHEMA public TO labelflow_app, labelflow_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO labelflow_app, labelflow_platform;

DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT c.table_name::text AS table_name
        FROM information_schema.columns c
        JOIN information_schema.tables  t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
        UNION
        SELECT 'bom_items'::text      -- 家生子：没有 tenant_id，靠 2b 的父表策略隔离，授权要显式补
    LOOP
        IF to_regclass(format('public.%I', r.table_name)) IS NOT NULL THEN
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO labelflow_app', r.table_name);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO labelflow_platform', r.table_name);
        END IF;
    END LOOP;
END
$$;

-- 1b. 平台级元数据：两个角色都只读（登录 / 套餐 / 菜单解析需要）
GRANT SELECT ON public.tenants, public.modules, public.plans,
                  public.plan_modules, public.permissions, public.role_permissions
    TO labelflow_app, labelflow_platform;

-- 1c. 平台账号与平台审计：只给平台角色
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_users, public.platform_audit_logs
    TO labelflow_platform;

-- 2. RLS 策略 ---------------------------------------------------------------
-- 口径：未设置 app.tenant_id 时 nullif(...,'') → NULL，比较结果 NULL → **一行都看不到、也写不进**。
-- 这是故意的 fail-closed：忘了打 GUC 的查询会静默返回空集（可用 p6-rls-smoke.sh 断言），
-- 而不是「退回全表可见」。
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables  t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
        EXECUTE format($pol$
            CREATE POLICY tenant_isolation ON public.%I
                AS PERMISSIVE FOR ALL TO labelflow_app
                USING  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
                WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
            $pol$, r.table_name);
    END LOOP;
END
$$;

-- 2b. 子表没有 tenant_id 的，按父表归属判定：bom_items → boms.tenant_id
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'bom_items' AND column_name = 'bom_id') THEN
        ALTER TABLE public.bom_items ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON public.bom_items;
        CREATE POLICY tenant_isolation ON public.bom_items
            AS PERMISSIVE FOR ALL TO labelflow_app
            USING (EXISTS (SELECT 1 FROM public.boms b
                            WHERE b.id = bom_items.bom_id
                              AND b.tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint))
            WITH CHECK (EXISTS (SELECT 1 FROM public.boms b
                            WHERE b.id = bom_items.bom_id
                              AND b.tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint));
    END IF;
END
$$;

-- 2c. 防御纵深检查：任何带 tenant_id 却没挂上策略的表（漏建/新建未跑本脚本）直接让脚本失败，
--     避免「以为隔离了其实没有」。
DO $$
DECLARE r RECORD; n INT;
BEGIN
    FOR r IN
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables  t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
    LOOP
        SELECT count(*) INTO n FROM pg_policies
        WHERE schemaname = 'public' AND tablename = r.table_name AND policyname = 'tenant_isolation';
        IF n = 0 THEN
            RAISE EXCEPTION '表 % 缺少 tenant_isolation 策略，RLS 兜底不成立', r.table_name;
        END IF;
    END LOOP;
END
$$;

COMMIT;

-- 输出一个执行摘要，方便 CI / 验收脚本 grep
SELECT 'rls_tables' AS metric, count(DISTINCT tablename)::text AS value
FROM pg_policies WHERE policyname = 'tenant_isolation' AND schemaname = 'public'
UNION ALL
SELECT 'app_can_bypass', (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'labelflow_app')::text
UNION ALL
SELECT 'platform_can_bypass', (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'labelflow_platform')::text;
