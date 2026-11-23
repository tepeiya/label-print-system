-- U5.1 物料 GTIN / UDI 必扫（幂等，可重复执行）
-- 目的：给物料挂 GTIN14，收货/发料扫码时比对"扫到的码是否就是这个物料"，防扫错料。
-- 用法：execute → 重跑 saas_p6_rls.sql（新列无需 RLS，但同库脚本习惯一起跑）

ALTER TABLE materials ADD COLUMN IF NOT EXISTS gtin varchar(14);
ALTER TABLE materials ADD COLUMN IF NOT EXISTS udi_required boolean NOT NULL DEFAULT false;

-- 同租户内 GTIN 唯一（一个 GTIN 只对应一个物料；NULL 不参与）
CREATE UNIQUE INDEX IF NOT EXISTS ux_materials_tenant_gtin
  ON materials (tenant_id, gtin) WHERE gtin IS NOT NULL;

COMMENT ON COLUMN materials.gtin IS 'GS1 GTIN14（含校验位）；UDI 联动比对用，未赋码物料留空';
COMMENT ON COLUMN materials.udi_required IS '该物料是否必须扫 UDI 码收货/发料（true 时缺码拒绝）';
