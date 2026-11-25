-- =============================================================================
-- wms_p11_carton_source.sql —— 装箱来源绑定（收货单 / 工单）
--
-- 背景：udi_packages 原来只有 work_order_no，收货单侧无法追溯"这箱属于哪张单"，
--       因此算不出"这单还剩多少没装箱"。这里补来源列，并把工单口径也统一到 source_no。
-- 兼容：work_order_no 保留（历史数据/打印模板仍在用），新增列对旧数据为 NULL。
-- =============================================================================
ALTER TABLE udi_packages ADD COLUMN IF NOT EXISTS source_type varchar(16);
ALTER TABLE udi_packages ADD COLUMN IF NOT EXISTS source_no   varchar(64);

COMMENT ON COLUMN udi_packages.source_type IS '装箱来源类型：RECEIPT | WORK_ORDER；NULL=自由装箱';
COMMENT ON COLUMN udi_packages.source_no   IS '装箱来源单号：收货单号 / 工单号';

CREATE INDEX IF NOT EXISTS idx_udi_packages_source
  ON udi_packages (tenant_id, source_type, source_no);
