/**
 * D5 / U6：国家 UDI 数据库导出（Excel + XML）的纯函数层。
 *
 * 设计取舍：
 *  - 只做"导出文件"，不做自动上报：各省/国家平台的接口、鉴权、字段版本都不一致，
 *    没有客户所在平台的接口文档就无法承诺自动上报（docs/24 §3 明确不做）。
 *  - 字段映射集中在一处（UDI_DB_COLUMNS），前端/销售拿去对客户平台的模板即可，
 *    改字段只改这一张表，不散落在 Excel 与 XML 两个实现里。
 *  - XML 用自研的扁平 schema（UDIData/Record/Field），不是官方 schema 的伪造版本：
 *    字段名可直接映射，交付时按客户平台模板做 xslt/改名即可。
 */
import * as XLSX from 'xlsx';

export interface UdiExportRow {
  udiKey: string;
  gtin: string;
  productName?: string | null;
  spec?: string | null;
  lot?: string | null;
  serial?: string | null;
  productionDate?: string | null;
  expiryDate?: string | null;
  packageSscc?: string | null;
  workOrderNo?: string | null;
  templateCode?: string | null;
  printedAt?: string | null;
  createdAt?: string | null;
  status?: string | null;
}

/** 国家 UDI 数据库常用字段（中文名 + 英文键 + 长度/格式说明），交付时作为《字段映射表》 */
export const UDI_DB_COLUMNS: Array<{ key: keyof UdiExportRow; title: string; note: string }> = [
  { key: 'gtin', title: '产品标识（DI/GTIN）', note: 'GTIN-14，14 位数字字符串' },
  { key: 'productName', title: '产品名称', note: '与注册证一致，≤100 字符' },
  { key: 'spec', title: '规格型号', note: '物料编码或注册规格，≤100 字符' },
  { key: 'lot', title: '生产批号', note: '≤64 字符' },
  { key: 'serial', title: '序列号', note: '≤64 字符，单件唯一' },
  { key: 'productionDate', title: '生产日期', note: 'YYYY-MM-DD' },
  { key: 'expiryDate', title: '有效期止', note: 'YYYY-MM-DD' },
  { key: 'packageSscc', title: '包装标识（SSCC）', note: '18 位，箱/托层级' },
  { key: 'workOrderNo', title: '生产工单号', note: '内部工单，便于追溯' },
  { key: 'udiKey', title: 'UDI 单品键', note: 'GTIN|批号|序列号|有效期，内部主键' },
  { key: 'templateCode', title: '标签模板', note: '打印所用模板编号' },
  { key: 'printedAt', title: '打印时间', note: 'ISO8601；未打印为空' },
  { key: 'status', title: '状态', note: 'REGISTERED/PRINTED/ISSUED/…' },
  { key: 'createdAt', title: '建档时间', note: 'ISO8601' },
];

const d = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
const s = (v?: string | null) => (v == null ? '' : String(v));

/** Excel（.xlsx）：一页「UDI 明细」+ 一页「字段说明」，方便客户直接看映射 */
export function buildUdiXlsx(rows: UdiExportRow[], meta: { tenantId: number; since?: string; until?: string }): Buffer {
  const header = UDI_DB_COLUMNS.map((c) => c.title);
  const body = rows.map((r) => UDI_DB_COLUMNS.map((c) => {
    if (c.key === 'productionDate' || c.key === 'expiryDate') return d(r[c.key] as any);
    return s(r[c.key] as any);
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  ws['!cols'] = UDI_DB_COLUMNS.map((c) => ({ wch: Math.min(42, Math.max(12, c.title.length * 2)) }));
  XLSX.utils.book_append_sheet(wb, ws, 'UDI 明细');

  const spec = XLSX.utils.aoa_to_sheet([
    ['字段（中文）', '说明/格式'],
    ...UDI_DB_COLUMNS.map((c) => [c.title, c.note]),
    [],
    ['导出范围', `租户 ${meta.tenantId}${meta.since ? ` · 起 ${meta.since}` : ''}${meta.until ? ` · 止 ${meta.until}` : ''}`],
    ['生成时间', new Date().toISOString()],
    ['用途', '导入国家/省级 UDI 数据库，或作为向客户提供的合规台账'],
  ]);
  spec['!cols'] = [{ wch: 30 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, spec, '字段说明');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function xmlEscape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** XML：<UDIData tenant="" count=""><Record><Field name="GTIN">...</Field></Record></UDIData> */
export function buildUdiXml(rows: UdiExportRow[], meta: { tenantId: number; since?: string; until?: string }): string {
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<UDIData schema="labelflow-udi-export/1" tenant="${meta.tenantId}" count="${rows.length}"`
    + (meta.since ? ` since="${xmlEscape(meta.since)}"` : '')
    + (meta.until ? ` until="${xmlEscape(meta.until)}"` : '')
    + ` generatedAt="${new Date().toISOString()}">`,
  ];
  const body = rows.map((r) => {
    const fields = UDI_DB_COLUMNS.map((c) => {
      const v = (c.key === 'productionDate' || c.key === 'expiryDate') ? d(r[c.key] as any) : s(r[c.key] as any);
      return `    <Field name="${xmlEscape(String(c.key))}" title="${xmlEscape(c.title)}">${xmlEscape(v)}</Field>`;
    });
    return ['  <Record>', ...fields, '  </Record>'].join('\n');
  });
  return [...head, ...body, '</UDIData>', ''].join('\n');
}

/** 文件名：udi-export-<tenant>-YYYYMMDD.xlsx / .xml */
export function udiExportFilename(kind: 'xlsx' | 'xml', tenantId: number, now = new Date()): string {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `udi-export-t${tenantId}-${ymd}.${kind}`;
}
