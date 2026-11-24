-- =============================================================================
-- D5 演示样板数据（医疗 UDI 场景）—— 幂等，可重复执行
--
-- 用法（由 scripts/demo-up.sh 调用）：
--   psql "$DATABASE_URL" -v tid=<tenant_id> -f scripts/seed-demo-hospital.sql
--
-- 内容：
--   · 20 个医院常见医用耗材物料（一次性注射器/输液器/留置针/敷贴/导管…）
--   · 其中 5 个登记了"一物料多码"（UNIT 主码 + CARTON 箱码，箱规 20/24/50）
--   · 1 个成品（一次性使用无菌注射器 5ml）→ 1 套 BOM（4 个组件）
--   · 2 张工单：WO-DEMO-001（已放行，可现场演示扫码发料）、WO-DEMO-002（发料到一半，演示缺料）
--   · 50 个 UDI 单品（GTIN+批号+序列号+有效期），并各记一条 REGISTER 事件
--
-- ⚠️ 只给演示/培训用：GTIN 是示意值（校验位合法但不属于真实注册证），不要拿去上报。
-- =============================================================================
\set ON_ERROR_STOP on

-- 0. 仓库与库位 --------------------------------------------------------------
INSERT INTO warehouses (tenant_id, code, name) VALUES (:tid::bigint, 'WH-DEMO', '演示中心仓（长沙）')
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO warehouse_locations (tenant_id, warehouse_id, code, name, zone)
SELECT :tid::bigint, w.id, x.code, x.name, x.zone
FROM warehouses w,
     (VALUES ('DEMO-A01', '原材区 A01', 'FAST'), ('DEMO-B02', '原材区 B02', 'FAST'), ('DEMO-F01', '成品区 F01', 'FAST'))
       AS x(code, name, zone)
WHERE w.tenant_id = :tid::bigint AND w.code = 'WH-DEMO'
ON CONFLICT (tenant_id, warehouse_id, code) DO NOTHING;

-- 1. 20 个物料 ---------------------------------------------------------------
INSERT INTO materials (tenant_id, code, name, unit, udi_required, gtin)
SELECT :tid::bigint, x.code, x.name, x.unit, x.udi, x.gtin
FROM (VALUES
  ('MD-SYR-05',  '一次性使用无菌注射器 5ml',        'PCS', true,  '06901234500011'),
  ('MD-SYR-10',  '一次性使用无菌注射器 10ml',       'PCS', true,  '06901234500028'),
  ('MD-INF-SET', '一次性使用输液器 带针',           'PCS', true,  '06901234500035'),
  ('MD-IVC-24',  '静脉留置针 24G',                  'PCS', true,  '06901234500042'),
  ('MD-IVC-22',  '静脉留置针 22G',                  'PCS', true,  '06901234500059'),
  ('MD-CATH-F8', '一次性使用导尿管 F8',             'PCS', true,  '06901234500066'),
  ('MD-DRS-10',  '医用无菌敷贴 10×10cm',            'PCS', true,  '06901234500073'),
  ('MD-DRS-20',  '医用无菌敷贴 20×20cm',            'PCS', true,  '06901234500080'),
  ('MD-GLV-M',   '一次性医用检查手套 M',            'BOX', false, '06901234500097'),
  ('MD-GLV-L',   '一次性医用检查手套 L',            'BOX', false, '06901234500103'),
  ('MD-MSK-17',  '医用外科口罩 17.5×9.5cm',         'BOX', false, '06901234500110'),
  ('MD-GAUZE',   '医用脱脂纱布块 8×8cm',            'PCS', false, '06901234500127'),
  ('MD-COTTON',  '医用棉签 10cm',                   'BAG', false, '06901234500134'),
  ('MD-ALCO',    '75% 酒精棉片',                    'BOX', false, '06901234500141'),
  ('MD-TAPE',    '医用透气胶带 2.5cm',              'ROLL', false,'06901234500158'),
  ('MD-BLD-SET', '一次性使用采血针 0.7mm',          'PCS', true,  '06901234500165'),
  ('MD-VAC-5',   '真空采血管 5ml（EDTA）',          'PCS', true,  '06901234500172'),
  ('MD-INF-PU',  '一次性使用精密过滤输液器',        'PCS', true,  '06901234500189'),
  ('MD-SUT-30',  '可吸收缝合线 3-0',                'PCS', true,  '06901234500196'),
  ('MD-SPR-20',  '一次性使用无菌注射器 20ml',       'PCS', true,  '06901234500202')
) AS x(code, name, unit, udi, gtin)
WHERE NOT EXISTS (
  SELECT 1 FROM materials m WHERE m.tenant_id = :tid::bigint AND m.code = x.code
);

-- 1b. 规格型号（导出/注册证对照要用，名称里已有规格的也显式落一列）---------
UPDATE materials m SET spec = x.spec
FROM (VALUES
  ('MD-SYR-05','5ml'), ('MD-SYR-10','10ml'), ('MD-INF-SET','带针 1.2mm'), ('MD-IVC-24','24G'),
  ('MD-IVC-22','22G'), ('MD-CATH-F8','F8 双腔'), ('MD-DRS-10','10×10cm'), ('MD-DRS-20','20×20cm'),
  ('MD-GLV-M','M 号'), ('MD-GLV-L','L 号'), ('MD-MSK-17','17.5×9.5cm'), ('MD-GAUZE','8×8cm'),
  ('MD-COTTON','10cm'), ('MD-ALCO','6×3cm'), ('MD-TAPE','2.5cm×10m'), ('MD-BLD-SET','0.7mm'),
  ('MD-VAC-5','5ml EDTA'), ('MD-INF-PU','1.2μm'), ('MD-SUT-30','3-0 90cm'), ('MD-SPR-20','20ml')
) AS x(code, spec)
WHERE m.tenant_id = :tid::bigint AND m.code = x.code AND (m.spec IS NULL OR m.spec = '');

-- 2. 一物料多码（UNIT 主码 + CARTON 箱码）----------------------------------
INSERT INTO material_gtins (tenant_id, material_id, gtin, pack_level, pack_qty, is_primary)
SELECT :tid::bigint, m.id, x.gtin, x.lvl, x.qty, x.prim
FROM (VALUES
  ('MD-SYR-05',  '06901234500011', 'UNIT',   1,  true),
  ('MD-SYR-05',  '06901234501018', 'CARTON', 24, false),
  ('MD-INF-SET', '06901234500035', 'UNIT',   1,  true),
  ('MD-INF-SET', '06901234501025', 'CARTON', 20, false),
  ('MD-GLV-M',   '06901234500097', 'UNIT',   1,  true),
  ('MD-GLV-M',   '06901234501032', 'CARTON', 50, false),
  ('MD-DRS-10',  '06901234500073', 'UNIT',   1,  true),
  ('MD-DRS-10',  '06901234501049', 'CARTON', 20, false),
  ('MD-VAC-5',   '06901234500172', 'UNIT',   1,  true),
  ('MD-VAC-5',   '06901234501056', 'CARTON', 100, false)
) AS x(mcode, gtin, lvl, qty, prim)
JOIN materials m ON m.tenant_id = :tid::bigint AND m.code = x.mcode
WHERE NOT EXISTS (
  SELECT 1 FROM material_gtins g
  WHERE g.tenant_id = :tid::bigint AND g.material_id = m.id AND g.gtin = x.gtin
);

-- 3. 库存批次（让齐套/发料/缺料三种演示都能演）----------------------------
INSERT INTO stock_batches (tenant_id, material_id, warehouse_id, batch_no, location_id, qty)
SELECT :tid::bigint, m.id, w.id, x.batch, l.id, x.qty
FROM (VALUES
  ('MD-SYR-05',  'LOT-2611A', 'DEMO-A01', 2400),
  ('MD-SYR-10',  'LOT-2611B', 'DEMO-A01', 1200),
  ('MD-INF-SET', 'LOT-2611C', 'DEMO-A01', 800),
  ('MD-IVC-24',  'LOT-2611D', 'DEMO-B02', 350),
  ('MD-IVC-22',  'LOT-2611E', 'DEMO-B02', 280),
  ('MD-CATH-F8', 'LOT-2610F', 'DEMO-B02', 120),
  ('MD-DRS-10',  'LOT-2610G', 'DEMO-B02', 900),
  ('MD-DRS-20',  'LOT-2610H', 'DEMO-B02', 400),
  ('MD-BLD-SET', 'LOT-2611I', 'DEMO-A01', 600),
  ('MD-VAC-5',   'LOT-2611J', 'DEMO-A01', 1500)
) AS x(mcode, batch, loc, qty)
JOIN materials m ON m.tenant_id = :tid::bigint AND m.code = x.mcode
JOIN warehouses w ON w.tenant_id = :tid::bigint AND w.code = 'WH-DEMO'
JOIN warehouse_locations l ON l.tenant_id = :tid::bigint AND l.warehouse_id = w.id AND l.code = x.loc
WHERE NOT EXISTS (
  SELECT 1 FROM stock_batches b
  WHERE b.tenant_id = :tid::bigint AND b.material_id = m.id AND b.batch_no = x.batch
);

-- 4. 成品 + BOM（一次性使用无菌注射器 5ml 总装）-----------------------------
INSERT INTO boms (tenant_id, product_material_id, version, status)
SELECT :tid::bigint, m.id, 'v1', 'active'
FROM materials m
WHERE m.tenant_id = :tid::bigint AND m.code = 'MD-SYR-05'
  AND NOT EXISTS (
    SELECT 1 FROM boms b WHERE b.tenant_id = :tid::bigint AND b.product_material_id = m.id
  );

INSERT INTO bom_items (bom_id, material_id, qty_per, loss_rate)
SELECT b.id, m.id, x.qty_per, x.loss
FROM boms b
JOIN materials prod ON prod.tenant_id = :tid::bigint AND prod.code = 'MD-SYR-05'
JOIN (VALUES
  ('MD-SYR-10', 1, 0.02),
  ('MD-INF-SET', 1, 0),
  ('MD-DRS-10', 2, 0.05),
  ('MD-VAC-5', 1, 0)
) AS x(mcode, qty_per, loss) ON true
JOIN materials m ON m.tenant_id = :tid::bigint AND m.code = x.mcode
WHERE b.tenant_id = :tid::bigint AND b.product_material_id = prod.id
  AND NOT EXISTS (
    SELECT 1 FROM bom_items bi WHERE bi.bom_id = b.id AND bi.material_id = m.id
  );

-- 5. 两张工单 ---------------------------------------------------------------
--   WO-DEMO-001：RELEASED，可现场从「齐套检查→放行→扫码发料」演起
--   WO-DEMO-002：ISSUING 且已发一部分，直接演示"缺料补料"
INSERT INTO wms_work_orders (tenant_id, wo_no, product_material_id, warehouse_id, demand_qty,
                             source_type, source_no, priority, status, shortage_flag, remark)
SELECT :tid::bigint, x.wo_no, m.id, w.id, x.demand, 'EXCEL_IMPORT', x.src, 100, x.status, false, x.remark
FROM (VALUES
  ('WO-DEMO-001', 100, 'PO-2026-1101', 'RELEASED', '演示：齐套→放行→扫码发料'),
  ('WO-DEMO-002', 60,  'PO-2026-1102', 'ISSUING',  '演示：部分发料后的缺料补齐')
) AS x(wo_no, demand, src, status, remark)
JOIN materials m ON m.tenant_id = :tid::bigint AND m.code = 'MD-SYR-05'
JOIN warehouses w ON w.tenant_id = :tid::bigint AND w.code = 'WH-DEMO'
WHERE NOT EXISTS (
  SELECT 1 FROM wms_work_orders o WHERE o.tenant_id = :tid::bigint AND o.wo_no = x.wo_no
);

-- 工单行按 BOM 展开（需求 = 需求量 × 每台用量 × (1+损耗)，向上取整）
INSERT INTO wms_wo_lines (tenant_id, wo_id, line_no, material_id, batch_no, qty_required,
                          qty_issued, qty_shortage, status, shortage_reason)
SELECT :tid::bigint, o.id,
       row_number() OVER (PARTITION BY o.id ORDER BY bi.material_id),
       bi.material_id, NULL,
       ceil(o.demand_qty * bi.qty_per * (1 + bi.loss_rate)),
       0, 0, 'PENDING', NULL
FROM wms_work_orders o
JOIN boms b ON b.tenant_id = o.tenant_id AND b.product_material_id = o.product_material_id
JOIN bom_items bi ON bi.bom_id = b.id
WHERE o.tenant_id = :tid::bigint AND o.wo_no IN ('WO-DEMO-001', 'WO-DEMO-002')
  AND NOT EXISTS (
    SELECT 1 FROM wms_wo_lines l WHERE l.tenant_id = o.tenant_id AND l.wo_id = o.id
  );

-- 6. 50 个 UDI 单品（成品 MD-SYR-05，批号 LOT-2611A，序列号 SN0001..SN0050）
INSERT INTO udi_units (tenant_id, udi_key, gtin, lot, serial, expiry_date, production_date,
                       status, work_order_no, template_code, printed_at)
SELECT :tid::bigint,
       format('06901234500011|LOT-2611A|%s|271231', ('SN' || lpad(g::text, 4, '0'))),
       '06901234500011', 'LOT-2611A', ('SN' || lpad(g::text, 4, '0')),
       DATE '2027-12-31', DATE '2026-11-01',
       CASE WHEN g <= 20 THEN 'PRINTED' ELSE 'REGISTERED' END,
       CASE WHEN g <= 20 THEN 'WO-DEMO-001' ELSE NULL END,
       CASE WHEN g <= 20 THEN 'UDI-SYR-5ML' ELSE NULL END,
       CASE WHEN g <= 20 THEN now() - (g || ' minutes')::interval ELSE NULL END
FROM generate_series(1, 50) AS g
WHERE NOT EXISTS (
  SELECT 1 FROM udi_units u
  WHERE u.tenant_id = :tid::bigint
    AND u.udi_key = format('06901234500011|LOT-2611A|%s|271231', ('SN' || lpad(g::text, 4, '0')))
);

-- 7. UDI 事件（BUILD=建档生成 + PRINT，幂等键带租户避免跨租户撞）
--    注意：ck_udi_events_type 只允许 BUILD/PRINT/PRINT_FAIL/RECEIVE/ISSUE/SHIP/RETURN/VOID/REPACK
INSERT INTO udi_events (tenant_id, udi_key, event_type, status_before, status_after, ref_type, ref_no, idem_key, detail)
SELECT u.tenant_id, u.udi_key, 'BUILD', NULL, 'REGISTERED', 'DEMO', 'DEMO-SEED',
       format('DEMO:%s:BUILD', u.udi_key), '{"seed":true}'::jsonb
FROM udi_units u
WHERE u.tenant_id = :tid::bigint AND u.serial LIKE 'SN00%'
  AND NOT EXISTS (
    SELECT 1 FROM udi_events e WHERE e.tenant_id = u.tenant_id AND e.idem_key = format('DEMO:%s:BUILD', u.udi_key)
  );

INSERT INTO udi_events (tenant_id, udi_key, event_type, status_before, status_after, ref_type, ref_no, idem_key, detail)
SELECT u.tenant_id, u.udi_key, 'PRINT', NULL, 'PRINTED', 'DEMO', 'DEMO-SEED',
       format('DEMO:%s:PRINT', u.udi_key), '{"seed":true}'::jsonb
FROM udi_units u
WHERE u.tenant_id = :tid::bigint AND u.status = 'PRINTED'
  AND NOT EXISTS (
    SELECT 1 FROM udi_events e WHERE e.tenant_id = u.tenant_id AND e.idem_key = format('DEMO:%s:PRINT', u.udi_key)
  );

-- 8. 模块订阅（演示要用 WMS 收货/发料与 UDI）------------------------------
INSERT INTO tenant_modules (tenant_id, module_code, status, source)
SELECT :tid::bigint, x.code, 'active', 'manual'
FROM (VALUES ('wms.inbound'), ('wms.issuing'), ('wms.outbound'), ('wms.trace'), ('inventory'), ('print'), ('bom')) AS x(code)
WHERE EXISTS (SELECT 1 FROM tenant_modules t WHERE t.tenant_id = :tid::bigint)
ON CONFLICT (tenant_id, module_code) DO NOTHING;

SELECT 'seed ok: ' || :tid::bigint AS result,
       (SELECT count(*) FROM materials WHERE tenant_id = :tid::bigint) AS materials,
       (SELECT count(*) FROM wms_work_orders WHERE tenant_id = :tid::bigint) AS work_orders,
       (SELECT count(*) FROM udi_units WHERE tenant_id = :tid::bigint) AS udi_units;
