-- =============================================================================
-- P7 / B2.5：消息通知基建 + B2.4 定时任务配套表
-- 幂等，可重复执行。执行顺序放在 saas_p6_prompts.sql 之后。
--
-- 设计要点：
--   1. notifications 带 tenant_id，纳入 P6.1 的 RLS 兜底与 P6.3 导出/硬删表清单
--      （tenant-data.service 从 pg_catalog 现取带 tenant_id 的表，自动纳入）。
--   2. dedupe_key 唯一（部分索引）：同一事件重复投递只落一行，cron 重放/多实例并发安全。
--   3. user_id 为 NULL 表示**全租户广播**；已读按 (user, 广播) 分别记录，
--      这里用单表 + read_at 简化（V1 不做逐用户已读位图，见 docs/10 交付边界）。
--   4. channel 字段预留邮件/飞书/短信：站内信是默认且必须成功的通道，
--      外部通道由 NotificationChannel 接口扩展，不在这张表里建渠道配置。
-- =============================================================================

CREATE TABLE IF NOT EXISTS notifications (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    user_id         BIGINT,                              -- NULL = 全租户广播
    category        VARCHAR(40) NOT NULL,              -- renewal / approval / system / ...
    title           VARCHAR(200) NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    dedupe_key      VARCHAR(160),
    channel         VARCHAR(20) NOT NULL DEFAULT 'in_app',
    metadata        JSONB NOT NULL DEFAULT '{}',
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_dedupe
    ON notifications (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_notif_tenant_user_read
    ON notifications (tenant_id, user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_notif_tenant_created
    ON notifications (tenant_id, created_at DESC);

-- RLS 兜底：与 saas_p6_rls.sql 同口径（FOR ALL TO labelflow_app + GUC app.tenant_id）。
-- 新表必须显式补策略，否则重跑 p6_rls 之前这段时间它是隔离缺口。
-- 角色不存在时跳过（dev 老库可能还没建 labelflow_app），不影响建表。
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON public.notifications;
        CREATE POLICY tenant_isolation ON public.notifications
            AS PERMISSIVE FOR ALL TO labelflow_app
            USING  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
    END IF;
END
$$;
