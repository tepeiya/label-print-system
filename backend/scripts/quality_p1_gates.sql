-- =============================================================================
-- 质量闸门（quality p1）—— 2026-11-25
--
-- 为什么要有这一组表：
--   存量系统的物理流是通的（收货→上架→领料→赋码→入库→发货→签收），
--   但 GMP 要求的三个放行闸门全空着：
--     ① 来料没有检验结论 —— 收货过账即入可用库存，物料凭什么判合格答不出来；
--     ② 成品没有 QA 放行 —— 入库即可发，违反「未经放行不得上市销售」；
--     ③ 没有不合格隔离 —— 待检/不合格品与合格品混在同一个桶里，只靠人工纪律。
--   本脚本把这三件事落成数据模型：库存批次带质量状态 + 检验单 + 放行单 + 批记录。
--
-- 状态口径（stock_batches.quality_status）：
--   PENDING   待检：可存在、可盘点，但不可被领料/发货/报废
--   RELEASED  合格：唯一的可出库状态
--   REJECTED  不合格：隔离，只能走「报废」调整单（处置需留痕）
--   FROZEN    冻结：质量事件暂扣（可调查后解冻回原状态，解冻记录在 qc_status_log）
--
-- 兼容性：所有存量批次默认 RELEASED（存量系统视为已放行），只有收货时显式置 PENDING
--   的批次才会被拦，因此本脚本上线不会让现存库存突然不可用。
--
-- 幂等：全部 IF NOT EXISTS / 列级 IF NOT EXISTS，可在存量库重复执行。
-- RLS：必须排在 saas_p6_rls.sql（第一遍）之后、第二遍之前，由第二遍挂隔离策略。
-- =============================================================================

BEGIN;

-- 1. 库存质量状态 -------------------------------------------------------------
-- 物料级开关：qc_required=true 的物料，收货时批次进 PENDING 并自动开检验单
ALTER TABLE materials
    ADD COLUMN IF NOT EXISTS qc_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE stock_batches
    ADD COLUMN IF NOT EXISTS quality_status VARCHAR(12) NOT NULL DEFAULT 'RELEASED';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ck_stock_batches_quality_status'
    ) THEN
        ALTER TABLE stock_batches
            ADD CONSTRAINT ck_stock_batches_quality_status
            CHECK (quality_status IN ('PENDING', 'RELEASED', 'REJECTED', 'FROZEN'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_stock_batches_quality ON stock_batches (tenant_id, quality_status);

-- 2. 检验单（IQC / IPQC / FQC / OQC）------------------------------------------
CREATE TABLE IF NOT EXISTS qc_inspections (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT       NOT NULL,
    inspection_no  VARCHAR(40)  NOT NULL,          -- QC-YYYYMMDD-NNNN，租户内唯一
    insp_type      VARCHAR(8)   NOT NULL DEFAULT 'IQC',
    source         VARCHAR(12)  NOT NULL DEFAULT 'MANUAL',  -- RECEIPT=收货自动开单 / MANUAL=手工补开
    receipt_id     BIGINT,                          -- 来料检验关联收货单（无外键：脚本顺序与历史数据）
    warehouse_id   BIGINT       NOT NULL REFERENCES warehouses(id),
    material_id    BIGINT       NOT NULL REFERENCES materials(id),
    sku_code       VARCHAR(40)  NOT NULL,
    batch_no       VARCHAR(60)  NOT NULL,
    qty            NUMERIC(14,3) NOT NULL DEFAULT 0,   -- 该批次受检数量（快照）
    sample_qty     NUMERIC(14,3) NOT NULL DEFAULT 0,   -- 抽样数
    status         VARCHAR(12)  NOT NULL DEFAULT 'DRAFT',  -- DRAFT 待录/待判 · PASS 合格 · FAIL 不合格 · CANCELLED
    inspector      VARCHAR(80),                      -- 检验员（设备端可能无账号，存姓名）
    inspected_by   BIGINT,
    inspected_at   TIMESTAMPTZ,
    reviewer       VARCHAR(80),                      -- 审核/放行判定人
    reviewed_by    BIGINT,
    reviewed_at    TIMESTAMPTZ,
    opinion        VARCHAR(300),
    remark         VARCHAR(300),
    created_by     BIGINT,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT ck_qc_insp_type   CHECK (insp_type IN ('IQC', 'IPQC', 'FQC', 'OQC')),
    CONSTRAINT ck_qc_insp_status CHECK (status IN ('DRAFT', 'PASS', 'FAIL', 'CANCELLED')),
    CONSTRAINT ck_qc_insp_source CHECK (source IN ('RECEIPT', 'MANUAL', 'WORKORDER'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_qc_insp_no ON qc_inspections (tenant_id, inspection_no);
CREATE INDEX IF NOT EXISTS ix_qc_insp_tenant_time ON qc_inspections (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_qc_insp_batch ON qc_inspections (tenant_id, material_id, batch_no);
CREATE INDEX IF NOT EXISTS ix_qc_insp_status ON qc_inspections (tenant_id, status);

-- 检验项目：一条检验单至少 1 项，全 PASS 才能判合格
CREATE TABLE IF NOT EXISTS qc_inspection_items (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT       NOT NULL,
    inspection_id  BIGINT       NOT NULL REFERENCES qc_inspections(id) ON DELETE CASCADE,
    seq            INT          NOT NULL DEFAULT 1,
    item_name      VARCHAR(80)  NOT NULL,          -- 外观 / 尺寸 / 密封性 / 无菌 …
    standard       VARCHAR(160),                   -- 标准值或接收准则
    measured       VARCHAR(120),                   -- 实测值
    verdict        VARCHAR(8)   NOT NULL DEFAULT 'NA',   -- PASS / FAIL / NA
    remark         VARCHAR(200),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT ck_qc_item_verdict CHECK (verdict IN ('PASS', 'FAIL', 'NA'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_qc_item_seq ON qc_inspection_items (tenant_id, inspection_id, seq);
CREATE INDEX IF NOT EXISTS ix_qc_item_doc ON qc_inspection_items (tenant_id, inspection_id);

-- 3. 成品放行单 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qa_releases (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT        NOT NULL,
    release_no     VARCHAR(40)   NOT NULL,          -- RL-YYYYMMDD-NNNN
    source         VARCHAR(12)   NOT NULL DEFAULT 'PRODUCTION',  -- PRODUCTION 完工放行 / MANUAL 手工
    warehouse_id   BIGINT        NOT NULL REFERENCES warehouses(id),
    material_id    BIGINT        NOT NULL REFERENCES materials(id),
    sku_code       VARCHAR(40)   NOT NULL,
    batch_no       VARCHAR(60)   NOT NULL,
    work_order_id  BIGINT,                          -- 关联工单（可为空）
    qty            NUMERIC(14,3) NOT NULL DEFAULT 0,
    inspection_id  BIGINT,                          -- 成品检验单（有则必须 PASS 才能放行）
    status         VARCHAR(12)   NOT NULL DEFAULT 'PENDING',
    submitter      VARCHAR(80),
    submitted_by   BIGINT,
    submitted_at   TIMESTAMPTZ,
    reviewer       VARCHAR(80),                     -- 签批 QA 姓名
    reviewed_by    BIGINT,
    reviewed_at    TIMESTAMPTZ,
    opinion        VARCHAR(300),
    remark         VARCHAR(300),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT ck_qa_rel_status CHECK (status IN ('PENDING', 'RELEASED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT ck_qa_rel_source CHECK (source IN ('PRODUCTION', 'MANUAL'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_qa_rel_no ON qa_releases (tenant_id, release_no);
CREATE INDEX IF NOT EXISTS ix_qa_rel_batch ON qa_releases (tenant_id, material_id, batch_no);
CREATE INDEX IF NOT EXISTS ix_qa_rel_status ON qa_releases (tenant_id, status);

-- 4. 批记录 -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_records (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT        NOT NULL,
    record_no      VARCHAR(40)   NOT NULL,          -- BR-YYYYMMDD-NNNN
    work_order_id  BIGINT,                          -- 关联生产工单
    wo_no          VARCHAR(40),
    material_id    BIGINT        NOT NULL REFERENCES materials(id),
    sku_code       VARCHAR(40)   NOT NULL,
    product_name   VARCHAR(120),
    batch_no       VARCHAR(60)   NOT NULL,
    qty_planned    NUMERIC(14,3) NOT NULL DEFAULT 0,
    qty_actual     NUMERIC(14,3),
    status         VARCHAR(12)   NOT NULL DEFAULT 'OPEN',   -- OPEN 记录中 / SUBMITTED 已提交 / APPROVED 已批准 / REJECTED 退回
    opened_by      BIGINT,
    opened_at      TIMESTAMPTZ,
    submitted_by   BIGINT,
    submitted_at   TIMESTAMPTZ,
    approved_by    BIGINT,
    approved_at    TIMESTAMPTZ,
    approval_opinion VARCHAR(300),
    remark         VARCHAR(300),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT ck_br_status CHECK (status IN ('OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_br_no ON batch_records (tenant_id, record_no);
CREATE UNIQUE INDEX IF NOT EXISTS ux_br_batch ON batch_records (tenant_id, material_id, batch_no);
CREATE INDEX IF NOT EXISTS ix_br_tenant_time ON batch_records (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_br_wo ON batch_records (tenant_id, work_order_id);

-- 工序步骤：批记录的主体（谁、在哪台设备、什么时候、参数多少、结果如何）
CREATE TABLE IF NOT EXISTS batch_record_steps (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT        NOT NULL,
    record_id      BIGINT        NOT NULL REFERENCES batch_records(id) ON DELETE CASCADE,
    seq            INT           NOT NULL,
    step_name      VARCHAR(80)   NOT NULL,          -- 配料 / 注塑 / 组装 / 初包装 / 灭菌 / 解析 / 外包
    equipment      VARCHAR(80),                     -- 设备编号
    operator       VARCHAR(80),                     -- 操作人
    started_at     TIMESTAMPTZ,
    ended_at       TIMESTAMPTZ,
    params         JSONB,                           -- 工艺参数（温度/压力/时间/Eo 浓度…）
    result         VARCHAR(8)    NOT NULL DEFAULT 'PASS',   -- PASS / FAIL / NA
    remark         VARCHAR(200),
    attachment_url VARCHAR(300),                    -- 记录附件（现场照片/设备打印记录）
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT ck_br_step_result CHECK (result IN ('PASS', 'FAIL', 'NA')),
    CONSTRAINT ck_br_step_seq CHECK (seq > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_br_step_seq ON batch_record_steps (tenant_id, record_id, seq);
CREATE INDEX IF NOT EXISTS ix_br_step_doc ON batch_record_steps (tenant_id, record_id);

-- 5. 质量状态变更留痕 ---------------------------------------------------------
-- 批次状态每次变化都落一行：谁改的、从什么改成什么、依据哪张单（检验单/放行单/人工冻结）
CREATE TABLE IF NOT EXISTS qc_status_log (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT       NOT NULL,
    warehouse_id   BIGINT       NOT NULL,
    material_id    BIGINT       NOT NULL,
    sku_code       VARCHAR(40)  NOT NULL,
    batch_no       VARCHAR(60)  NOT NULL,
    from_status    VARCHAR(12),
    to_status      VARCHAR(12)  NOT NULL,
    reason         VARCHAR(200) NOT NULL,
    ref_type       VARCHAR(20),                     -- QC_INSPECTION / QA_RELEASE / MANUAL
    ref_no         VARCHAR(40),
    operator       VARCHAR(80),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_qc_log_batch ON qc_status_log (tenant_id, material_id, batch_no);
CREATE INDEX IF NOT EXISTS ix_qc_log_time ON qc_status_log (tenant_id, created_at DESC);

-- 6. 演示种子：把演示租户的医用耗材（udi_required=true 那批）设为「必须检验」，
--    这样 --seed-demo 建库后，收货即待检、发货被拦、放行后才可发——闸门能当场演示出来。
UPDATE materials m
   SET qc_required = TRUE
  FROM tenants t
 WHERE m.tenant_id = t.id
   AND t.code = 'default'
   AND m.udi_required = TRUE;

-- 7. 模块开通：quality.qms（存量租户默认不开，避免菜单突然多出三页；演示租户开）
INSERT INTO modules (code, name, description, sort_order, is_core)
VALUES ('quality.qms', '质量管理', '检验单（IQC/IPQC/FQC）+ 成品放行 + 批记录', 35, FALSE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO tenant_modules (tenant_id, module_code, status, source)
SELECT t.id, 'quality.qms', 'active', 'manual'
  FROM tenants t
 WHERE t.code = 'default'
ON CONFLICT (tenant_id, module_code)
DO UPDATE SET status = 'active' WHERE tenant_modules.status <> 'active';

COMMIT;
