-- =============================================================================
-- P6.2 独立库租户（D2）阶段 A：tenants.data_source_key + 形状约束
--
-- 这一阶段只做「能不能把租户指到一个独立库」的**标识与校验**，不做开通编排：
--   · 独立库的 DSN 永不落库（只进进程内存：env DB_DEDICATED_DSNS 或 POST /platform/datasources）；
--   · 表里只留 data_source_key 这种不含凭据的标识，方便平台侧路由与诊断。
--
-- 形状约束（写进 CHECK，靠代码自律迟早漏）：
--   shared    → data_source_key 为空或 'default'
--   dedicated → data_source_key 非空且不是 'default'
-- 唯一索引：一个独立库只服务一个租户（库里有且只有该租户的一行 tenants），
-- 两个租户共用一个 key 意味着「硬删 A 会顺手删掉 B」，必须在库里就拦死。
--
-- 可重复执行；缺列/缺约束都会自检报错，不会静默过。
-- =============================================================================
BEGIN;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS data_source_key VARCHAR(64);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tenants_data_source_key_shape'
    ) THEN
        ALTER TABLE tenants
            ADD CONSTRAINT tenants_data_source_key_shape CHECK (
                (type = 'shared'    AND (data_source_key IS NULL OR data_source_key = 'default'))
             OR (type = 'dedicated' AND data_source_key IS NOT NULL AND data_source_key <> 'default')
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tenants_data_source_key_format'
    ) THEN
        ALTER TABLE tenants
            ADD CONSTRAINT tenants_data_source_key_format CHECK (
                data_source_key IS NULL OR data_source_key ~ '^[a-z][a-z0-9-]{1,63}$'
            );
    END IF;
END $$;

-- 一个 key 只属于一个租户（NULL 不参与唯一性，共享库租户不受影响）
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_data_source_key
    ON tenants (data_source_key)
    WHERE data_source_key IS NOT NULL;

-- 诊断用：按类型看有几家独立库租户
CREATE INDEX IF NOT EXISTS ix_tenants_type ON tenants (type);

-- ---------------------------------------------------------------- 自检
DO $$
DECLARE
    n_col  INT;
    n_cons INT;
    n_idx  INT;
    n_ded  INT;
BEGIN
    SELECT count(*) INTO n_col FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'data_source_key';
    SELECT count(*) INTO n_cons FROM pg_constraint
     WHERE conname IN ('tenants_data_source_key_shape', 'tenants_data_source_key_format');
    SELECT count(*) INTO n_idx FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'ux_tenants_data_source_key';
    SELECT count(*) INTO n_ded FROM tenants WHERE type = 'dedicated';

    IF n_col <> 1 OR n_cons <> 2 OR n_idx <> 1 THEN
        RAISE EXCEPTION '独立库 DDL 未就位：列 % / 约束 % / 唯一索引 %（期望 1/2/1）', n_col, n_cons, n_idx;
    END IF;

    RAISE NOTICE '独立库 DDL 就位：data_source_key 已补、2 个 CHECK + 1 个唯一索引；当前 dedicated 租户 % 家', n_ded;
END $$;

COMMIT;
