-- =============================================================================
-- WMS 阶段二迁移：wms.issuing 工单发料与齐套（决策 A 版，见 docs/16 §1/§3）
--
-- 做什么：
--   1) 4 张业务表：wms_work_orders / wms_wo_lines / wms_issue_records / wms_wo_returns
--   2) 幂等唯一键：(tenant_id, wo_no)、(tenant_id, idem_key) ×2
--   3) 索引：工单状态、工单行、发料/退料幂等
--
-- 幂等：全部 IF NOT EXISTS / DO 守卫，可重复执行。
-- RLS：执行后必须重跑 scripts/saas_p6_rls.sql，4 张新表才会挂 tenant_isolation 策略。
-- 模块：wms.issuing 已在阶段一 wms_p1_inbound.sql 种子；本脚本不重复 INSERT modules。
-- 数量口径：NUMERIC(14,3)，与 stock_batches.qty 对齐。
-- =============================================================================

BEGIN;

-- 1. 工单头 -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_work_orders (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           BIGINT       NOT NULL,
  wo_no               VARCHAR(64)  NOT NULL,
  product_material_id BIGINT       NOT NULL,
  warehouse_id        BIGINT       NOT NULL,
  demand_qty          NUMERIC(14,3) NOT NULL,
  source_type         VARCHAR(32)  NOT NULL DEFAULT 'MANUAL',
  source_no           VARCHAR(64),
  priority            INT          NOT NULL DEFAULT 100,
  planned_start_at    TIMESTAMPTZ,
  planned_end_at      TIMESTAMPTZ,
  status              VARCHAR(32)  NOT NULL DEFAULT 'CREATED',
  shortage_flag       BOOLEAN      NOT NULL DEFAULT FALSE,
  remark              TEXT,
  created_by          BIGINT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ck_wms_wo_status CHECK (status IN
    ('CREATED','RELEASED','ISSUING','ISSUED','CLOSED','CANCELLED'))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_wms_wo_no') THEN
    ALTER TABLE public.wms_work_orders ADD CONSTRAINT uq_wms_wo_no UNIQUE (tenant_id, wo_no);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_wms_wo_status ON public.wms_work_orders(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_wms_wo_product ON public.wms_work_orders(tenant_id, product_material_id);

-- 2. 工单明细行（应发料行） ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_wo_lines (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT       NOT NULL,
  wo_id           BIGINT       NOT NULL,
  line_no         INT          NOT NULL,
  material_id     BIGINT       NOT NULL,
  qty_required    NUMERIC(14,3) NOT NULL,
  qty_issued      NUMERIC(14,3) NOT NULL DEFAULT 0,
  qty_shortage    NUMERIC(14,3) NOT NULL DEFAULT 0,
  batch_no        VARCHAR(60),
  status          VARCHAR(32)  NOT NULL DEFAULT 'PENDING',
  shortage_reason VARCHAR(300),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ck_wms_wo_line_status CHECK (status IN ('PENDING','PARTIAL','DONE','SHORT'))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_wms_wo_line_no') THEN
    ALTER TABLE public.wms_wo_lines ADD CONSTRAINT uq_wms_wo_line_no UNIQUE (tenant_id, wo_id, line_no);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_wms_wo_lines_wo ON public.wms_wo_lines(tenant_id, wo_id);

-- 3. 发料记录（幂等完成标志） --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_issue_records (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT       NOT NULL,
  wo_id         BIGINT       NOT NULL,
  line_id       BIGINT       NOT NULL,
  material_id   BIGINT       NOT NULL,
  batch_no      VARCHAR(60),
  location_id   BIGINT,
  qty           NUMERIC(14,3) NOT NULL,
  idem_key      VARCHAR(128) NOT NULL,
  ref_type      VARCHAR(32)  NOT NULL DEFAULT 'WMS_ISSUE',
  operator_id   BIGINT,
  print_job_id  VARCHAR(64),
  print_status  VARCHAR(32),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_wms_issue_idem') THEN
    ALTER TABLE public.wms_issue_records ADD CONSTRAINT uq_wms_issue_idem UNIQUE (tenant_id, idem_key);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_wms_issue_wo ON public.wms_issue_records(tenant_id, wo_id);
CREATE INDEX IF NOT EXISTS idx_wms_issue_material ON public.wms_issue_records(tenant_id, material_id, created_at);

-- 4. 退料记录（D8） -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_wo_returns (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT       NOT NULL,
  wo_id         BIGINT       NOT NULL,
  line_id       BIGINT       NOT NULL,
  material_id   BIGINT       NOT NULL,
  batch_no      VARCHAR(60),
  location_id   BIGINT,
  qty           NUMERIC(14,3) NOT NULL,
  idem_key      VARCHAR(128) NOT NULL,
  approved_by   BIGINT,
  approved_at   TIMESTAMPTZ,
  reason        VARCHAR(300),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_wms_return_idem') THEN
    ALTER TABLE public.wms_wo_returns ADD CONSTRAINT uq_wms_return_idem UNIQUE (tenant_id, idem_key);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_wms_return_wo ON public.wms_wo_returns(tenant_id, wo_id);

-- 5. updated_at 自动维护（工单头） ---------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_wms_wo_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wms_wo_touch') THEN
    CREATE TRIGGER trg_wms_wo_touch
      BEFORE UPDATE ON public.wms_work_orders
      FOR EACH ROW EXECUTE FUNCTION public.touch_wms_wo_updated_at();
  END IF;
END
$$;

COMMIT;

SELECT 'wms_p2_tables' AS metric, count(*)::text AS value
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN
  ('wms_work_orders','wms_wo_lines','wms_issue_records','wms_wo_returns');
