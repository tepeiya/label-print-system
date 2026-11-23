-- U5.2 多 GTIN（单品/中包/托盘）（幂等，可重复执行）
-- 背景：一个物料可能同时有单品码、中包码、托盘码；扫码比对时按整组匹配。
-- 顺序：先执行本脚本，再重跑 saas_p6_rls.sql（让新表挂租户隔离策略）。

CREATE TABLE IF NOT EXISTS material_gtins (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL,
  material_id   BIGINT NOT NULL,
  gtin          VARCHAR(14) NOT NULL,
  pack_level    VARCHAR(8) NOT NULL DEFAULT 'UNIT',
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_material_gtins_level CHECK (pack_level IN ('UNIT', 'CARTON', 'PALLET'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_material_gtins_tenant_gtin
  ON material_gtins (tenant_id, gtin);
CREATE INDEX IF NOT EXISTS ix_material_gtins_material
  ON material_gtins (tenant_id, material_id);

-- 把既有的单 GTIN 列回填为 UNIT 级主码（只回填一次）
INSERT INTO material_gtins (tenant_id, material_id, gtin, pack_level, is_primary)
SELECT tenant_id, id, gtin, 'UNIT', true
FROM materials
WHERE gtin IS NOT NULL
ON CONFLICT (tenant_id, gtin) DO NOTHING;

COMMENT ON TABLE material_gtins IS '物料多 GTIN：单品/中包/托盘；扫码比对按整组匹配';
