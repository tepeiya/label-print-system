-- =============================================================================
-- P9 打印路由 + 无打印机跳过状态（WMS 自动收货标签）
--
-- 1) print_printer_routes：逻辑路由（receipt-station 等）→ 物理打印机
--    · 一个 route 可挂多台 printer，按 priority 升序取第一台（主备/多工位）
--    · 无映射时内部打印端点明确返回 skipped_no_printer，不再"无打印机也 success"
-- 2) print_jobs.status 加 skipped_no_printer（原 CHECK 只有 6 个值）
--
-- 幂等：可重复执行（IF NOT EXISTS / DROP CONSTRAINT IF EXISTS）
-- =============================================================================

BEGIN;

-- 1) 路由表 ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_printer_routes (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL,                    -- 租户隔离字段
    route_code  VARCHAR(80) NOT NULL,               -- 逻辑路由名（receipt-station / shipping-station …）
    printer_id  BIGINT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    priority    INTEGER NOT NULL DEFAULT 10,        -- 越小越优先
    remark      VARCHAR(200),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_print_routes_tenant_route_printer
    ON print_printer_routes (tenant_id, route_code, printer_id);
CREATE INDEX IF NOT EXISTS ix_print_routes_tenant_route
    ON print_printer_routes (tenant_id, route_code, enabled, priority);

-- 2) 打印任务状态：允许 skipped_no_printer -----------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_status_check') THEN
        ALTER TABLE print_jobs DROP CONSTRAINT print_jobs_status_check;
    END IF;
    ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_status_check
        CHECK (status IN ('queued','printing','success','partial','failed','canceled','skipped_no_printer'));
END
$$;

COMMIT;
