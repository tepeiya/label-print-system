-- =============================================================================
-- seed-inventory-demo.sql —— P4 库存/BOM 演示数据（幂等，可重复执行）
-- 用法：su postgres -c "psql -h /tmp -p 5433 -U labelflow -d labelflow -v tid=98 -f backend/scripts/seed-inventory-demo.sql"
-- 数据对齐 docs/11 §11.6.3 示例摘要「上海仓有机苹果可用 320 件，低于安全库存 500」
-- 与 §11.11.2 齐套演示：苹果礼盒 ×100 → 有机苹果缺料 → 齐套率 64%
-- =============================================================================

BEGIN;

INSERT INTO warehouses (tenant_id, code, name) VALUES
  (:tid, 'WH-SH', '上海仓'),
  (:tid, 'WH-JX', '嘉兴冷链仓')
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO materials (tenant_id, code, name, spec, unit, category, safety_stock) VALUES
  (:tid, 'M-APPLE-ORG', '有机苹果',   '红富士 80#'::varchar, 'kg',  '水果',   500),
  (:tid, 'M-PEAR-001',  '雪梨',       '皇冠梨 75#'::varchar, 'kg',  '水果',   200),
  (:tid, 'M-BOX-GIFT',  '礼盒包装盒', '10 枚装'::varchar,     '个',  '包材',   100),
  (:tid, 'M-LABEL-001', '水果标签纸', '60*40mm 铜版纸'::varchar, '张', '耗材', 5000),
  (:tid, 'P-GIFT-A',    '苹果礼盒',   '10 枚精装'::varchar,   '盒',  '成品',   0)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- 批次：有机苹果 2 批共 320kg（< 安全库存 500）；雪梨临期；标签足量
INSERT INTO stock_batches (tenant_id, material_id, warehouse_id, batch_no, qty, unit_cost_cents, produced_at, expires_at)
SELECT
  :tid,
  m.id,
  w.id,
  x.batch_no,
  x.qty::numeric,
  x.cost,
  x.produced::date,
  (current_date + x.exp_in)::date
FROM (VALUES
  ('M-APPLE-ORG', 'WH-SH',   'B2026-0901', 200, 850,  '2026-09-01', 90),
  ('M-APPLE-ORG', 'WH-JX',   'B2026-1001', 120, 820,  '2026-10-01', 60),
  ('M-PEAR-001',  'WH-SH',   'B2026-0815', 300, 430,  '2026-08-15', 10),
  ('M-BOX-GIFT',  'WH-SH',   'BX-2026-11', 60,  1200, '2026-11-01', 365),
  ('M-LABEL-001', 'WH-SH',   'LB-2026-10', 8000, 3,   '2026-10-10', 720)
) AS x(mat, wh, batch_no, qty, cost, produced, exp_in)
JOIN materials m ON m.tenant_id = :tid AND m.code = x.mat
JOIN warehouses w ON w.tenant_id = :tid AND w.code = x.wh
ON CONFLICT (tenant_id, material_id, warehouse_id, batch_no) DO UPDATE SET
  qty = EXCLUDED.qty, expires_at = EXCLUDED.expires_at;

-- BOM：苹果礼盒 v1（1 盒 = 5kg 苹果 + 1 个包装盒，苹果损耗 5%）
INSERT INTO boms (tenant_id, product_material_id, version, status)
SELECT :tid, m.id, 'v1', 'active'
FROM materials m WHERE m.tenant_id = :tid AND m.code = 'P-GIFT-A'
ON CONFLICT (tenant_id, product_material_id, version) DO NOTHING;

INSERT INTO bom_items (bom_id, material_id, qty_per, loss_rate)
SELECT b.id, m.id, x.qty_per::numeric, x.loss::numeric
FROM boms b
JOIN materials pm ON pm.id = b.product_material_id AND pm.code = 'P-GIFT-A' AND pm.tenant_id = :tid
CROSS JOIN (VALUES
  ('M-APPLE-ORG', 5, 0.05),
  ('M-BOX-GIFT',  1, 0)
) AS x(mat, qty_per, loss)
JOIN materials m ON m.tenant_id = :tid AND m.code = x.mat
ON CONFLICT (bom_id, material_id) DO UPDATE SET
  qty_per = EXCLUDED.qty_per, loss_rate = EXCLUDED.loss_rate;

COMMIT;
