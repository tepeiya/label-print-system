-- =============================================================================
-- 库存调整单（① 手工出入库单据化）—— 2026-11-25
--
-- 为什么要有这张表：
--   console 原来提供「+ 入库 / − 出库」两个按钮，直接打 InventoryService.adjustStock，
--   只留一个自由文本「事由」。问题不在能不能写库，而在这笔账事后无法回答：
--   谁批的、什么单据、盘盈盘亏多少、和哪张调整单对应。PDA 收货/发料有单据，
--   这一条没有，等于同一本账里两种凭证。
--
-- 本脚本只加表，不动 stock_batches / stock_moves：
--   过账时仍调 InventoryService.adjustStock（FIFO/行锁/事务台账那套照旧），
--   单据号写进 stock_moves.reason 前缀（[SA-YYYYMMDD-0001] …），台账可反查单据。
--
-- 状态机：DRAFT → POSTED；DRAFT/PARTIAL → PARTIAL（部分行过账成功，失败行可重试）；CANCELLED 终态
-- 幂等：全部 IF NOT EXISTS，可在存量库重复执行。
-- RLS：本脚本必须排在 saas_p6_rls.sql 之前（p6 按 information_schema 动态遍历带 tenant_id 的表）。
-- =============================================================================

BEGIN;

-- 1. 调整单头 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_adjustments (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT       NOT NULL,
    adjust_no      VARCHAR(40)  NOT NULL,          -- SA-YYYYMMDD-NNNN，租户内唯一
    adjust_type    VARCHAR(16)  NOT NULL DEFAULT 'GAIN',
    warehouse_id   BIGINT       NOT NULL REFERENCES warehouses(id),
    status         VARCHAR(12)  NOT NULL DEFAULT 'DRAFT',
    reason         VARCHAR(200) NOT NULL,          -- 必填：这次调整的业务事由（不再允许空）
    remark         VARCHAR(300),
    created_by     BIGINT,
    posted_by      BIGINT,
    posted_at      TIMESTAMPTZ,
    cancelled_by   BIGINT,
    cancelled_at   TIMESTAMPTZ,
    cancel_reason  VARCHAR(200),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT ck_stock_adj_type   CHECK (adjust_type IN ('GAIN', 'LOSS', 'DAMAGE', 'RETURN', 'OTHER')),
    CONSTRAINT ck_stock_adj_status CHECK (status IN ('DRAFT', 'PARTIAL', 'POSTED', 'CANCELLED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_adj_no ON stock_adjustments (tenant_id, adjust_no);
CREATE INDEX IF NOT EXISTS ix_stock_adj_tenant_time ON stock_adjustments (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_stock_adj_tenant_status ON stock_adjustments (tenant_id, status);

-- 2. 调整单行 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_adjustment_lines (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT        NOT NULL,
    adjustment_id  BIGINT        NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
    line_no        INT           NOT NULL,
    material_id    BIGINT        NOT NULL REFERENCES materials(id),
    sku_code       VARCHAR(40)   NOT NULL,         -- 过账时直接喂 adjustStock，不必反查
    batch_no       VARCHAR(60),                    -- 空：入库自动建批次 / 出库按 FIFO
    location_id    BIGINT,
    qty_delta      NUMERIC(14,3) NOT NULL,         -- 带符号：盘盈为正、盘亏为负
    status         VARCHAR(12)   NOT NULL DEFAULT 'PENDING',
    qty_before     NUMERIC(14,3),
    qty_after      NUMERIC(14,3),
    move_no        VARCHAR(40),                    -- 预留：台账单号回填（当前台账按 reason 关联）
    error          VARCHAR(200),
    posted_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT ck_stock_adj_line_status CHECK (status IN ('PENDING', 'DONE', 'FAILED')),
    CONSTRAINT ck_stock_adj_line_qty    CHECK (qty_delta <> 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_adj_line ON stock_adjustment_lines (tenant_id, adjustment_id, line_no);
CREATE INDEX IF NOT EXISTS ix_stock_adj_line_doc ON stock_adjustment_lines (tenant_id, adjustment_id);

COMMIT;
