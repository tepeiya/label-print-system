// =============================================================================
// print.ts —— 打印态 HTML 生成（render.js#buildPrintHtml 的 TS 版）
//   单位用 mm / pt 交给浏览器做物理尺寸映射；拼版、份数、serial 递增同原生版。
//   设计器的「打印预览」和打印页共用这一份，避免两边所见不同。
// =============================================================================

import type { ElementData, TemplateData } from '../types';
import { escapeHtml } from './util';
import {
  alignToJustify, valignToAlign,
} from './styles';
import {
  buildContext, elementText, evalFormula, interpolate,
  type RenderContext,
} from './context';
import { normalizeRuns, renderRunsHtml } from './rich-text';
import { makeBarcodeSvg, makeQrSvg, showTextIsTop } from './barcode';
import { buildTableLayout } from './table-layout';

/** DB 字段 date:格式（与后端 render.service 同口径，简单 YYYY/MM/DD 占位替换） */
function formatDbDate(val: string, pattern: string): string {
  const d = new Date(val);
  if (isNaN(d.getTime())) return val;
  const p = (n: number) => String(n).padStart(2, '0');
  return String(pattern || 'YYYY-MM-DD')
    .replace(/YYYY/g, String(d.getFullYear())).replace(/MM/g, p(d.getMonth() + 1))
    .replace(/DD/g, p(d.getDate())).replace(/HH/g, p(d.getHours()))
    .replace(/mm/g, p(d.getMinutes())).replace(/ss/g, p(d.getSeconds()));
}

function printFontCss(font: ElementData['font']): string {
  const f = font || {};
  return `font-family:${cssFont(f.family || 'Arial')};font-size:${f.size ?? 9}pt;`
    + `font-weight:${f.bold ? 700 : 400};font-style:${f.italic ? 'italic' : 'normal'};`
    + `text-decoration:${f.underline ? 'underline' : 'none'};color:${f.color || '#000'};`
    + `line-height:${f.lineHeight ?? 1.15};`
    + (f.letterSpacing ? `letter-spacing:${f.letterSpacing}pt;` : '');
}

function cssFont(family: unknown): string {
  // 结果会写进 style="..."，只能用单引号，避免破坏属性结构
  const safe = String(family || 'Arial').replace(/["'<>]/g, '');
  return `'${safe}', sans-serif`;
}

/** 旋转样式：设计态 boxStyle / 打印态所有元素共用同一口径，避免条码二维码漏转 */
function printRotateStyle(el: ElementData): string {
  return el.rotation ? `transform:rotate(${el.rotation}deg);transform-origin:center center;` : '';
}

function printBoxStyle(el: ElementData): string {
  return `position:absolute;left:${el.x}mm;top:${el.y}mm;width:${el.w}mm;height:${el.h}mm;`
    + `z-index:${Math.round(el.zIndex ?? 1)};`
    + (el.opacity !== undefined && el.opacity !== 1 ? `opacity:${el.opacity};` : '') + printRotateStyle(el);
}

function barcodeTextHtml(spec: ElementData['barcode'], content: string): string {
  if (!spec?.showText) return '';
  return `<div style="flex:0 0 auto;text-align:center;font-family:${spec?.textFont?.family || 'Arial'},sans-serif;`
    + `font-size:${spec?.textFont?.size ?? 2.6}mm;line-height:1.15;overflow:hidden;white-space:nowrap;">`
    + `${escapeHtml(content)}</div>`;
}

function printElement(el: ElementData, ctx: RenderContext): string {
  const st = printBoxStyle(el);
  switch (el.type) {
    case 'rect': {
      const border = el.stroke && (el.stroke.width ?? 0) > 0
        ? `border:${el.stroke.width}mm ${el.stroke.style || 'solid'} ${el.stroke.color || '#333'};`
        : 'border:none;';
      return `<div style="${st}background:${el.fill ?? '#fff'};border-radius:${el.cornerRadius ?? 0}mm;${border}"></div>`;
    }
    case 'ellipse': {
      const border = el.stroke && (el.stroke.width ?? 0) > 0
        ? `border:${el.stroke.width}mm ${el.stroke.style || 'solid'} ${el.stroke.color || '#333'};`
        : 'border:none;';
      return `<div style="${st}background:${el.fill ?? '#fff'};border-radius:50%;${border}"></div>`;
    }
    case 'line': {
      const dx = (el.x2 ?? el.x) - el.x;
      const dy = (el.y2 ?? el.y) - el.y;
      const len = Math.hypot(dx, dy);
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const sw = el.stroke?.width ?? 0.3;
      const dash = el.stroke?.style === 'dashed' ? 'stroke-dasharray="0.8 0.6"'
        : el.stroke?.style === 'dotted' ? 'stroke-dasharray="0.2 0.4"' : '';
      return `<div style="position:absolute;left:${el.x}mm;top:${el.y}mm;width:${len}mm;height:${sw}mm;
        transform:rotate(${angle}deg);transform-origin:0 50%;z-index:${Math.round(el.zIndex ?? 1)};">
        <svg width="${len}mm" height="${sw * 3}mm" viewBox="0 0 ${len} ${sw * 3}" preserveAspectRatio="none" style="overflow:visible;display:block">
          <line x1="0" y1="${sw * 1.5}" x2="${len}" y2="${sw * 1.5}" stroke="${el.stroke?.color || '#333'}" stroke-width="${sw}" ${dash} />
        </svg></div>`;
    }
    case 'table': {
      const cols = Math.max(1, el.cols || 1);
      const bw = el.showBorder === false ? 0 : (el.borderWidth ?? 0.2);
      const bc = el.borderColor || '#333';
      // 第四层：用 grid 行列定位 + 合并跨度定位，被合并格跳过绘制
      const layout = buildTableLayout(el.rows || 1, cols, el.mergedCells);
      const wrap = el.cellWrap === false ? 'white-space:nowrap;' : 'white-space:pre-wrap;word-break:break-word;';
      let cells = '';
      for (let r = 0; r < layout.rows; r++) {
        for (let c = 0; c < layout.cols; c++) {
          if (layout.skipped.includes(`${r},${c}`)) continue;
          const span = layout.spans[`${r},${c}`] ?? { rowSpan: 1, colSpan: 1 };
          const idx = r * cols + c;
          const raw = el.cells?.[idx] ?? '';
          const isHeader = !!el.headerRow && r === 0;
          cells += `<div style="grid-row:${r + 1}/span ${span.rowSpan};grid-column:${c + 1}/span ${span.colSpan};
            display:flex;align-items:center;justify-content:${alignToJustify(el.font?.align)};
            padding:0 0.4mm;overflow:hidden;${printFontCss(el.font)}${wrap}${isHeader ? 'font-weight:700;' : ''}
            ${isHeader ? `background:${el.headerBg || '#f2f2f2'};` : ''}
            ${bw ? `border-right:${c + span.colSpan - 1 < layout.cols - 1 ? `${bw}mm solid ${bc}` : 'none'};border-bottom:${r + span.rowSpan - 1 < layout.rows - 1 ? `${bw}mm solid ${bc}` : 'none'}` : ''};">
            ${interpolateCellHtml(raw, ctx)}</div>`;
        }
      }
      return `<div style="${st}display:grid;grid-template-columns:repeat(${layout.cols},1fr);grid-template-rows:repeat(${layout.rows},1fr);
        background:#fff;${bw ? `border:${bw}mm solid ${bc};` : ''}overflow:hidden;">${cells}</div>`;
    }
    case 'richtext': {
      const runs = normalizeRuns(el.runs, el.text);
      const html = renderRunsHtml(runs, el.font ?? {}, {
        interp: (s: string) => interpolate(s, ctx),
        esc: escapeHtml,
      });
      const align = el.font?.align || 'left';
      const vAlign = el.font?.vAlign || 'middle';
      return `<div style="${st}display:flex;align-items:${valignToAlign(vAlign)};justify-content:${alignToJustify(align)};overflow:hidden;">
        <div style="${printFontCss(el.font)}width:100%;white-space:${el.font?.wrap === false ? 'nowrap' : 'pre-wrap'};text-align:${align};">${html}</div></div>`;
    }
    case 'dbField': {
      const d = (el.dbField ?? {}) as NonNullable<ElementData['dbField']>;
      let val = interpolate(d.field ?? '', ctx);
      const fmt = String(d.format ?? '');
      if (fmt.startsWith('date:')) val = formatDbDate(val, fmt.slice(5));
      else if (fmt === 'upper') val = val.toUpperCase();
      else if (fmt === 'lower') val = val.toLowerCase();
      else if (/^num:\d+$/.test(fmt)) { const n = Number(val); val = Number.isFinite(n) ? n.toFixed(Number(fmt.slice(4))) : val; }
      if (!val) val = d.fallback ?? '';
      const align = el.font?.align || 'left';
      const vAlign = el.font?.vAlign || 'middle';
      return `<div style="${st}display:flex;align-items:${valignToAlign(vAlign)};justify-content:${alignToJustify(align)};overflow:hidden;">
        <div style="${printFontCss(el.font)}width:100%;white-space:${el.font?.wrap === false ? 'nowrap' : 'pre-wrap'};text-align:${align};">${escapeHtml(val)}</div></div>`;
    }
    case 'image': {
      if (!el.src) return '';
      return `<div style="${st}"><img src="${escapeHtml(el.src)}" style="width:100%;height:100%;object-fit:contain;display:block" /></div>`;
    }
    case 'barcode': {
      const content = interpolate(el.barcode?.content ?? '', ctx);
      const r = makeBarcodeSvg(el.barcode, content);
      const svg = r.svgStr.replace('<svg ', '<svg preserveAspectRatio="none" style="width:100%;height:100%;display:block" ');
      const dir = showTextIsTop(el.barcode) ? 'column-reverse' : 'column';
      return `<div style="position:absolute;left:${el.x}mm;top:${el.y}mm;width:${el.w}mm;height:${el.h}mm;
        z-index:${Math.round(el.zIndex ?? 1)};display:flex;flex-direction:${dir};overflow:hidden;${printRotateStyle(el)}">
        <div style="flex:1 1 auto;min-height:0;">${svg}</div>${barcodeTextHtml(el.barcode, content)}</div>`;
    }
    case 'qrcode': {
      const content = interpolate(el.qrcode?.content ?? '', ctx);
      if (!content) return '';
      const r = makeQrSvg(el.qrcode, content);
      const quiet = Math.max(0, el.qrcode?.quietZoneMm ?? 1);
      const size = Math.max(4, Math.min(el.w, el.h) - quiet * 2);
      const off = { x: (el.w - size) / 2, y: (el.h - size) / 2 };
      const svg = r.svgStr.replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" ');
      // 旋转必须围绕「元素盒中心」而非内层二维码方块中心：外层包一层与元素同尺寸的盒子承载 rotate，
      // 内层按静区偏移定位，这样旋转轴心与 boxStyle / 后端渲染一致（否则 90° 后会偏位）。
      return `<div style="${printBoxStyle(el)}overflow:visible;">
        <div style="position:absolute;left:${off.x}mm;top:${off.y}mm;width:${size}mm;height:${size}mm;">${svg}</div></div>`;
    }
    default: {
      const align = el.font?.align || 'left';
      const vAlign = el.font?.vAlign || 'middle';
      const txt = escapeHtml(elementText(el, ctx));
      return `<div style="${st}display:flex;align-items:${valignToAlign(vAlign)};justify-content:${alignToJustify(align)};overflow:hidden;">
        <div style="${printFontCss(el.font)}width:100%;white-space:${el.font?.wrap === false ? 'nowrap' : 'pre-wrap'};text-align:${align};">${txt}</div></div>`;
    }
  }
}

function interpolateCellHtml(raw: unknown, ctx: RenderContext): string {
  return String(raw ?? '').split(/(\{\{[^}]+\}\})/g).map((p) => {
    if (!p) return '';
    if (/^\{\{[^}]+\}\}$/.test(p)) return escapeHtml(interpolate(p, ctx));
    return escapeHtml(p);
  }).join('');
}

export interface PrintHtmlOptions {
  copies?: number;
  serialStart?: number;
  title?: string;
  uuid?: string;
}

/** 生成可打印 HTML（含 @page 尺寸与拼版） */
export function buildPrintHtml(template: TemplateData, rows: Record<string, unknown>[], opts: PrintHtmlOptions = {}): string {
  const page = template.page;
  const data = rows && rows.length ? rows : [{}];
  const copies = Math.max(1, opts.copies ?? 1);
  const labelCount = data.length * copies;
  const duplex = page.duplex === true;
  const labels: string[] = [];
  const backLabels: string[] = [];
  let serial = opts.serialStart ?? 1;
  // 主流水号元素配置，供 @serial 占位引用（与 serial 元素显示一致；无则回退默认 5 位补零）
  const mainSerial = (template.elements ?? []).find((e) => e.type === 'serial' && e.serial) as { serial?: any } | undefined;

  for (const row of data) {
    for (let c = 0; c < copies; c++) {
      const ctx = buildContext(template, row, {
        pageNo: labels.length + 1, pageTotal: labelCount, serialNo: serial, copies, uuid: opts.uuid,
        _serialSpec: mainSerial?.serial,
      });
      const visible = template.elements
        .filter((e) => e.visible !== false)
        .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
      const parts: string[] = [];
      for (const el of visible) {
        if (el.printIf && el.printIf.trim()) {
          const cond = evalFormula(el.printIf, ctx);
          if (cond === 'false' || cond === '0' || cond === null) continue;
        }
        parts.push(printElement(el, ctx));
      }
      const inner = parts.join('');
      labels.push(`<div class="label">${inner}</div>`);
      // 双面：背面页承载同样的内容，由 CSS 水平镜像。打印机按「短边翻转」把相邻两页
      // 印到同一张纸的正反面，镜像保证从背面看文字/条码是正向可读的。
      if (duplex) backLabels.push(`<div class="label label-back">${inner}</div>`);
      serial++;
    }
  }

  const cols = Math.max(1, Math.round(page.columns ?? 1));
  const rowsN = Math.max(1, Math.round(page.rows ?? 1));
  const gapX = Math.max(0, page.gapXMm ?? 2);
  const gapY = Math.max(0, page.gapYMm ?? 2);
  const margin = Math.max(0, page.marginMm ?? 0);
  const labelW = page.widthMm;
  const labelH = page.heightMm;
  const sheetW = cols > 1 ? margin * 2 + labelW * cols + gapX * (cols - 1) : labelW;
  const sheetH = rowsN > 1 ? margin * 2 + labelH * rowsN + gapY * (rowsN - 1) : labelH;
  const imposed = cols > 1 || rowsN > 1;

  // 拼版分组：把标签序列按每页容量切成若干 sheet
  const toSheets = (list: string[]): string[] => {
    const perSheet = cols * rowsN;
    const sheets: string[] = [];
    for (let i = 0; i < list.length; i += perSheet) {
      const cells = list.slice(i, i + perSheet)
        .map((l) => `<div class="slot">${l}</div>`).join('');
      sheets.push(`<div class="sheet">${cells}</div>`);
    }
    return sheets;
  };

  let body: string;
  if (duplex) {
    // 正反面交替：正面页 → 对应背面页 → 下一张正面页……
    // 浏览器「双面-短边翻转」会把相邻两页印到同一张纸两面；背面页由 .label-back 水平镜像。
    if (imposed) {
      const frontSheets = toSheets(labels);
      const backSheets = toSheets(backLabels);
      const paired: string[] = [];
      for (let i = 0; i < frontSheets.length; i++) {
        paired.push(frontSheets[i]);
        if (backSheets[i]) paired.push(backSheets[i]);
      }
      body = paired.join('');
    } else {
      const paired: string[] = [];
      for (let i = 0; i < labels.length; i++) {
        paired.push(labels[i]);
        if (backLabels[i]) paired.push(backLabels[i]);
      }
      body = paired.join('');
    }
  } else if (imposed) {
    body = toSheets(labels).join('');
  } else {
    body = labels.join('');
  }

  const sheetCss = imposed ? `
  .sheet { display: grid; grid-template-columns: repeat(${cols}, ${labelW}mm); grid-auto-rows: ${labelH}mm;
    gap: ${gapY}mm ${gapX}mm; padding: ${margin}mm; page-break-after: always; break-after: page; background: #fff; }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  .sheet .label { page-break-after: auto; break-after: auto; }
` : '';
  // 背面镜像规则仅在双面时输出，单面 HTML 不含任何背面标记
  const duplexCss = duplex ? `
  /* 双面背面：短边翻转后从纸背看需水平镜像才正向可读；容器只翻一次，内部元素照常布局 */
  .label-back { transform: scaleX(-1); transform-origin: center center; }
  @media screen { .label-back { box-shadow: 0 2px 8px rgba(0,0,0,.15), inset 0 0 0 2px #f0b429; } }
` : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(opts.title || 'LabelFlow 打印')}</title>
<style>
  @page { size: ${sheetW}mm ${sheetH}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .label { position: relative; width: ${labelW}mm; height: ${labelH}mm; overflow: hidden; background: #fff;
    page-break-after: always; break-after: page; }
  .label:last-child { page-break-after: auto; break-after: auto; }
  ${duplexCss}
  ${sheetCss}
  @media screen { body { padding: 12px; background: #e9edf3; } .label, .sheet { margin: 0 auto ${imposed ? 18 : 12}px; box-shadow: 0 2px 8px rgba(0,0,0,.15); } }
</style></head>
<body>${body}</body></html>`;
}

// ---------------------------------------------------------------------------
// 打印数据解析（print.js#parseData / splitDelimited）
//   JSON（对象或数组）优先，其余按分隔符表格处理：制表符 > 分号 > 逗号。
//   Excel 需要 SheetJS，Console 侧不引第三方，留给用户「另存为 CSV」这条路。
// ---------------------------------------------------------------------------
export interface ParsedData {
  rows: Record<string, unknown>[];
  headers: string[];
}

export function parseData(text: unknown): ParsedData {
  const src = String(text ?? '').trim();
  if (!src) return { rows: [], headers: [] };
  if (src.startsWith('[') || src.startsWith('{')) {
    const j = JSON.parse(src) as unknown;
    const rows = (Array.isArray(j) ? j : [j]).map((r) => (r && typeof r === 'object' ? r as Record<string, unknown> : { value: r }));
    return { rows, headers: Object.keys(rows[0] ?? {}) };
  }
  const lines = src.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { rows: [], headers: [] };
  const first = lines[0];
  const delim = first.includes('\t') ? '\t' : (first.includes(';') && !first.includes(',')) ? ';' : ',';
  const cells = splitDelimited(src, delim);
  const header = (cells[0] ?? []).map((hd) => String(hd).trim());
  const rows = cells.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => {
      const obj: Record<string, unknown> = {};
      header.forEach((hd, i) => { obj[hd || `列${i + 1}`] = r[i] ?? ''; });
      return obj;
    });
  return { rows, headers: header };
}

/** 支持引号、引号内分隔符/换行、"" 转义、BOM */
function splitDelimited(text: string, delim: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((c) => String(c).trim() !== ''));
}
