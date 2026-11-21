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
import { buildLabelPlan } from './impose';
import type { ComputedVariable } from '../../core/computed-vars';
import { runsToPlainText } from '../../core/rich-text';
import { buildTableLayout } from '../../core/table-layout';

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
  templateContent: { page: VectorPage; elements: any[]; variables?: ComputedVariable[] };
  rows?: Record<string, any>[];
  copies?: number;
  serialMap?: Record<string, string[]>;
  /**
   * P8.3 水印 SVG 层（已由 governance.calc.watermarkSvgLayer 生成并转义）。
   * 渲染器只负责拼接到标签最上层，不重新计算几何 —— 预览/导出/打印同源。
   */
  watermarkLayer?: string;
  /**
   * 第二层：交叉合并顺序。
   *   true （默认）= 逐份交叉 ABC/ABC（保持既有行为）
   *   false        = 按行堆叠 AA/BB/CC
   */
  collate?: boolean;
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

/**
 * 第二层：弧形文字。沿一段圆弧排布文本（SVG <textPath> 真曲线）。
 * curve: { enabled, radiusMm, sweepDeg, direction?: 'up'|'down' }
 *   radiusMm  ≥ 元素宽/2；sweepDeg ≤ 180；direction=up 向上拱（圆心在下方），down 反之。
 * 返回含 <defs><path>（唯一 id）+ <text><textPath> 的 SVG 片段。
 */
let arcSeq = 0;
function arcTextSvg(
  text: string, e: any, x: number, y: number, w: number, h: number, sizeMm: number, font: any, color: string,
): string {
  const c = e.curve ?? {};
  const radius = Math.max(w / 2, Math.max(4, n(c.radiusMm ?? w, w)));
  const sweep = Math.max(10, Math.min(180, n(c.sweepDeg ?? 60, 60)));
  const up = (c.direction ?? 'up') !== 'down';
  const cx = x + w / 2;
  // 圆心：向上拱 → 在元素框下方 radius 处；向下拱 → 在上方 radius 处
  const cy = up ? y + h + radius : y - radius;
  const half = (sweep * Math.PI) / 360; // 半角弧度
  // 圆弧左右端点（相对圆心，极坐标）；SVG y 向下
  const sign = up ? -1 : 1;
  const x1 = cx - radius * Math.sin(half), y1 = cy + sign * radius * Math.cos(half);
  const x2 = cx + radius * Math.sin(half), y2 = y1;
  const largeArc = sweep > 180 ? 1 : 0;
  const sweepFlag = up ? 1 : 0; // 顺/逆时针
  const d = `M ${n(x1)} ${n(y1)} A ${n(radius)} ${n(radius)} 0 ${largeArc} ${sweepFlag} ${n(x2)} ${n(y2)}`;
  const id = `arc-${Date.now().toString(36)}-${arcSeq++}`;
  const anchor = font?.align === 'right' ? 'end' : font?.align === 'left' ? 'start' : 'middle';
  const offset = font?.align === 'right' ? '100%' : font?.align === 'left' ? '0%' : '50%';
  const weight = font?.bold ? ' font-weight="bold"' : '';
  const style = font?.italic ? ' font-style="italic"' : '';
  const family = esc(font?.family ?? 'Arial, Helvetica, sans-serif');
  return `<defs><path id="${id}" d="${d}" fill="none" /></defs>` +
    `<text font-family="${family}" font-size="${n(sizeMm)}" fill="${esc(color ?? '#000')}"${weight}${style}>` +
    `<textPath href="#${id}" startOffset="${offset}" text-anchor="${anchor}">${esc(text)}</textPath></text>`;
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

/**
 * 第二层：弧形条码（近似）。把 bwip 一维码的每根竖线沿弧线摆放：
 * 第 i 根线按其横坐标相对条码中心的偏移换算成圆心角，绕圆心旋转到法线方向。
 * 注意：这是视觉近似（条宽沿弧线非严格等距），不是标准 GS1 弧形码；
 * 解码需真机验证，warnings 会明确标注。二维码不做弧形（无语义）。
 */
function arcBarcodeSvg(
  raw: string, spec: any, content: string, x: number, y: number, w: number, h: number,
): string {
  const c = spec.curve ?? {};
  const radius = Math.max(w, Math.max(10, n(c.radiusMm ?? w * 1.2, w * 1.2)));
  const cx = x + w / 2;
  const cy = y + h + radius; // 圆心在条码下方
  const d = /<path[^>]*d="([^"]+)"/i.exec(raw)?.[1] ?? '';
  const segRe = /M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g;
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/i.exec(raw);
  const vbW = vb ? +vb[1] : 1;
  const xs: number[] = [];
  let m: RegExpExecArray | null;
  const segXs: number[] = [];
  while ((m = segRe.exec(d))) { segXs.push(+m[1]); xs.push(+m[1], +m[3]); }
  if (!segXs.length || vbW <= 0) return '';
  const minX = Math.min(...xs), maxX = Math.max(...xs), span = maxX - minX || 1;
  // 从 <path stroke-width> 取条宽（取中位，bwip 同码用多档宽度近似）
  const widths = [...raw.matchAll(/stroke-width="([\d.]+)"/gi)].map((mm) => +mm[1]).sort((a, b) => a - b);
  const midWidth = widths.length ? widths[Math.floor(widths.length / 2)] : 3;
  // 逐根线：横坐标按 viewBox 比例映射到元素宽，旋转角 = 相对中心偏移 / radius（弧度→度）
  const out: string[] = [];
  for (const x1 of segXs) {
    const lx = x + ((x1 - minX) / span) * w; // 线在元素框内的横坐标
    const angle = ((lx - cx) / radius) * (180 / Math.PI);
    out.push(`<line x1="${n(lx)}" y1="${n(y)}" x2="${n(lx)}" y2="${n(y + h)}" stroke="#000" stroke-width="${n((midWidth / vbW) * w)}" transform="rotate(${n(angle)} ${n(cx)} ${n(cy)})" />`);
  }
  if (spec.showText) {
    out.push(textLines(content, cx, y + h, ptToMm(spec.textFont?.size ?? 8), { align: 'center' }, '#000000'));
  }
  return out.join('');
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
    case 'dbField':
    case 'formula':
    case 'serial':
    case 'sysvar':
    case 'datetime': {
      const font = e.font ?? {};
      const sizeMm = ptToMm(font.size ?? 10);
      const color = font.color ?? (e.type === 'formula' ? '#531dab' : '#000000');
      const anchorX = font?.align === 'center' ? x + w / 2 : font?.align === 'right' ? x + w : x;
      const label = e.type === 'richtext' && Array.isArray(e.runs)
        ? runsToPlainText(e.runs)
        : String(e.rendered ?? e.text ?? '');
      if (e.type === 'richtext' && Array.isArray(e.runs) && e.runs.some((r: any) => r.bold || r.italic || r.underline || r.color || r.script)) {
        warnings.add(`富文本元素 ${esc(String(e.id ?? ''))}：SVG 矢量导出暂降级为纯文本（逐 run 样式保留在 HTML/打印预览与矢量 PDF），此处仅保留文字内容`);
      }
      if (e.curve?.enabled && label && !label.includes('\n')) {
        body = arcTextSvg(label, e, x, y, w, h, sizeMm, font, color);
        warnings.add(`弧形文字元素 ${esc(String(e.id ?? ''))}：SVG textPath 真曲线；PDF/指令通道不支持弧形，将退化为直线`);
      } else {
        body = textLines(label, anchorX, y, sizeMm, font, color);
      }
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
      // 第四层：合并单元格——跳过被覆盖格，主格按 span 画边框与居中文字
      const layout = buildTableLayout(rowsN, cols, e.mergedCells);
      const parts: string[] = [];
      for (let r = 0; r < rowsN; r++) {
        for (let c = 0; c < cols; c++) {
          if (layout.skipped.includes(`${r},${c}`)) continue;
          const span = layout.spans[`${r},${c}`] ?? { rowSpan: 1, colSpan: 1 };
          const cx = x + c * cw, cy = y + r * ch;
          const bw = span.colSpan * cw, bh = span.rowSpan * ch;
          if (border) parts.push(`<rect x="${n(cx)}" y="${n(cy)}" width="${n(bw)}" height="${n(bh)}" fill="none" stroke="${esc(e.borderColor ?? '#333333')}" stroke-width="${n(e.borderWidth ?? 0.3)}" />`);
          const txt = String(e.cells?.[r * cols + c] ?? '');
          if (txt) parts.push(textLines(txt, cx + bw / 2, cy + bh / 2 - ptToMm(9) / 2, ptToMm(e.font?.size ?? 9), { ...e.font, align: 'center' }, e.font?.color ?? '#000000'));
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
        if (e.curve?.enabled) {
          // 弧形条码：视觉近似，需真机解码验证
          const arcSpec = { ...spec, showText, curve: e.curve };
          body = arcBarcodeSvg(raw, arcSpec, content, x, y, w, codeH);
          if (!body) throw new Error('弧线路径解析失败');
          warnings.add(`弧形条码元素 ${esc(String(e.id ?? ''))}：视觉近似、非标准弧形码；解码兼容性需真机验证，指令通道退化为直线`);
        } else {
          body = embedBwip(raw, x, y, w, codeH, 'fill');
          if (showText) {
            body += textLines(content, x + w / 2, y + codeH, ptToMm(spec.textFont?.size ?? 8),
              { align: 'center', family: spec.textFont?.family ?? 'Arial' }, '#000000');
          }
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
export function renderLabelSvg(
  elements: any[], page: { widthMm: number; heightMm: number }, watermarkLayer?: string,
): { svg: string; warnings: string[] } {
  const warnings = new Set<string>();
  const body = (elements ?? []).map((e) => renderElement(e, warnings)).filter(Boolean).join('');
  // 水印放最后 → 叠在所有元素之上；来自治理层的字符串已 XML 转义，此处不再处理
  const withWatermark = watermarkLayer ? `${body}${watermarkLayer}` : body;
  return { svg: svgDocument(n(page.widthMm), n(page.heightMm), withWatermark, false), warnings: [...warnings] };
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
  // 第二层：用统一的顺序计划展开。默认 collate=true 时与旧逻辑 rows[i % rows.length] 完全等价
  const plan = buildLabelPlan(rows.length, copies, input.collate !== false);
  const count = plan.length;
  if (count > MAX_EXPORT_LABELS) {
    throw new Error(`导出标签数 ${count} 超过上限 ${MAX_EXPORT_LABELS}，请分批导出`);
  }

  const render = new RenderService();
  const warnings = new Set<string>();
  const labels: string[] = [];
  for (const { index: i, rowIndex, copyIndex } of plan) {
    const row = rows[rowIndex];
    const sysVars = {
      printDate: new Date().toISOString().slice(0, 10),
      printTime: new Date().toISOString().slice(11, 19),
      pageNo: i + 1, pageTotal: count,
      copyIndex,
      uuid: `export-${i + 1}`,
      _now: new Date(),
    };
    const rendered = render.renderRow(tpl.elements, row, input.serialMap ?? {}, sysVars, i, tpl.variables ?? []);
    const one = renderLabelSvg(rendered, tpl.page, input.watermarkLayer);
    one.warnings.forEach((w) => warnings.add(w));
    labels.push(one.svg);
  }
  const layout = layoutSheets(labels, tpl.page);
  if (input.watermarkLayer) warnings.add('已叠加水印层（SVG / PDF 输出通道）；指令通道不叠加水印');
  // 文本字形依赖渲染端字体，中文缺字会在栅格化时退化为方块，必须显式告知
  const hasCjk = (tpl.elements ?? []).some((e) => /[\u3400-\u9fff]/.test(String(e.text ?? e.rendered ?? '')));
  if (hasCjk) warnings.add('模板含中文文本：SVG 字形依赖渲染端系统字体，PDF 栅格化时缺中文字体会退化为方块，请安装中文字体或改用图像通道');
  warnings.add('SVG 为真矢量；PDF 默认由 SVG 按 600dpi 栅格化嵌入（非矢量 PDF）；矢量 PDF / CMYK / 出血请用 pdf 端点相应选项');
  if (input.collate === false) warnings.add('标签顺序：按行堆叠（AABBCC）；默认逐份交叉（ABCABC）');
  return { ...layout, warnings: [...warnings] };
}
