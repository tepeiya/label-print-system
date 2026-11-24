-- =============================================================================
-- UDI 合规闭环：DI 主数据台账 + 申报提交记录（2026-11-24）
--
-- 1) udi_di_master —— 一物一 DI 的台账。此前 DI 只在打印时即时构造（GTIN 靠人填），
--    没有"这个 DI 是什么产品、属于哪个包装层级、上级是哪个 DI"的权威记录；
--    医院招标/飞检首先查这张表。
-- 2) udi_submissions —— 申报记录。先做"校验 + 生成文件"，再上 NMPA 接口；
--    每次提交留 payload/返回码，便于驳回后差分重提。
-- 幂等：可重复执行。
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.udi_di_master (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT       NOT NULL,
  di                VARCHAR(14)  NOT NULL,              -- GTIN-14（含校验位）
  name              VARCHAR(128) NOT NULL,              -- 产品名称
  spec              VARCHAR(128),                       -- 规格型号（注册证口径）
  model             VARCHAR(128),                       -- 型号
  registration_no   VARCHAR(64),                        -- 注册证号 / 备案号
  catalog_code      VARCHAR(32),                        -- 分类目录 XX-XX-XX
  gmdn              VARCHAR(32),                        -- GMDN（出口用）
  emdn              VARCHAR(32),                        -- EMDN（欧盟用）
  issuing_agency    VARCHAR(16)  NOT NULL DEFAULT 'GS1',
  is_sterile        BOOLEAN      NOT NULL DEFAULT FALSE,
  is_single_use     BOOLEAN      NOT NULL DEFAULT FALSE,
  package_level     VARCHAR(16)  NOT NULL DEFAULT 'UNIT'
                    CHECK (package_level IN ('UNIT', 'CARTON', 'PALLET')),
  qty_in_package    NUMERIC(14,3),                      -- 该层级一个包装含多少个下级
  parent_di         VARCHAR(14),                        -- 上级包装的 DI（PALLET←CARTON←UNIT）
  status            VARCHAR(16)  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'disabled')),
  remark            VARCHAR(300),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_udi_di_master UNIQUE (tenant_id, di)
);
CREATE INDEX IF NOT EXISTS ix_udi_di_master_level ON public.udi_di_master (tenant_id, package_level, status);

CREATE TABLE IF NOT EXISTS public.udi_submissions (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT      NOT NULL,
  channel        VARCHAR(16) NOT NULL,                  -- NMPA | EUDAMED | GUDID | FILE
  mode           VARCHAR(16) NOT NULL DEFAULT 'validate'
                 CHECK (mode IN ('validate', 'file', 'api')),
  dis            JSONB       NOT NULL DEFAULT '[]',     -- 本次提交的 DI 列表
  payload        JSONB,                                 -- 生成/发送的报文（便于差分）
  issues         JSONB,                                 -- 校验问题清单
  status         VARCHAR(16) NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'validated', 'generated', 'submitted', 'failed')),
  remote_code    VARCHAR(64),
  remote_msg     TEXT,
  attempts       INT         NOT NULL DEFAULT 0,
  submitted_at   TIMESTAMPTZ,
  created_by     BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_udi_submissions_tenant ON public.udi_submissions (tenant_id, created_at DESC);
