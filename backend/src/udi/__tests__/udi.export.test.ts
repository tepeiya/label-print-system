// D5/U6 单测：国家 UDI 导出（Excel / XML）与字段映射
// 约束：纯内存，不连库；真库导出走 curl 冒烟（docs/29）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { buildUdiXlsx, buildUdiXml, udiExportFilename, UDI_DB_COLUMNS, type UdiExportRow } from '../udi.export.calc';

const ROW: UdiExportRow = {
  udiKey: '06901234567892|LOT202611|SN0001|271231',
  gtin: '06901234567892',
  productName: '一次性使用无菌注射器',
  spec: '5ml',
  lot: 'LOT202611',
  serial: 'SN0001',
  productionDate: '2026-11-01',
  expiryDate: '2027-12-31',
  packageSscc: '006901234567890123',
  workOrderNo: 'WO-2026-001',
  templateCode: 'UDI-A',
  printedAt: '2026-11-20T02:00:00.000Z',
  createdAt: '2026-11-20T01:59:00.000Z',
  status: 'PRINTED',
};

test('字段映射表：14 个字段且 key 不重复（客户平台对齐用）', () => {
  assert.equal(UDI_DB_COLUMNS.length, 14);
  const keys = new Set(UDI_DB_COLUMNS.map((c) => c.key));
  assert.equal(keys.size, 14);
  // 国家 UDI 数据库必备：DI、名称、批号、序列号、生产日期、有效期
  for (const k of ['gtin', 'productName', 'lot', 'serial', 'productionDate', 'expiryDate']) {
    assert.ok(keys.has(k as any), `${k} 必须在映射表里`);
  }
});

test('buildUdiXlsx：两个 sheet（明细 + 字段说明），明细表头 14 列、数据行可被解析回来', () => {
  const buf = buildUdiXlsx([ROW], { tenantId: 7, since: '2026-11-01', until: '2026-11-30' });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);

  const wb = XLSX.read(buf, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['UDI 明细', '字段说明']);
  const ws = wb.Sheets['UDI 明细'];
  const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][];
  assert.equal(aoa[0].length, UDI_DB_COLUMNS.length);
  assert.equal(aoa[0][0], '产品标识（DI/GTIN）');
  assert.equal(aoa.length, 2);                        // 表头 + 1 行
  assert.equal(aoa[1][0], ROW.gtin);
  assert.equal(aoa[1][3], 'LOT202611');               // 生产批号列（gtin, 名称, 规格, 批号…）
  assert.equal(aoa[1][5], '2026-11-01');              // 生产日期已归一成 YYYY-MM-DD

  const spec = wb.Sheets['字段说明'];
  const specRows = XLSX.utils.sheet_to_json<string[]>(spec, { header: 1 }) as string[][];
  assert.ok(specRows.length >= UDI_DB_COLUMNS.length);
});

test('buildUdiXlsx：空数据仍产出合法文件（表头在、0 行数据）', () => {
  const wb = XLSX.read(buildUdiXlsx([], { tenantId: 7 }), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['UDI 明细'], { header: 1 }) as string[][];
  assert.equal(aoa.length, 1);
});

test('buildUdiXml：结构正确、属性带租户与条数、日期截断为 10 位', () => {
  const xml = buildUdiXml([ROW, { ...ROW, serial: 'SN0002' }], { tenantId: 7, since: '2026-11-01' });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(xml, /<UDIData schema="labelflow-udi-export\/1" tenant="7" count="2"/);
  assert.match(xml, /since="2026-11-01"/);
  assert.equal((xml.match(/<Record>/g) || []).length, 2);
  assert.equal((xml.match(/<Field /g) || []).length, 2 * UDI_DB_COLUMNS.length);
  assert.match(xml, /<Field name="gtin" title="产品标识（DI\/GTIN）">06901234567892<\/Field>/);
  assert.match(xml, /<Field name="productionDate" title="生产日期">2026-11-01<\/Field>/);
});

test('buildUdiXml：XML 特殊字符必须转义（产品名带 & < > 不能把文件弄坏）', () => {
  const xml = buildUdiXml([{ ...ROW, productName: 'A&B <C> "D" \'E\'' }], { tenantId: 7 });
  assert.ok(!xml.includes('A&B'), '& 未转义');
  assert.match(xml, /A&amp;B &lt;C\&gt; &quot;D&quot; &apos;E&apos;/);
});

test('udiExportFilename：带租户与日期，后缀跟随格式', () => {
  const now = new Date('2026-11-24T08:00:00Z');
  assert.equal(udiExportFilename('xlsx', 7, now), 'udi-export-t7-20261124.xlsx');
  assert.equal(udiExportFilename('xml', 7, now), 'udi-export-t7-20261124.xml');
});
