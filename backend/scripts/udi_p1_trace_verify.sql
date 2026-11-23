-- =============================================================================
-- UDI 追溯表结构自检（迁移后执行；只读，不改数据）
-- 用法：psql "$DB_URL" -f backend/scripts/udi_p1_trace_verify.sql
-- 目的：在没有应用层的环境（或上线前）用 SQL 直接确认 U2 的 7 道门里的 G1/G2/G3 前提
-- =============================================================================

-- 1) 三张表是否都在
SELECT 'G1_tables' AS gate,
       string_agg(table_name, ', ' ORDER BY table_name) AS detail,
       (count(*) = 3) AS pass
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('udi_units', 'udi_packages', 'udi_events');

-- 2) 唯一约束（udi_key / sscc / idem_key）
SELECT 'G3_unique_constraints' AS gate, conname, contype
FROM pg_constraint
WHERE conrelid IN ('public.udi_units'::regclass, 'public.udi_packages'::regclass, 'public.udi_events'::regclass)
  AND contype = 'u'
ORDER BY conname;

-- 3) CHECK 约束（状态与事件类型白名单）
SELECT 'G3_check_constraints' AS gate, conname
FROM pg_constraint
WHERE conrelid IN ('public.udi_units'::regclass, 'public.udi_events'::regclass, 'public.udi_packages'::regclass)
  AND contype = 'c'
ORDER BY conname;

-- 4) 关键索引
SELECT 'G3_indexes' AS gate, tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public' AND tablename LIKE 'udi\_%'
ORDER BY tablename, indexname;

-- 5) RLS 策略（重跑 saas_p6_rls.sql 后应为 3 行）
SELECT 'G2_rls' AS gate,
       c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       count(p.polname) AS policies
FROM pg_class c
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('udi_units', 'udi_packages', 'udi_events')
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;

-- 6) 触发器（updated_at 自动维护）
SELECT 'G1_trigger' AS gate, tgname
FROM pg_trigger
WHERE tgrelid = 'public.udi_units'::regclass AND NOT tgisinternal;
