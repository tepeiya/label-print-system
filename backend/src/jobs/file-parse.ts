// =============================================================================
// file-parse.ts —— HotFolder 落盘文件解析（纯函数，零 Nest 依赖）
//
// 为什么单独一层：HotFolder 的 bug 十有八九出在「文件还没写完就去读」「CSV 里有引号逗号/换行」
// 「JSON 是 {rows:[...]} 还是裸数组」。把解析做成可单测的纯函数，watch 回调只负责喂文本。
// 与 datasource.module.ts 的 parseCsv 是两处独立实现：那边服务于 HTTP 上传且带 Nest 装饰器，
// 这里必须能在 node --test 里裸跑，不引入 @nestjs/common。
// =============================================================================
import { MAX_DROP_ROWS } from './trigger.calc';

const MAX_CELL_LEN = 4000;

export interface DropRows {
  rows: Record<string, any>[];
  columns: string[];
  warnings: string[];
}

/** 健壮 CSV/TSV：引号包裹、引号内换行/逗号、"" 转义、CRLF；delim 为空时自动识别 */
export function parseDelimited(text: string, delimiter?: string): { header: string[]; rows: string[][] } {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let delim = delimiter;
  if (!delim) {
    const first = raw.split('\n').find((l) => l.trim()) ?? '';
    const candidates: Array<[string, number]> = [
      [',', (first.match(/,/g) ?? []).length],
      ['\t', (first.match(/\t/g) ?? []).length],
      [';', (first.match(/;/g) ?? []).length],
    ];
    delim = candidates.sort((a, b) => b[1] - a[1])[0][0];
  }

  const rows: string[][] = [];
  let field = '', row: string[] = [], inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const cleaned = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!cleaned.length) return { header: [], rows: [] };
  return { header: cleaned[0].map((h) => h.trim()), rows: cleaned.slice(1) };
}

function clip(v: any, warnings: Set<string>): string {
  const s = String(v ?? '');
  if (s.length > MAX_CELL_LEN) {
    warnings.add(`存在超过 ${MAX_CELL_LEN} 字符的单元格，已截断`);
    return s.slice(0, MAX_CELL_LEN);
  }
  return s;
}

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** 文件名 + 文本 → 数据行。不支持的扩展名/空文件直接抛错，由调用方移到 failed/ 目录 */
export function parseDropFile(name: string, text: string): DropRows {
  const ext = extOf(name);
  const warnings = new Set<string>();
  if (!['json', 'csv', 'tsv', 'txt'].includes(ext)) {
    throw new Error(`不支持的文件类型 .${ext || '(无)'}（仅 .json/.csv/.tsv/.txt）`);
  }
  if (!String(text ?? '').trim()) throw new Error('文件为空');

  let rows: Record<string, any>[];
  let columns: string[] = [];

  if (ext === 'json') {
    let parsed: any;
    try { parsed = JSON.parse(String(text)); }
    catch (e: any) {
      // 保留原始异常（tsconfig 的 lib 不含 ErrorOptions，用 cause 属性挂载）
      const err = new Error(`JSON 解析失败：${e?.message ?? e}`);
      (err as any).cause = e;
      throw err;
    }
    const list: any[] = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.rows) ? parsed.rows : [parsed]);
    rows = list.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) return item;
      return { value: item };
    });
    columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    rows = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v, warnings)])));
  } else if (ext === 'txt') {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    columns = ['value'];
    rows = lines.map((l) => ({ value: clip(l, warnings) }));
  } else {
    const { header, rows: cells } = parseDelimited(text, ext === 'tsv' ? '\t' : undefined);
    if (!header.length) throw new Error('CSV/TSV 缺少表头行');
    columns = header.map((h, i) => h || `col_${i + 1}`);
    rows = cells.map((r) => {
      const out: Record<string, any> = {};
      columns.forEach((c, i) => { out[c] = clip(r[i] ?? '', warnings); });
      return out;
    });
  }

  if (!rows.length) throw new Error('文件无有效数据行');
  if (rows.length > MAX_DROP_ROWS) {
    warnings.add(`行数 ${rows.length} 超过上限 ${MAX_DROP_ROWS}，仅取前 ${MAX_DROP_ROWS} 行`);
    rows = rows.slice(0, MAX_DROP_ROWS);
  }
  return { rows, columns, warnings: [...warnings] };
}
