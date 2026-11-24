-- =============================================================================
-- WMS 阶段三：成品发运（wms.outbound）—— 2026-11-25
--
-- 为什么要有这两张表：
--   · 存量系统只有「库存扣减」动作（POST /inventory/outbound 直接打 adjustStock），
--     没有「发货单」这个业务对象：客户问「我那批货哪天发的、发的哪几个批次、
--     谁签收的」，系统答不出来；UDI 的 SHIPPED 状态也因此没有任何入口能产生。
--   · 本脚本给成品/半成品出库补上凭证：发货单头 + 行，先拣货（可改批次/库位），
--     再出库过账（逐行调 InventoryGateway.decreaseStock，FIFO/行锁/台账照旧），
--     过账时把行上的 UDI 码/托盘 SSCC 联动置 SHIPPED。
--
-- 本脚本只加表，不动 stock_batches / stock_moves：
--   单据号写进 stock_moves.reason 前缀（[SH-YYYYMMDD-0001] …），台账可反查单据。
--
-- 单据状态机：
--   CREATED ──拣货──▶ PICKING ──全部拣完──▶ PICKED ──过账──▶ SHIPPED ──签收──▶ SIGNED
--      └──────────────┴──────────────┴──作废──▶ CANCELLED（已出库的单不能作废，只能退货入库）
--
-- 幂等：全部 IF NOT EXISTS，可在存量库重复执行。
-- RLS：本脚本必须排在 saas_p6_rls.sql 之前（p6 按 information_schema 动态遍历带 tenant_id 的表）。
-- =============================================================================

BEGIN;

-- 1. 发货单头 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_shipments (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT       NOT NULL,
    shipment_no    VARCHAR(40)  NOT NULL,          -- SH-YYYYMMDD-NNNN，租户内唯一
    ship_type      VARCHAR(16)  NOT NULL DEFAULT 'SALES',
    warehouse_id   BIGINT       NOT NULL REFERENCES warehouses(id),
    customer_code  VARCHAR(60),                    -- 无客户主数据表，先存编码/名称；对接 ERP 时由 ERP 传
    customer_name  VARCHAR(120),
    ship_to        VARCHAR(300),                   -- 收货地址（打印发货单用）
    carrier        VARCHAR(80),                    -- 承运商
    tracking_no    VARCHAR(120),                   -- 运单号
    expected_date  DATE,                           -- 要求发货日
    status         VARCHAR(12)  NOT NULL DEFAULT 'CREATED',
    remark         VARCHAR(300),
    created_by     BIGINT,
    picked_at      TIMESTAMPTZ,
    shipped_by     BIGINT,
    shipped_at     TIMESTAMPTZ,
    signed_by      BIGINT,                         -- 操作人
    signed_receiver VARCHAR(80),                   -- 实际签收人（客户方姓名）
    signed_at      TIMESTAMPTZ,
    cancelled_by   BIGINT,
    cancelled_at   TIMESTAMPTZ,
    cancel_reason  VARCHAR(200),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT ck_wms_ship_type   CHECK (ship_type IN ('SALES', 'TRANSFER', 'SAMPLE', 'OTHER')),
    CONSTRAINT ck_wms_ship_status CHECK (status IN ('CREATED', 'PICKING', 'PICKED', 'SHIPPED', 'SIGNED', 'CANCELLED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_wms_ship_no ON wms_shipments (tenant_id, shipment_no);
CREATE INDEX IF NOT EXISTS ix_wms_ship_tenant_time ON wms_shipments (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_wms_ship_tenant_status ON wms_shipments (tenant_id, status);
CREATE INDEX IF NOT EXISTS ix_wms_ship_customer ON wms_shipments (tenant_id, customer_name);

-- 2. 发货单行 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wms_shipment_lines (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT        NOT NULL,
    shipment_id    BIGINT        NOT NULL REFERENCES wms_shipments(id) ON DELETE CASCADE,
    line_no        INT           NOT NULL,
    material_id    BIGINT        NOT NULL REFERENCES materials(id),
    sku_code       VARCHAR(40)   NOT NULL,         -- 过账时直接喂 Gateway，不必反查
    batch_no       VARCHAR(60),                    -- 拣货时可改；空则过账按 FIFO
    location_id    BIGINT,
    pack_sscc      VARCHAR(20),                    -- 托盘/箱码：出库时按包内层级联动 UDI
    udi_codes      JSONB,                          -- 单品 UDI 码数组：出库时逐个置 SHIPPED
    qty_plan       NUMERIC(14,3) NOT NULL,         -- 订单数量
    qty_picked     NUMERIC(14,3) NOT NULL DEFAULT 0,
    qty_shipped    NUMERIC(14,3) NOT NULL DEFAULT 0,
    qty_before     NUMERIC(14,3),
    qty_after      NUMERIC(14,3),
    status         VARCHAR(12)   NOT NULL DEFAULT 'PENDING',
    udi_result     JSONB,                          -- 本行 UDI 联动结果（含失败原因，不阻塞库存）
    error          VARCHAR(200),
    picked_at      TIMESTAMPTZ,
    shipped_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT ck_wms_ship_line_status CHECK (status IN ('PENDING', 'PICKED', 'SHIPPED', 'SHORT', 'FAILED')),
    CONSTRAINT ck_wms_ship_line_qty    CHECK (qty_plan > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_wms_ship_line ON wms_shipment_lines (tenant_id, shipment_id, line_no);
CREATE INDEX IF NOT EXISTS ix_wms_ship_line_doc ON wms_shipment_lines (tenant_id, shipment_id);
CREATE INDEX IF NOT EXISTS ix_wms_ship_line_material ON wms_shipment_lines (tenant_id, material_id);

-- 3. 模块目录：wms.outbound 已在 wms_p1_inbound.sql 种过（is_core=FALSE）；
--    这里只给演示租户 default 开通，便于验收；其它租户走正常加购（tenant_modules.source='addon'）。
INSERT INTO tenant_modules (tenant_id, module_code, status, source)
SELECT t.id, 'wms.outbound', 'active', 'addon'
  FROM tenants t
 WHERE t.code = 'default'
ON CONFLICT (tenant_id, module_code)
DO UPDATE SET status = 'active' WHERE tenant_modules.status <> 'active';

COMMIT;
