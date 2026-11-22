-- =============================================================================
-- WMS 阶段一迁移：wms.inbound 收货与上架（方向 A · 模块订阅售卖）
-- 依据：docs/13-wms-recon-report.md §13 决策 + §14 补充勘察
--
-- 做什么：
--   1) 模板表加 code 列 + (tenant_id, code) 唯一 + 存量回填（C2 选 A）
--   2) modules 表 INSERT 5 个 WMS 模块（种子，存量租户默认不开通，C1）
--   3) tool_idempotency.idem_key 扩到 128（打印幂等复用，C7）
--   4) 阶段一 4 张 WMS 业务表 + 索引（全部含 tenant_id，纳入 RLS）
--
-- 幂等：全部 DDL 用 IF NOT EXISTS / DO 块守卫，可重复执行。
-- RLS：本脚本执行后必须重跑 scripts/saas_p6_rls.sql，让 4 张新表挂上 tenant_isolation 策略。
-- 数量口径：与 inventory 模块一致 NUMERIC(14,3)（对齐 stock_batches.qty）。
-- =============================================================================

BEGIN;

-- 1. 模板 code 列（C2：WMS 只声明"打什么标签"，code 必须人可读、业务语义）
-- ---------------------------------------------------------------------------
ALTER TABLE public.templates ADD COLUMN IF NOT EXISTS code VARCHAR(60);

-- 存量回填：name 转 slug（小写/非字母数字转下划线/压缩/去首尾/截断 50），
-- 冲突加序号，仍冲突或空 slug 兜底 TMPL_{id}。用 PL/pgSQL 逐租户逐行处理。
DO $$
DECLARE
  t RECORD;
  base_slug VARCHAR(60);
  candidate VARCHAR(60);
  n INT;
BEGIN
  FOR t IN SELECT id, tenant_id, name FROM public.templates WHERE code IS NULL ORDER BY tenant_id, id
  LOOP
    base_slug := lower(regexp_replace(coalesce(t.name, ''), '[^a-z0-9]+', '_', 'gi'));
    base_slug := regexp_replace(base_slug, '^_+|_+$', '', 'g');
    base_slug := left(coalesce(nullif(base_slug, ''), 'TMPL_' || t.id::text), 50);
    candidate := base_slug;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM public.templates WHERE tenant_id = t.tenant_id AND code = candidate AND id <> t.id)
    LOOP
      candidate := left(base_slug, 45) || '_' || n::text;
      n := n + 1;
    END LOOP;
    UPDATE public.templates SET code = candidate WHERE id = t.id;
  END LOOP;
END
$$;

-- code 可空（老数据兼容）但同一租户内非空值唯一；阶段一不做版本，版本用 code 后缀表达。
CREATE UNIQUE INDEX IF NOT EXISTS ux_templates_tenant_code
  ON public.templates (tenant_id, code) WHERE code IS NOT NULL;

-- 2. 幂等键扩列（C7：复用 tool_idempotency，key 从 80 扩到 128 兜底补打长键）
-- ---------------------------------------------------------------------------
ALTER TABLE public.tool_idempotency ALTER COLUMN idem_key TYPE VARCHAR(128);

-- 3. WMS 模块目录种子（C1：模块是数据行，非代码枚举；存量租户默认不开通）
-- ---------------------------------------------------------------------------
INSERT INTO public.modules (code, name, description, icon, sort_order, is_core) VALUES
  ('wms.inbound',   'WMS收货上架', '收货单、PDA扫码收货、上架任务与推荐',   '📦', 110, FALSE),
  ('wms.issuing',   'WMS工单发料', '工单发料、齐套检查、退料',             '🏭', 120, FALSE),
  ('wms.trace',     'WMS库存追溯', 'SN主数据、正反向追溯',                 '🔍', 130, FALSE),
  ('wms.outbound',  'WMS成品发运', '成品入库、装车发运、库存回传',         '🚚', 140, FALSE),
  ('wms.connector', 'WMS连接器',   'ERP/MES 对接（单独定价）',             '🔌', 150, FALSE)
ON CONFLICT (code) DO NOTHING;

-- 注意：不往 plan_modules / tenant_modules 写入 WMS 模块。
-- 存量租户默认不开通 → 订阅门 ModuleGuard 对未开通租户返回 4031。
-- 开发验证：由运维手工给测试租户 INSERT tenant_modules 行（见部署说明）。

-- 4. 阶段一业务表（全部含 tenant_id，纳入 RLS）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_receipts (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT      NOT NULL,
  receipt_no     VARCHAR(64) NOT NULL,
  source_type    VARCHAR(32) NOT NULL,               -- MANUAL | EXCEL_IMPORT
  source_no      VARCHAR(64),
  supplier_id    BIGINT,
  warehouse_id   BIGINT      NOT NULL,
  status         VARCHAR(32) NOT NULL DEFAULT 'CREATED',
                 -- CREATED | RECEIVING | RECEIVED | PUTAWAY_DONE | CANCELLED
  remark         TEXT,
  created_by     BIGINT      NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, receipt_no)
);

CREATE TABLE IF NOT EXISTS public.wms_receipt_lines (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT      NOT NULL,
  receipt_id     BIGINT      NOT NULL REFERENCES public.wms_receipts(id),
  line_no        INT         NOT NULL,
  sku_id         BIGINT      NOT NULL,
  batch_no       VARCHAR(64),
  qty_expected   NUMERIC(14,3) NOT NULL DEFAULT 0,
  qty_received   NUMERIC(14,3) NOT NULL DEFAULT 0,
  diff_type      VARCHAR(32),                        -- NULL | OVER | SHORT | WRONG_SKU
  diff_qty       NUMERIC(14,3) DEFAULT 0,
  status         VARCHAR(32) NOT NULL DEFAULT 'PENDING',
                 -- PENDING | RECEIVED | PUTAWAY_DONE
  UNIQUE (tenant_id, receipt_id, line_no)
);

CREATE TABLE IF NOT EXISTS public.wms_putaway_tasks (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             BIGINT      NOT NULL,
  receipt_line_id       BIGINT      NOT NULL REFERENCES public.wms_receipt_lines(id),
  suggested_location_id BIGINT,
  actual_location_id    BIGINT,
  qty                   NUMERIC(14,3) NOT NULL,
  status                VARCHAR(32) NOT NULL DEFAULT 'CREATED',
                        -- CREATED | ASSIGNED | DONE | CANCELLED
  operator_id           BIGINT,
  recommend_reason      VARCHAR(300),               -- 推荐原因（可解释）
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.wms_putaway_rules (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT      NOT NULL,
  warehouse_id   BIGINT      NOT NULL,
  priority       INT         NOT NULL DEFAULT 100,
  condition_json JSONB       NOT NULL,
  action_json    JSONB       NOT NULL,
  enabled        BOOLEAN     NOT NULL DEFAULT true
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_wms_receipts_status ON public.wms_receipts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_wms_putaway_status  ON public.wms_putaway_tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_wms_putaway_line    ON public.wms_putaway_tasks(tenant_id, receipt_line_id);
CREATE INDEX IF NOT EXISTS idx_wms_putaway_rules   ON public.wms_putaway_rules(tenant_id, warehouse_id, priority);
CREATE INDEX IF NOT EXISTS idx_wms_lines_receipt   ON public.wms_receipt_lines(tenant_id, receipt_id);

COMMIT;

-- 执行摘要（RLS 重跑后可用 p6-rls-smoke.sh 校验新表已挂策略）
SELECT 'wms_p1_tables' AS metric,
       count(*)::text AS value
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'wms_%';
