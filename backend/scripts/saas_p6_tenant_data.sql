-- =============================================================================
-- P6 租户数据导出/硬删 DDL（docs/11 D12 保留期 / docs/10 §10.23）
--
-- 只干一件事：把 tenant_backups.kind 的 CHECK 从 (manual, scheduled) 扩到
-- 含平台合规动作产生的两类：
--   · export    —— 平台「租户数据导出」（POST /platform/tenants/:id/export）
--   · purge-pre —— 硬删前自动落的最后一份快照（POST /platform/tenants/:id/purge）
-- 不改语义、不动数据；可重复执行（先看定义里有没有 export，再决定要不要重建约束）。
-- =============================================================================

BEGIN;

DO $$
DECLARE def text;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
    WHERE conrelid = 'public.tenant_backups'::regclass AND conname = 'tenant_backups_kind_check';

    IF def IS NULL THEN
        -- 约束不存在（历史库或被删过）：直接建完整的
        ALTER TABLE public.tenant_backups
            ADD CONSTRAINT tenant_backups_kind_check
            CHECK (kind IN ('manual', 'scheduled', 'export', 'purge-pre'));
    ELSIF def NOT LIKE '%export%' THEN
        EXECUTE 'ALTER TABLE public.tenant_backups DROP CONSTRAINT tenant_backups_kind_check';
        ALTER TABLE public.tenant_backups
            ADD CONSTRAINT tenant_backups_kind_check
            CHECK (kind IN ('manual', 'scheduled', 'export', 'purge-pre'));
        RAISE NOTICE 'tenant_backups_kind_check 已扩展：+export / +purge-pre';
    ELSE
        RAISE NOTICE 'tenant_backups_kind_check 已包含 export，跳过';
    END IF;
END
$$;

-- 导出件按租户 + 类型查（平台后台列清单）——平台后台按 (租户, 类型) 列导出件要用它
CREATE INDEX IF NOT EXISTS ix_tenant_backups_tid_kind
    ON public.tenant_backups (tenant_id, kind);

COMMIT;

SELECT 'kind_check' AS metric, pg_get_constraintdef(oid) AS value
FROM pg_constraint WHERE conrelid='public.tenant_backups'::regclass AND conname='tenant_backups_kind_check';
