// Excel 读写薄封装：优先用仓库自带的 xlsx（backend/node_modules），不额外装依赖。
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { norm } from './text.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const require = createRequire(import.meta.url);

export function loadXlsx() {
  const candidates = [
    process.env.LABELFLOW_XLSX,
    path.join(ROOT, 'backend/node_modules/xlsx'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c);
  }
  try {
    return require('xlsx');
  } catch {
    throw new Error('找不到 xlsx 库：请先 `cd backend && npm i`，或设置环境变量 LABELFLOW_XLSX 指向 xlsx 目录');
  }
}


/** 读取某个 sheet 为 {headers, rows:[{__row, ...}]}；第一行为表头，空行跳过 */
export function readSheet(wb, name) {
  const sh = wb.Sheets[name];
  if (!sh) return null;
  const aoa = loadXlsx().utils.sheet_to_json(sh, { header: 1, blankrows: false, defval: '' });
  if (!aoa.length) return { headers: [], rows: [] };
  const headers = aoa[0].map(norm);
  const rows = [];
  for (let i = 1; i < aoa.length; i += 1) {
    const raw = aoa[i];
    if (!raw || raw.every((c) => norm(c) === '')) continue;
    if (norm(raw[0]).startsWith('#')) continue; // 允许 # 开头的说明行
    const obj = { __row: i + 1 };
    headers.forEach((h, idx) => {
      if (h) obj[h] = raw[idx] === undefined ? '' : raw[idx];
    });
    rows.push(obj);
  }
  return { headers, rows };
}

/** 生成模板工作簿。sheets: [{name, header, rows:[], widths:[], note}] */
export function writeTemplate(file, sheets) {
  const XLSX = loadXlsx();
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([s.header, ...(s.rows || [])]);
    ws['!cols'] = (s.widths || []).map((w) => ({ wch: w }));
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  XLSX.writeFile(wb, file, { compression: true });
}

/** CSV 报告（带 BOM，Excel 直接打开不乱码） */
export function writeCsv(file, header, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))];
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n'), 'utf8');
}
