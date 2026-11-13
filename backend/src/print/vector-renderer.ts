// =============================================================================
// vector-renderer.ts —— P8.2 整标签矢量 SVG 导出（纯函数，可 node --test 直跑）
//
// 【为什么是 SVG 而不是「把 HTML 截图」】
//   印刷级输出要求条码边缘是几何图形而非像素：放大到 600dpi 不糊、可被印前软件二次编辑。
//   本文件复用 html-renderer 的**同一套元素语义**与 RenderService 的求值结果
//   （变量/公式/流水号/系统变量已替换），但输出 SVG 几何，而不是 CSS 定位的 div。
//   条码/二维码直接内联 bwip-js 的 SVG（<path>/<rect>），不是位图。
//
// 【坐标】全部以 mm 对外，SVG viewBox 也用 mm 逻辑单位（width="40mm" height="30mm"
//   + viewBox="0 0 40 30"），保证 1 单位 = 1mm，sharp/pdf-lib 换算不会漂移。
//
// 【诚实边界】文本用 SVG <text>，字形依赖渲染端系统字体；中文缺字体时会退化为方块，
//   warnings 会提示。CMYK / 专色 / 出血 / 裁切线 / PDF 拆分合并均不在本层（见 docs/10 §10.28.3）。
// =============================================================================
import { renderBarcodeSvg, renderQrcodeSvg } from '../../core/barcode-renderer';
import { RenderService } from './render.service';

export const MAX_EXPORT_LABELS = 5000;

export interface VectorPage {
  widthMm: number;
  heightMm: number;
  dpi?: number;
  /** 拼版：列数 / 行数 / 间距 / 页边距，口径与 html-renderer 一致 */
  columns?: number;
  rows?: number;
  gapXMm?: number;
  gapYMm?: number;
  marginMm?: number;
}

export interface ExportInput {
  templateContent: { page: VectorPage; elements: any[] };
  rows?: Record<string, any>[];
  copies?: number;
  serialMap?: Record<string, string[]>;
}

export interface SheetLayout {
  sheets: string[];
  sheetWidthMm: number;
  sheetHeightMm: number;
  perSheet: number;
  cols: number;
  rows: number;
  labelCount: number;
  warnings: string[];
}

/** pt → mm（SVG 里 font-size 用 mm，避免 html-renderer 的 px 近似随 DPI 漂移） */
export function ptToMm(pt: number): number {
  const v = Number(pt);
  const size = Number.isFinite(v) && v > 0 ? v : 10;   // 非法/0 字号回退 10pt
  return Number((size * 25.4 / 72).toFixed(3));
}

function esc(s: any): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function n(v: any, d = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? Number(x.toFixed(3)) : d;
}

function svgDocument(wMm: number, hMm: number, body: string, whiteBg: boolean): string {
  const bg = whiteBg ? `<rect x="0" y="0" width="${n(wMm)}" height="${n(hMm)}" fill="#FFFFFF" />` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(wMm)}mm" height="${n(hMm)}mm" viewBox="0 0 ${n(wMm)} ${n(hMm)}">${bg}${body}</svg>`;
}

/** 去掉根 <svg> 壳，拿内部内容（用于嵌套 / translate） */
function innerOf(svg: string): string {
  return String(svg)
    .replace(/<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .trim();
}

/** 把 bwip-js 的 SVG（只有 viewBox，无 width/height）嵌到标签指定矩形里 */
function embedBwip(raw: string, x: number, y: number, w: number, h: number, mode: 'fill' | 'meet'): string {
  const vb = /viewBox="([^"]+)"/i.exec(raw)?.[1] ?? '0 0 1 1';
  const inner = innerOf(raw);
  const par = mode === 'fill' ? 'none' : 'xMidYMid meet';
  return `<svg x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" viewBox="${vb}" preserveAspectRatio="${par}">${inner}</svg>`;
}

/** anchorX 由调用方按 align 算好（center → x+w/2，right → x+w，left → x），本函数只负责画 */
function textLines(text: string, anchorX: number, y: number, sizeMm: number, font: any, color: string): string {
  const anchor = font?.align === 'center' ? 'middle' : font?.align === 'right' ? 'end' : 'start';
  const tx = anchorX;
  const weight = font?.bold ? ' font-weight="bold"' : '';
  const style = font?.italic ? ' font-style="italic"' : '';
  const deco = font?.underline ? ' text-decoration="underline"' : '';
  const family = esc(font?.family ?? 'Arial, Helvetica, sans-serif');
  const lines = String(text ?? '').split('\n');
  const tspans = lines.map((ln, i) =>
    `<tspan x="${n(tx)}" ${i === 0 ? `y="${n(y + sizeMm * 0.85)}"` : `dy="${n(sizeMm * 1.1)}"`}>${esc(ln)}</tspan>`,
  ).join('');
  return `<text font-family="${family}" font-size="${n(sizeMm)}" fill="${esc(color ?? '#000')}" text-anchor="${anchor}"${weight}${style}${deco}>${tspans}</text>`;
}

function renderElement(e: any, warnings: Set<string>): string {
  if (!e || e._skip === true || e.visible === false) return '';
  const x = n(e.x), y = n(e.y);
  const w = n(e.w ?? 3), h = n(e.h ?? 3);
  const rot = n(e.rotation ?? 0);
  const open = rot ? `<g transform="rotate(${rot} ${n(x + w / 2)} ${n(y + h / 2)})">` : '<g>';
  const close = '</g>';
  let body = '';

  switch (e.type) {
    case 'text':
    case 'richtext':
    case 'formula':
    case 'serial':
    case 'sysvar':
    case 'datetime': {
      const font = e.font ?? {};
      const sizeMm = ptToMm(font.size ?? 10);
      const color = font.color ?? (e.type === 'formula' ? '#531dab' : '#000000');
      const anchorX = font?.align === 'center' ? x + w / 2 : font?.align === 'right' ? x + w : x;
      body = textLines(String(e.rendered ?? e.text ?? ''), anchorX, y, sizeMm, font, color);
      break;
    }
    case 'rect': {
      const sw = n(e.stroke?.width ?? 0.5);
      body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${n(e.cornerRadius ?? 0)}" fill="${esc(e.fill ?? '#FFFFFF')}" stroke="${esc(e.stroke?.color ?? '#333333')}" stroke-width="${sw}" />`;
      break;
    }
    case 'ellipse': {
      const sw = n(e.stroke?.width ?? 0.5);
      body = `<ellipse cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}" fill="${esc(e.fill ?? '#FFFFFF')}" stroke="${esc(e.stroke?.color ?? '#333333')}" stroke-width="${sw}" />`;
      break;
    }
    case 'line': {
      const x2 = n(e.x2 ?? e.x + 10), y2 = n(e.y2 ?? e.y);
      const dash = e.stroke?.style === 'dashed' ? ' stroke-dasharray="2,1"' : e.stroke?.style === 'dotted' ? ' stroke-dasharray="0.5,0.5"' : '';
      body = `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="${esc(e.stroke?.color ?? '#333333')}" stroke-width="${n(e.stroke?.width ?? 0.5)}"${dash} />`;
      break;
    }
    case 'table': {
      const rowsN = Math.max(1, Math.round(n(e.rows ?? 3, 3)));
      const cols = Math.max(1, Math.round(n(e.cols ?? 3, 3)));
      const cw = w / cols, ch = h / rowsN;
      const border = e.showBorder !== false;
      const parts: string[] = [];
      for (let r = 0; r < rowsN; r++) {
        for (let c = 0; c < cols; c++) {
          const cx = x + c * cw, cy = y + r * ch;
          if (border) parts.push(`<rect x="${n(cx)}" y="${n(cy)}" width="${n(cw)}" height="${n(ch)}" fill="none" stroke="${esc(e.borderColor ?? '#333333')}" stroke-width="${n(e.borderWidth ?? 0.3)}" />`);
          const txt = String(e.cells?.[r * cols + c] ?? '');
          if (txt) parts.push(textLines(txt, cx + cw / 2, cy + ch / 2 - ptToMm(9) / 2, ptToMm(e.font?.size ?? 9), { ...e.font, align: 'center' }, e.font?.color ?? '#000000'));
        }
      }
      body = parts.join('');
      break;
    }
    case 'image': {
      const src = String(e.src ?? '');
      if (!src) { warnings.add(`图片元素 ${esc(String(e.id ?? ''))} 缺少 src，已跳过`); break; }
      if (/^https?:\/\//i.test(src)) warnings.add('存在外链图片：导出的 SVG/PDF 依赖对端地址可访问，建议改用 data:image/png;base64');
      body = `<image href="${esc(src)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" />`;
      break;
    }
    case 'barcode': {
      const spec = e.barcode ?? {};
      const content = String(e.rendered ?? spec.content ?? '');
      try {
        const raw = renderBarcodeSvg({ ...spec, content, showText: false } as any);
        // showText 时给明文留 3mm 高度，避免把条码压变形（与 html-renderer 同口径）
        const showText = !!spec.showText;
        const codeH = showText ? Math.max(1, h - 3) : h;
        body = embedBwip(raw, x, y, w, codeH, 'fill');
        if (showText) {
          body += textLines(content, x + w / 2, y + codeH, ptToMm(spec.textFont?.size ?? 8),
            { align: 'center', family: spec.textFont?.family ?? 'Arial' }, '#000000');
        }
      } catch (err: any) {
        warnings.add(`条码编码失败（${esc(String(spec.sym ?? ''))}）：${String(err?.message ?? err).slice(0, 120)}`);
        body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#b00" stroke-dasharray="1,1" />`;
      }
      break;
    }
    case 'qrcode': {
      const spec = e.qrcode ?? {};
      const content = String(e.rendered ?? spec.content ?? '');
      try {
        body = embedBwip(renderQrcodeSvg({ ...spec, content } as any), x, y, w, h, 'meet');
      } catch (err: any) {
        warnings.add(`二维码编码失败（${esc(String(spec.sym ?? ''))}）：${String(err?.message ?? err).slice(0, 120)}`);
        body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#b00" stroke-dasharray="1,1" />`;
      }
      break;
    }
    default:
      return '';
  }
  return `${open}${body}${close}`;
}

/** 单个标签 → SVG（不含背景，背景由 sheet 层统一铺，避免百分比 rect 在 <g> 里画满整页） */
export function renderLabelSvg(elements: any[], page: { widthMm: number; heightMm: number }): { svg: string; warnings: string[] } {
  const warnings = new Set<string>();
  const body = (elements ?? []).map((e) => renderElement(e, warnings)).filter(Boolean).join('');
  return { svg: svgDocument(n(page.widthMm), n(page.heightMm), body, false), warnings: [...warnings] };
}

/** 矩阵拼版：把 N 个标签按 cols×rows 排到 sheet 上（与 html-renderer 的口径一致） */
export function layoutSheets(labels: string[], page: VectorPage): SheetLayout {
  const cols = Math.max(1, Math.round(n(page.columns ?? 1, 1)));
  const rowsN = Math.max(1, Math.round(n(page.rows ?? 1, 1)));
  const gapX = Math.max(0, n(page.gapXMm ?? 2, 2));
  const gapY = Math.max(0, n(page.gapYMm ?? 2, 2));
  const margin = Math.max(0, n(page.marginMm ?? 0, 0));
  const w = n(page.widthMm), h = n(page.heightMm);
  const sheetW = margin * 2 + w * cols + gapX * (cols - 1);
  const sheetH = margin * 2 + h * rowsN + gapY * (rowsN - 1);
  const perSheet = cols * rowsN;
  const sheets: string[] = [];

  for (let i = 0; i < labels.length; i += perSheet) {
    const parts = labels.slice(i, i + perSheet).map((label, k) => {
      const c = k % cols, r = Math.floor(k / cols);
      const tx = margin + c * (w + gapX), ty = margin + r * (h + gapY);
      return `<g transform="translate(${n(tx)} ${n(ty)})">${innerOf(label)}</g>`;
    });
    sheets.push(svgDocument(sheetW, sheetH, parts.join(''), true));
  }
  return { sheets, sheetWidthMm: sheetW, sheetHeightMm: sheetH, perSheet, cols, rows: rowsN, labelCount: labels.length, warnings: [] };
}

/** 高层：模板 JSON + 数据行 → 已求值、已拼版的 SVG sheet 数组 */
export function buildExportSvgs(input: ExportInput): SheetLayout {
  const tpl = input.templateContent;
  if (!tpl?.page || !Array.isArray(tpl.elements)) throw new Error('templateContent 缺少 page / elements');
  const rows: any[] = Array.isArray(input.rows) && input.rows.length ? input.rows : [{}];
  // 导出不像打印任务那样把 copies 夹到 500：这里只按「总标签数」限流，让超限显式报错
  const copies = Math.max(1, Math.floor(Number(input.copies ?? 1) || 1));
  const count = rows.length * copies;
  if (count > MAX_EXPORT_LABELS) {
    throw new Error(`导出标签数 ${count} 超过上限 ${MAX_EXPORT_LABELS}，请分批导出`);
  }

  const render = new RenderService();
  const warnings = new Set<string>();
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows[i % rows.length];
    const sysVars = {
      printDate: new Date().toISOString().slice(0, 10),
      printTime: new Date().toISOString().slice(11, 19),
      pageNo: i + 1, pageTotal: count,
      copyIndex: Math.floor(i / rows.length),
      uuid: `export-${i + 1}`,
    };
    const rendered = render.renderRow(tpl.elements, row, input.serialMap ?? {}, sysVars, i);
    const one = renderLabelSvg(rendered, tpl.page);
    one.warnings.forEach((w) => warnings.add(w));
    labels.push(one.svg);
  }
  const layout = layoutSheets(labels, tpl.page);
  // 文本字形依赖渲染端字体，中文缺字会在栅格化时退化为方块，必须显式告知
  const hasCjk = (tpl.elements ?? []).some((e) => /[\u3400-\u9fff]/.test(String(e.text ?? e.rendered ?? '')));
  if (hasCjk) warnings.add('模板含中文文本：SVG 字形依赖渲染端系统字体，PDF 栅格化时缺中文字体会退化为方块，请安装中文字体或改用图像通道');
  warnings.add('SVG 为真矢量；PDF 由 SVG 按 600dpi 栅格化嵌入（非矢量 PDF），CMYK/专色/出血未支持');
  return { ...layout, warnings: [...warnings] };
}
