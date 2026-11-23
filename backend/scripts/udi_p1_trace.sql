-- =============================================================================
-- UDI 里程碑 U2 迁移：追溯单元 / 包装层级 / 事件流 + 留痕报表数据源
-- 依据：docs/18-udi-implementation.md（U2 范围）+ docs/04-template-schema.md
--
-- 做什么：
--   1) 3 张业务表：udi_units（单品）、udi_packages（包装 SSCC 层级）、udi_events（事件流）
--   2) 唯一键：udi_units(tenant_id, udi_key)、udi_packages(tenant_id, sscc)、udi_events(tenant_id, idem_key)
--   3) 索引：按 (tenant_id, gtin, lot, serial) 追溯、按 (tenant_id, status) 盘点、按 (tenant_id, event_type, occurred_at) 报表
--
-- 幂等：全部 IF NOT EXISTS / DO 守卫，可重复执行。
-- RLS：执行后必须重跑 scripts/saas_p6_rls.sql，三张新表才会挂 tenant_isolation 策略。
-- 口径：GTIN 存 14 位；日期用 DATE；事件时间用 TIMESTAMPTZ（跨时区飞检要能对齐）。
-- =============================================================================

BEGIN;

-- 1. 单品表 -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.udi_units (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT       NOT NULL,
  udi_key         VARCHAR(200) NOT NULL,           -- GTIN14|批号|序列号|有效期
  gtin            VARCHAR(14)  NOT NULL,
  lot             VARCHAR(64),
  serial          VARCHAR(64),
  expiry_date     DATE,
  production_date DATE,
  status          VARCHAR(32)  NOT NULL DEFAULT 'REGISTERED',
  package_id      BIGINT,
  package_sscc    VARCHAR(18),
  work_order_no   VARCHAR(64),
  template_code   VARCHAR(64),
  printed_at      TIMESTAMPTZ,
  created_by      BIGINT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ck_udi_units_status CHECK (status IN ('REGISTERED','PRINTED','RECEIVED','ISSUED','SHIPPED','VOID'))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_udi_units_key') THEN
    ALTER TABLE public.udi_units ADD CONSTRAINT uq_udi_units_key UNIQUE (tenant_id, udi_key);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_udi_units_lookup ON public.udi_units(tenant_id, gtin, lot, serial);
CREATE INDEX IF NOT EXISTS idx_udi_units_status ON public.udi_units(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_udi_units_work   ON public.udi_units(tenant_id, work_order_no);
CREATE INDEX IF NOT EXISTS idx_udi_units_pkg    ON public.udi_units(tenant_id, package_sscc);

-- 2. 包装表（SSCC 层级：单元 → 中包 → 托盘） -----------------------------------
CREATE TABLE IF NOT EXISTS public.udi_packages (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT      NOT NULL,
  sscc           VARCHAR(18) NOT NULL,
  level          VARCHAR(16) NOT NULL DEFAULT 'CARTON',   -- UNIT | CARTON | PALLET
  gtin           VARCHAR(14),
  qty            NUMERIC(14,3) NOT NULL DEFAULT 0,
  parent_sscc    VARCHAR(18),
  work_order_no  VARCHAR(64),
  created_by     BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_udi_packages_level CHECK (level IN ('UNIT','CARTON','PALLET'))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_udi_packages_sscc') THEN
    ALTER TABLE public.udi_packages ADD CONSTRAINT uq_udi_packages_sscc UNIQUE (tenant_id, sscc);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_udi_packages_parent ON public.udi_packages(tenant_id, parent_sscc);

-- 3. 事件流（正反向追溯 + 打印留痕） ------------------------------------------
CREATE TABLE IF NOT EXISTS public.udi_events (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT      NOT NULL,
  unit_id       BIGINT,
  udi_key       VARCHAR(200),
  package_sscc  VARCHAR(18),
  event_type    VARCHAR(24) NOT NULL,
  status_before VARCHAR(32),
  status_after  VARCHAR(32),
  ref_type      VARCHAR(32),        -- RECEIPT | ISSUE | SHIPMENT | PRINT_JOB | MANUAL
  ref_no        VARCHAR(64),
  idem_key      VARCHAR(120),       -- 幂等键：同一单据同一动作重复提交只落一条
  detail        JSONB,
  actor_id      BIGINT,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_udi_events_type CHECK (event_type IN
    ('BUILD','PRINT','PRINT_FAIL','RECEIVE','ISSUE','SHIP','RETURN','VOID','REPACK'))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_udi_events_idem') THEN
    ALTER TABLE public.udi_events ADD CONSTRAINT uq_udi_events_idem UNIQUE (tenant_id, idem_key);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_udi_events_unit ON public.udi_events(tenant_id, unit_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_udi_events_type ON public.udi_events(tenant_id, event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_udi_events_pkg  ON public.udi_events(tenant_id, package_sscc);

-- 4. updated_at 自动维护（udi_units 有 updated_at 列） --------------------------
CREATE OR REPLACE FUNCTION public.touch_udi_units_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_udi_units_touch') THEN
    CREATE TRIGGER trg_udi_units_touch
      BEFORE UPDATE ON public.udi_units
      FOR EACH ROW EXECUTE FUNCTION public.touch_udi_units_updated_at();
  END IF;
END
$$;

COMMIT;

-- 执行摘要（重跑 saas_p6_rls.sql 后可用 p6-rls-smoke.sh 校验策略）
SELECT 'udi_trace_tables' AS metric, count(*)::text AS value
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'udi_%';
