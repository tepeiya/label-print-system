-- =============================================================================
-- 收货标签模板 RECEIPT_LABEL_V1（WMS 过账自动打印用）
--
-- 为什么要有：WMS 过账时按 (tenant_id, code='RECEIPT_LABEL_V1') 寻址模板，
-- 模板不存在 → 404 PRINT_TEMPLATE_NOT_FOUND，标签打不出来。此前种子 templates 表为空。
--
-- 变量契约（由 wms/inbound 的 buildReceiptVariables 组装）：
--   skuCode / skuName / unit / batchNo / qty / receiptNo / lineNo
-- 版式：50×30mm，CODE128 条码横贯整行（= SKU 编码，自带明文），下方批号 / 数量 / 单号行号。
--
-- ⚠️ 条码框宽度必须容得下最长的 SKU 码：CODE128 每字符约 3.4mm@0.28mm 模块，
--   10 字符的 M-PEAR-001 实测需 41.3mm。框给 30mm 会被 barcode-guard 判"溢出被切"→ 任务 failed。
--   所以条码横跨 46mm（50mm 标签留 2mm×2 边距）。
--
-- 幂等：首次插入；若库里已有"种子描述"的同 code 模板（旧版式），则更新 content 修正版式
--       （客户把 description 改过就不会被覆盖）。
-- =============================================================================

INSERT INTO templates (tenant_id, code, name, category, tags, description, schema_version, content)
SELECT t.id,
       'RECEIPT_LABEL_V1',
       '收货标签（自动打印）',
       'wms',
       ARRAY['wms', 'receipt', 'auto'],
       'WMS 收货过账时逐行自动打印，每行一张；变量由 buildReceiptVariables 提供',
       1,
       $json${
         "schemaVersion": 1,
         "page": { "widthMm": 50, "heightMm": 30, "dpi": 300, "orientation": 0, "unit": "mm" },
         "variables": [
           { "name": "skuCode",   "type": "text",   "required": true },
           { "name": "skuName",   "type": "text",   "required": true },
           { "name": "batchNo",   "type": "text" },
           { "name": "qty",       "type": "number", "required": true },
           { "name": "unit",      "type": "text",   "defaultValue": "件" },
           { "name": "receiptNo", "type": "text",   "required": true },
           { "name": "lineNo",    "type": "number" }
         ],
         "elements": [
           { "id": "el-title", "type": "text", "x": 2, "y": 1, "w": 46, "h": 4, "rotation": 0, "zIndex": 3,
             "text": "收货标签 · GOODS RECEIPT",
             "font": { "family": "Microsoft YaHei", "size": 7, "color": "#000000", "align": "center", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-name", "type": "text", "x": 2, "y": 5.2, "w": 46, "h": 3.8, "rotation": 0, "zIndex": 3,
             "text": "{{skuName}}",
             "font": { "family": "Microsoft YaHei", "size": 6.5, "color": "#000000", "align": "left", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-bc", "type": "barcode", "x": 2, "y": 9.4, "w": 46, "h": 10, "rotation": 0, "zIndex": 5,
             "barcode": { "sym": "CODE128", "content": "{{skuCode}}", "showText": true, "textFont": { "family": "Arial", "size": 2.6 } } },
           { "id": "el-batch", "type": "text", "x": 2, "y": 20, "w": 46, "h": 3.2, "rotation": 0, "zIndex": 3,
             "text": "批号 {{batchNo}}",
             "font": { "family": "Microsoft YaHei", "size": 5.5, "color": "#000000", "align": "left", "vAlign": "middle", "wrap": false } },
           { "id": "el-qty", "type": "text", "x": 2, "y": 23.2, "w": 24, "h": 3.2, "rotation": 0, "zIndex": 3,
             "text": "数量 {{qty}}{{unit}}",
             "font": { "family": "Microsoft YaHei", "size": 6.5, "color": "#000000", "align": "left", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-src", "type": "text", "x": 26, "y": 23.2, "w": 22, "h": 3.2, "rotation": 0, "zIndex": 3,
             "text": "{{receiptNo}} · 行{{lineNo}}",
             "font": { "family": "Microsoft YaHei", "size": 4.5, "color": "#333333", "align": "right", "vAlign": "middle", "wrap": false } },
           { "id": "el-foot", "type": "text", "x": 2, "y": 26.8, "w": 46, "h": 2.2, "rotation": 0, "zIndex": 3,
             "text": "LabelFlow WMS · 收货标签",
             "font": { "family": "Microsoft YaHei", "size": 4, "color": "#666666", "align": "center", "vAlign": "middle", "wrap": false } }
         ],
         "print": { "copies": 1 }
       }$json$::jsonb
FROM tenants t
WHERE NOT EXISTS (
    SELECT 1 FROM templates x WHERE x.tenant_id = t.id AND x.code = 'RECEIPT_LABEL_V1'
);

-- 修正存量：只覆盖"仍是种子描述"的模板（客户改过描述/版式的不动）
UPDATE templates x
   SET content = seed.content,
       schema_version = 1,
       updated_at = now()
  FROM (
    SELECT t.id AS tenant_id,
           $json${
         "schemaVersion": 1,
         "page": { "widthMm": 50, "heightMm": 30, "dpi": 300, "orientation": 0, "unit": "mm" },
         "variables": [
           { "name": "skuCode",   "type": "text",   "required": true },
           { "name": "skuName",   "type": "text",   "required": true },
           { "name": "batchNo",   "type": "text" },
           { "name": "qty",       "type": "number", "required": true },
           { "name": "unit",      "type": "text",   "defaultValue": "件" },
           { "name": "receiptNo", "type": "text",   "required": true },
           { "name": "lineNo",    "type": "number" }
         ],
         "elements": [
           { "id": "el-title", "type": "text", "x": 2, "y": 1, "w": 46, "h": 4, "rotation": 0, "zIndex": 3,
             "text": "收货标签 · GOODS RECEIPT",
             "font": { "family": "Microsoft YaHei", "size": 7, "color": "#000000", "align": "center", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-name", "type": "text", "x": 2, "y": 5.2, "w": 46, "h": 3.8, "rotation": 0, "zIndex": 3,
             "text": "{{skuName}}",
             "font": { "family": "Microsoft YaHei", "size": 6.5, "color": "#000000", "align": "left", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-bc", "type": "barcode", "x": 2, "y": 9.4, "w": 46, "h": 10, "rotation": 0, "zIndex": 5,
             "barcode": { "sym": "CODE128", "content": "{{skuCode}}", "showText": true, "textFont": { "family": "Arial", "size": 2.6 } } },
           { "id": "el-batch", "type": "text", "x": 2, "y": 20, "w": 46, "h": 3.2, "rotation": 0, "zIndex": 3,
             "text": "批号 {{batchNo}}",
             "font": { "family": "Microsoft YaHei", "size": 5.5, "color": "#000000", "align": "left", "vAlign": "middle", "wrap": false } },
           { "id": "el-qty", "type": "text", "x": 2, "y": 23.2, "w": 24, "h": 3.2, "rotation": 0, "zIndex": 3,
             "text": "数量 {{qty}}{{unit}}",
             "font": { "family": "Microsoft YaHei", "size": 6.5, "color": "#000000", "align": "left", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-src", "type": "text", "x": 26, "y": 23.2, "w": 22, "h": 3.2, "rotation": 0, "zIndex": 3,
             "text": "{{receiptNo}} · 行{{lineNo}}",
             "font": { "family": "Microsoft YaHei", "size": 4.5, "color": "#333333", "align": "right", "vAlign": "middle", "wrap": false } },
           { "id": "el-foot", "type": "text", "x": 2, "y": 26.8, "w": 46, "h": 2.2, "rotation": 0, "zIndex": 3,
             "text": "LabelFlow WMS · 收货标签",
             "font": { "family": "Microsoft YaHei", "size": 4, "color": "#666666", "align": "center", "vAlign": "middle", "wrap": false } }
         ],
         "print": { "copies": 1 }
       }$json$::jsonb AS content
      FROM tenants t
  ) AS seed
 WHERE x.tenant_id = seed.tenant_id
   AND x.code = 'RECEIPT_LABEL_V1'
   AND x.description = 'WMS 收货过账时逐行自动打印，每行一张；变量由 buildReceiptVariables 提供';
