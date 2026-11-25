-- =============================================================================
-- 装箱出码配套：SSCC 序列 + 箱标模板 CARTON_LABEL_V1
--
-- 1) sscc_serial_seq：装箱时生成 SSCC-18 用的全局序列（1 ~ 999999999）
-- 2) templates 种子 CARTON_LABEL_V1（100×70mm）：
--      标题 / 箱序 / 产品名 / 箱码 CODE128（= 箱码 GTIN）/ 数量 {{qty}}/{{packQty}}
--      尾箱标记 / 批号 / SKU / GS1-128 (00)SSCC / 页脚
--    变量由 wms/carton 装箱接口组装；qty 是"本箱实际件数"，尾箱时小于 packQty。
--
-- 幂等：序列 IF NOT EXISTS；模板首次插入，存量只覆盖"仍是种子描述"的行。
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS sscc_serial_seq START WITH 1 INCREMENT BY 1 NO MAXVALUE CACHE 1;

INSERT INTO templates (tenant_id, code, name, category, tags, description, schema_version, content)
SELECT t.id,
       'CARTON_LABEL_V1',
       '箱标签（装箱出码）',
       'wms',
       ARRAY['wms', 'carton', 'sscc'],
       'WMS 装箱出码时逐箱打印，变量由 carton-pack 组装；尾箱数量记真实件数',
       1,
       $json${
         "schemaVersion": 1,
         "page": { "widthMm": 100, "heightMm": 70, "dpi": 300, "orientation": 0, "unit": "mm" },
         "variables": [
           { "name": "gtin",        "type": "text",   "required": false, "validation": { "maxLength": 14 } },
           { "name": "sscc",        "type": "text",   "required": true,  "validation": { "pattern": "^\\d{18}$" } },
           { "name": "qty",         "type": "number", "required": true },
           { "name": "packQty",     "type": "number", "required": false },
           { "name": "unit",        "type": "text",   "defaultValue": "件" },
           { "name": "batchNo",     "type": "text",   "required": false },
           { "name": "productName", "type": "text",   "required": true },
           { "name": "skuCode",     "type": "text",   "required": false },
           { "name": "boxNo",       "type": "number", "required": false },
           { "name": "boxTotal",    "type": "number", "required": false },
           { "name": "tailText",    "type": "text",   "required": false }
         ],
         "elements": [
           { "id": "el-title", "type": "text", "x": 3, "y": 2.5, "w": 64, "h": 6.5, "rotation": 0, "zIndex": 3,
             "text": "箱标签 · CARTON",
             "font": { "family": "Microsoft YaHei", "size": 9, "color": "#000000", "align": "left", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-box", "type": "text", "x": 68, "y": 2.5, "w": 29, "h": 6.5, "rotation": 0, "zIndex": 3,
             "text": "箱 {{boxNo}}/{{boxTotal}}",
             "font": { "family": "Microsoft YaHei", "size": 8, "color": "#000000", "align": "right", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-name", "type": "text", "x": 3, "y": 9.5, "w": 94, "h": 7, "rotation": 0, "zIndex": 3,
             "text": "{{productName}}",
             "font": { "family": "Microsoft YaHei", "size": 10, "color": "#000000", "align": "left", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-bc-gtin", "type": "barcode", "x": 3, "y": 17, "w": 94, "h": 15, "rotation": 0, "zIndex": 5,
             "barcode": { "sym": "CODE128", "content": "{{gtin}}", "showText": true, "textFont": { "family": "Arial", "size": 3 } } },
           { "id": "el-qty", "type": "text", "x": 3, "y": 33, "w": 52, "h": 8.5, "rotation": 0, "zIndex": 3,
             "text": "{{qty}}/{{packQty}}{{unit}}",
             "font": { "family": "Microsoft YaHei", "size": 11, "color": "#000000", "align": "left", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-tail", "type": "text", "x": 56, "y": 33, "w": 41, "h": 8.5, "rotation": 0, "zIndex": 3,
             "text": "{{tailText}}",
             "font": { "family": "Microsoft YaHei", "size": 11, "color": "#000000", "align": "right", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-batch", "type": "text", "x": 3, "y": 42, "w": 52, "h": 6, "rotation": 0, "zIndex": 3,
             "text": "批号 {{batchNo}}",
             "font": { "family": "Microsoft YaHei", "size": 7.5, "color": "#000000", "align": "left", "vAlign": "middle", "wrap": false } },
           { "id": "el-sku", "type": "text", "x": 56, "y": 42, "w": 41, "h": 6, "rotation": 0, "zIndex": 3,
             "text": "{{skuCode}}",
             "font": { "family": "Arial", "size": 7.5, "color": "#000000", "align": "right", "vAlign": "middle", "wrap": false } },
           { "id": "el-bc-sscc", "type": "barcode", "x": 3, "y": 48.5, "w": 94, "h": 15, "rotation": 0, "zIndex": 5,
             "barcode": { "sym": "GS1_128", "content": "(00){{sscc}}", "moduleWidthMm": 0.3, "wideRatio": 2.5, "heightMm": 9, "showText": true, "textPosition": "bottom", "textFont": { "family": "Arial", "size": 3 } } },
           { "id": "el-foot", "type": "text", "x": 3, "y": 64.5, "w": 94, "h": 4, "rotation": 0, "zIndex": 3,
             "text": "LabelFlow WMS · 箱标签 · SSCC",
             "font": { "family": "Microsoft YaHei", "size": 4.5, "color": "#666666", "align": "center", "vAlign": "middle", "wrap": false } }
         ],
         "print": { "copies": 1 }
       }$json$::jsonb
FROM tenants t
WHERE NOT EXISTS (
    SELECT 1 FROM templates x WHERE x.tenant_id = t.id AND x.code = 'CARTON_LABEL_V1'
);

-- 修正存量：只覆盖"仍是种子描述"的模板
UPDATE templates x
   SET content = seed.content,
       schema_version = 1,
       updated_at = now()
  FROM (
    SELECT t.id AS tenant_id,
           $json${
         "schemaVersion": 1,
         "page": { "widthMm": 100, "heightMm": 70, "dpi": 300, "orientation": 0, "unit": "mm" },
         "variables": [
           { "name": "gtin",        "type": "text",   "required": false, "validation": { "maxLength": 14 } },
           { "name": "sscc",        "type": "text",   "required": true,  "validation": { "pattern": "^\\d{18}$" } },
           { "name": "qty",         "type": "number", "required": true },
           { "name": "packQty",     "type": "number", "required": false },
           { "name": "unit",        "type": "text",   "defaultValue": "件" },
           { "name": "batchNo",     "type": "text",   "required": false },
           { "name": "productName", "type": "text",   "required": true },
           { "name": "skuCode",     "type": "text",   "required": false },
           { "name": "boxNo",       "type": "number", "required": false },
           { "name": "boxTotal",    "type": "number", "required": false },
           { "name": "tailText",    "type": "text",   "required": false }
         ],
         "elements": [
           { "id": "el-title", "type": "text", "x": 3, "y": 2.5, "w": 64, "h": 6.5, "rotation": 0, "zIndex": 3,
             "text": "箱标签 · CARTON",
             "font": { "family": "Microsoft YaHei", "size": 9, "color": "#000000", "align": "left", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-box", "type": "text", "x": 68, "y": 2.5, "w": 29, "h": 6.5, "rotation": 0, "zIndex": 3,
             "text": "箱 {{boxNo}}/{{boxTotal}}",
             "font": { "family": "Microsoft YaHei", "size": 8, "color": "#000000", "align": "right", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-name", "type": "text", "x": 3, "y": 9.5, "w": 94, "h": 7, "rotation": 0, "zIndex": 3,
             "text": "{{productName}}",
             "font": { "family": "Microsoft YaHei", "size": 10, "color": "#000000", "align": "left", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-bc-gtin", "type": "barcode", "x": 3, "y": 17, "w": 94, "h": 15, "rotation": 0, "zIndex": 5,
             "barcode": { "sym": "CODE128", "content": "{{gtin}}", "showText": true, "textFont": { "family": "Arial", "size": 3 } } },
           { "id": "el-qty", "type": "text", "x": 3, "y": 33, "w": 52, "h": 8.5, "rotation": 0, "zIndex": 3,
             "text": "{{qty}}/{{packQty}}{{unit}}",
             "font": { "family": "Microsoft YaHei", "size": 11, "color": "#000000", "align": "left", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-tail", "type": "text", "x": 56, "y": 33, "w": 41, "h": 8.5, "rotation": 0, "zIndex": 3,
             "text": "{{tailText}}",
             "font": { "family": "Microsoft YaHei", "size": 11, "color": "#000000", "align": "right", "vAlign": "middle", "bold": true, "wrap": false } },
           { "id": "el-batch", "type": "text", "x": 3, "y": 42, "w": 52, "h": 6, "rotation": 0, "zIndex": 3,
             "text": "批号 {{batchNo}}",
             "font": { "family": "Microsoft YaHei", "size": 7.5, "color": "#000000", "align": "left", "vAlign": "middle", "wrap": false } },
           { "id": "el-sku", "type": "text", "x": 56, "y": 42, "w": 41, "h": 6, "rotation": 0, "zIndex": 3,
             "text": "{{skuCode}}",
             "font": { "family": "Arial", "size": 7.5, "color": "#000000", "align": "right", "vAlign": "middle", "wrap": false } },
           { "id": "el-bc-sscc", "type": "barcode", "x": 3, "y": 48.5, "w": 94, "h": 15, "rotation": 0, "zIndex": 5,
             "barcode": { "sym": "GS1_128", "content": "(00){{sscc}}", "moduleWidthMm": 0.3, "wideRatio": 2.5, "heightMm": 9, "showText": true, "textPosition": "bottom", "textFont": { "family": "Arial", "size": 3 } } },
           { "id": "el-foot", "type": "text", "x": 3, "y": 64.5, "w": 94, "h": 4, "rotation": 0, "zIndex": 3,
             "text": "LabelFlow WMS · 箱标签 · SSCC",
             "font": { "family": "Microsoft YaHei", "size": 4.5, "color": "#666666", "align": "center", "vAlign": "middle", "wrap": false } }
         ],
         "print": { "copies": 1 }
       }$json$::jsonb AS content
      FROM tenants t
  ) AS seed
 WHERE x.tenant_id = seed.tenant_id
   AND x.code = 'CARTON_LABEL_V1'
   AND x.description = 'WMS 装箱出码时逐箱打印，变量由 carton-pack 组装；尾箱数量记真实件数';
