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
import { makeBarcodeSvg, makeQrSvg, showTextIsTop } from './barcode';

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

function printBoxStyle(el: ElementData): string {
  const r = el.rotation ? `transform:rotate(${el.rotation}deg);transform-origin:center center;` : '';
  return `position:absolute;left:${el.x}mm;top:${el.y}mm;width:${el.w}mm;height:${el.h}mm;`
    + `z-index:${Math.round(el.zIndex ?? 1)};`
    + (el.opacity !== undefined && el.opacity !== 1 ? `opacity:${el.opacity};` : '') + r;
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
      const rows = Math.max(1, el.rows || 1);
      const cols = Math.max(1, el.cols || 1);
      const bw = el.showBorder === false ? 0 : (el.borderWidth ?? 0.2);
      const bc = el.borderColor || '#333';
      let cells = '';
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const raw = el.cells?.[idx] ?? '';
          const isHeader = !!el.headerRow && r === 0;
          cells += `<div style="display:flex;align-items:center;justify-content:${alignToJustify(el.font?.align)};
            padding:0 0.4mm;overflow:hidden;${printFontCss(el.font)}${isHeader ? 'font-weight:700;' : ''}
            ${isHeader ? `background:${el.headerBg || '#f2f2f2'};` : ''}
            ${bw ? `border-right:${c < cols - 1 ? `${bw}mm solid ${bc}` : 'none'};border-bottom:${r < rows - 1 ? `${bw}mm solid ${bc}` : 'none'}` : ''};">
            ${interpolateCellHtml(raw, ctx)}</div>`;
        }
      }
      return `<div style="${st}display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);
        background:#fff;${bw ? `border:${bw}mm solid ${bc};` : ''}overflow:hidden;">${cells}</div>`;
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
        z-index:${Math.round(el.zIndex ?? 1)};display:flex;flex-direction:${dir};overflow:hidden;">
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
      return `<div style="position:absolute;left:${el.x + off.x}mm;top:${el.y + off.y}mm;width:${size}mm;height:${size}mm;
        z-index:${Math.round(el.zIndex ?? 1)};">${svg}</div>`;
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
  const labels: string[] = [];
  let serial = opts.serialStart ?? 1;

  for (const row of data) {
    for (let c = 0; c < copies; c++) {
      const ctx = buildContext(template, row, {
        pageNo: labels.length + 1, pageTotal: labelCount, serialNo: serial, copies, uuid: opts.uuid,
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
      labels.push(`<div class="label">${parts.join('')}</div>`);
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

  let body = labels.join('');
  if (imposed) {
    const perSheet = cols * rowsN;
    const sheets: string[] = [];
    for (let i = 0; i < labels.length; i += perSheet) {
      const cells = labels.slice(i, i + perSheet)
        .map((l) => `<div class="slot">${l}</div>`).join('');
      sheets.push(`<div class="sheet">${cells}</div>`);
    }
    body = sheets.join('');
  }

  const sheetCss = imposed ? `
  .sheet { display: grid; grid-template-columns: repeat(${cols}, ${labelW}mm); grid-auto-rows: ${labelH}mm;
    gap: ${gapY}mm ${gapX}mm; padding: ${margin}mm; page-break-after: always; break-after: page; background: #fff; }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  .sheet .label { page-break-after: auto; break-after: auto; }
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
