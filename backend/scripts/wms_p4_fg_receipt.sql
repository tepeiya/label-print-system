-- =============================================================================
-- WMS 阶段四：成品入库（wms.fg）—— 2026-11-27
--
-- 为什么要有这两张表：
--   存量系统里成品库存没有任何业务来源：收货单只进原料，发料只出原料，
--   装箱只登记包装不改库存，发货却按成品库存扣减 —— 成品只能靠手工
--   /inventory/inbound 建账，工单产出的数量、批次、效期无处登记，
--   "这张工单产出了哪些箱、用的哪批原料"这条链断了。
--
--   本脚本补上凭证：成品入库单头 + 行。无 MES 时由 PDA 完工报工生成，
--   过账逐行调 InventoryGateway.increaseStock（批次/台账/幂等/质量初始状态照旧）。
--
-- 单据状态机：
--   CREATED ──过账──▶ POSTED
--      └──作废──▶ CANCELLED（已过账不能作废，只能退货或调整）
--   行状态：PENDING → POSTED / FAILED / CANCELLED
--
-- 幂等：全部 IF NOT EXISTS，可在存量库重复执行。
-- RLS：必须排在 saas_p6_rls.sql 之前（p6 按 information_schema 动态遍历带 tenant_id 的表）。
-- =============================================================================

BEGIN;

-- 1. 入库单头 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_fg_receipts (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT       NOT NULL,
    fg_no          VARCHAR(40)  NOT NULL,          -- FG-YYYYMMDD-NNNN，租户内唯一
    source_type    VARCHAR(16)  NOT NULL DEFAULT 'WORK_ORDER',  -- WORK_ORDER / MANUAL
    wo_no          VARCHAR(40),                    -- 来源工单（无 MES 时的完工口径）
    warehouse_id   BIGINT       NOT NULL REFERENCES warehouses(id),
    status         VARCHAR(12)  NOT NULL DEFAULT 'CREATED',
    remark         VARCHAR(300),
    created_by     BIGINT,
    posted_by      BIGINT,
    posted_at      TIMESTAMPTZ,
    cancelled_by   BIGINT,
    cancelled_at   TIMESTAMPTZ,
    cancel_reason  VARCHAR(200),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_fg_no ON wms_fg_receipts (tenant_id, fg_no);
CREATE INDEX IF NOT EXISTS idx_wms_fg_wo ON wms_fg_receipts (tenant_id, wo_no);
CREATE INDEX IF NOT EXISTS idx_wms_fg_status ON wms_fg_receipts (tenant_id, status);

-- 2. 入库单行 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_fg_receipt_lines (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT        NOT NULL,
    fg_id          BIGINT        NOT NULL REFERENCES wms_fg_receipts(id) ON DELETE CASCADE,
    line_no        INT           NOT NULL,
    material_id    BIGINT        NOT NULL REFERENCES materials(id),
    batch_no       VARCHAR(60),                    -- 成品生产批号（与标签 / UDI-PI 一致）
    qty            NUMERIC(14,3) NOT NULL CHECK (qty > 0),
    expiry_date    DATE,
    location_id    BIGINT REFERENCES warehouse_locations(id),
    status         VARCHAR(12)   NOT NULL DEFAULT 'PENDING',
    qc_status      VARCHAR(12),                    -- 建批次时的质量初始状态 PENDING/RELEASED
    qty_after      NUMERIC(14,3),
    error          VARCHAR(200),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wms_fg_line_doc ON wms_fg_receipt_lines (tenant_id, fg_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_fg_line_no ON wms_fg_receipt_lines (tenant_id, fg_id, line_no);

COMMIT;
