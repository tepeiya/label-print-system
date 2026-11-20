// =============================================================================
// vector-pdf.ts —— 真矢量 PDF 导出（第二层 · 印刷级输出）
//
// 【与 pdf-export.ts 的区别】
//   pdf-export.ts：sharp 把整张 SVG 按 600dpi 栅格化 → embedPng → PDF 内部是位图，放大发虚。
//   本模块：用 pdf-lib 原生绘图 API 把每个元素画成 PDF 矢量路径；
//     · 条码：逐条竖线 drawLine（描边型 bwip path 解析成线段）——可无限放大、可扫码
//     · 二维码：填充多边形 drawSvgPath（fill 型 path）——矢量块
//     · 图形 rect/ellipse/line/table：drawRectangle/drawLine/drawEllipse ——矢量
//     · 文本：拉丁/数字用标准字体矢量绘制；含 CJK 的文本用 sharp 高-DPI 渲染成小块
//       透明 PNG 嵌入（hybrid）——保证字形正确，代价是该文本块是位图（如实 warning）
//
// 【坐标口径】与 vector-renderer 完全一致：mm、左上原点、y 向下、rot 顺时针（度）。
//   转 PDF 时逐元素做「中心旋转 + mm→pt + y 翻转」，不依赖 pdf-lib 缺失的 rotate 算子。
//
// 【诚实边界】
//   · CJK 文本块为高-DPI 位图（默认 600dpi），非矢量；要纯矢量中文需印前嵌入 CJK 字体子集，
//     本层不承诺。warning 会明确标注。
//   · 外链图片不拉取（SSRF + 无网络），仅 data: URI 图片嵌入。
//   · 不生成 CMYK 四边形分色 PDF：CMYK 值仅用于印前标记（见 print-marks）；正文按 RGB 绘制。
// =============================================================================
import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, degrees, type Color } from 'pdf-lib';
import sharp from 'sharp';
import { renderBarcodeSvg, renderQrcodeSvg } from '../../core/barcode-renderer';
import { RenderService } from './render.service';
import { buildLabelPlan } from './impose';
import type { ComputedVariable } from '../../core/computed-vars';
import type { MarkOp } from './print-marks';
import { mmToPt } from './pdf-export';

export const MAX_VECTOR_PAGES = 200;
export const DEFAULT_TEXT_RASTER_DPI = 600;

export interface VectorPdfPage {
  widthMm: number;
  heightMm: number;
  ops: DrawOp[];
}

export type DrawOp =
  | { kind: 'text'; x: number; y: number; w: number; h: number; rot: number; text: string; sizeMm: number; color: string; align: string; bold: boolean; italic: boolean; family: string }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; rot: number; fill: string; stroke: string; sw: number; rx: number }
  | { kind: 'ellipse'; x: number; y: number; w: number; h: number; rot: number; fill: string; stroke: string; sw: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; rot: number; stroke: string; sw: number; dash: string }
  | { kind: 'barcode'; x: number; y: number; w: number; h: number; rot: number; segments: Array<[number, number, number, number]>; bbox: { minX: number; maxX: number } }
  | { kind: 'qrcode'; x: number; y: number; w: number; h: number; rot: number; svg: string }
  | { kind: 'image'; x: number; y: number; w: number; h: number; rot: number; src: string };

export interface VectorDoc {
  pages: VectorPdfPage[];
  warnings: string[];
  labelCount: number;
}

export interface VectorPdfOptions {
  title?: string;
  /** CJK 文本栅格化 DPI（72–1200），默认 600 */
  textDpi?: number;
  /** 注入条码/二维码 SVG 渲染（单测注入，避免真跑 bwip）；返回 bwip 风格 SVG */
  barcodeSvg?: (spec: any) => string;
  qrcodeSvg?: (spec: any) => string;
  /** 注入文本栅格化（单测注入，避免真跑 sharp/librsvg）：返回 PNG */
  rasterizeText?: (text: string, sizeMm: number, color: string, dpi: number) => Promise<Buffer>;
  /** 注入二维码/二维矩阵码栅格化（单测注入）：返回 PNG。默认 sharp 高-DPI */
  rasterizeQrcode?: (svg: string, dpi: number) => Promise<Buffer>;
}

function num(v: any, d = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function n3(v: number): number {
  return Number(v.toFixed(3));
}

/** 解析 bwip 条码 path 的竖线段（M x1 y1 L x2 y2…）；返回段与 x 范围 */
export function parseBarcodeSegments(d: string): { segments: Array<[number, number, number, number]>; bbox: { minX: number; maxX: number } } {
  const re = /M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g;
  const segments: Array<[number, number, number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) segments.push([+m[1], +m[2], +m[3], +m[4]]);
  if (!segments.length) return { segments, bbox: { minX: 0, maxX: 1 } };
  const xs = segments.flatMap((s) => [s[0], s[2]]);
  return { segments, bbox: { minX: Math.min(...xs), maxX: Math.max(...xs) } };
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
function hasCjk(s: string): boolean {
  return CJK_RE.test(String(s ?? ''));
}

/** #RRGGBB → pdf-lib Color；非法回退黑 */
function pdfColor(hex: string): Color {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return rgb(0, 0, 0);
  const int = parseInt(m[1], 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}

/** 元素中心顺时针旋转 θ 后，把相对中心偏移 (lx,ly)（y 向下）映射到 PDF 点（pt，左下原点） */
function toPdfPoint(
  cxMm: number, cyMm: number, lxMm: number, lyMm: number, rotDeg: number, pageHMm: number,
): { x: number; y: number } {
  const t = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(t), sin = Math.sin(t);
  // y 向下坐标系中顺时针旋转
  const rx = lxMm * cos - lyMm * sin;
  const ry = lxMm * sin + lyMm * cos;
  const gx = cxMm + rx, gy = cyMm + ry;
  return { x: mmToPt(gx), y: mmToPt(pageHMm - gy) };
}

/**
 * 从模板 + 数据行 → 结构化矢量绘图指令（按拼版分页）。
 * 求值复用 RenderService（与 SVG/打印通道同源），仅绘制层独立。
 */
export function buildVectorDoc(
  input: {
    templateContent: { page: any; elements: any[]; variables?: ComputedVariable[] };
    rows?: Record<string, any>[];
    copies?: number;
    serialMap?: Record<string, string[]>;
    collate?: boolean;
  },
  opts: VectorPdfOptions = {},
): VectorDoc {
  const tpl = input.templateContent;
  if (!tpl?.page || !Array.isArray(tpl.elements)) throw new Error('templateContent 缺少 page / elements');
  const page = tpl.page;
  const rows: any[] = Array.isArray(input.rows) && input.rows.length ? input.rows : [{}];
  const copies = Math.max(1, Math.floor(Number(input.copies ?? 1) || 1));
  const plan = buildLabelPlan(rows.length, copies, input.collate !== false);
  if (!plan.length) throw new Error('没有可导出的标签');
  if (plan.length > MAX_VECTOR_PAGES * 100) throw new Error(`标签数 ${plan.length} 超过矢量导出上限`);

  const cols = Math.max(1, Math.round(num(page.columns ?? 1, 1)));
  const rowsN = Math.max(1, Math.round(num(page.rows ?? 1, 1)));
  const gapX = Math.max(0, num(page.gapXMm ?? 2, 2));
  const gapY = Math.max(0, num(page.gapYMm ?? 2, 2));
  const margin = Math.max(0, num(page.marginMm ?? 0, 0));
  const labelW = num(page.widthMm), labelH = num(page.heightMm);
  if (labelW <= 0 || labelH <= 0) throw new Error('页面尺寸非法');
  const sheetW = margin * 2 + labelW * cols + gapX * (cols - 1);
  const sheetH = margin * 2 + labelH * rowsN + gapY * (rowsN - 1);
  const perSheet = cols * rowsN;

  const render = new RenderService();
  const warnings = new Set<string>();
  const pages: VectorPdfPage[] = [];
  let pageOps: DrawOp[] = [];

  const barcodeSvg = opts.barcodeSvg;
  const qrcodeSvg = opts.qrcodeSvg;

  plan.forEach((entry, i) => {
    const row = rows[entry.rowIndex];
    const sysVars = {
      printDate: new Date().toISOString().slice(0, 10),
      printTime: new Date().toISOString().slice(11, 19),
      pageNo: i + 1, pageTotal: plan.length,
      copyIndex: entry.copyIndex,
      uuid: `vector-${i + 1}`,
      _now: new Date(),
    };
    const rendered: any[] = render.renderRow(tpl.elements, row, input.serialMap ?? {}, sysVars, i, tpl.variables ?? []);
    const k = i % perSheet;
    const c = k % cols, r = Math.floor(k / cols);
    const offX = margin + c * (labelW + gapX);
    const offY = margin + r * (labelH + gapY);

    for (const e of rendered) {
      if (!e || e._skip === true || e.visible === false) continue;
      const x = offX + num(e.x), y = offY + num(e.y);
      const w = num(e.w ?? 3), h = num(e.h ?? 3), rot = num(e.rotation ?? 0);
      const font: any = e.font ?? {};
      switch (e.type) {
        case 'text': case 'richtext': case 'formula': case 'serial': case 'sysvar': case 'datetime': {
          const text = String(e.rendered ?? e.text ?? '');
          if (!text) break;
          pageOps.push({
            kind: 'text', x, y, w, h, rot, text,
            sizeMm: (num(font.size ?? 10) * 25.4) / 72,
            color: font.color ?? (e.type === 'formula' ? '#531dab' : '#000000'),
            align: font.align ?? 'left', bold: !!font.bold, italic: !!font.italic,
            family: font.family ?? 'Arial',
          });
          if (hasCjk(text)) warnings.add('含 CJK 文本：该文本块以高-DPI 位图嵌入（非矢量）；纯矢量中文需印前嵌入字体');
          if (e.curve?.enabled) warnings.add(`弧形文字元素 ${String(e.id ?? '')}：矢量 PDF 暂按直线绘制，弧形请用 SVG 导出通道`);
          break;
        }
        case 'rect':
          pageOps.push({ kind: 'rect', x, y, w, h, rot, fill: e.fill ?? '#FFFFFF', stroke: e.stroke?.color ?? '#333333', sw: num(e.stroke?.width ?? 0.5), rx: num(e.cornerRadius ?? 0) });
          break;
        case 'ellipse':
          pageOps.push({ kind: 'ellipse', x, y, w, h, rot, fill: e.fill ?? '#FFFFFF', stroke: e.stroke?.color ?? '#333333', sw: num(e.stroke?.width ?? 0.5) });
          break;
        case 'line':
          pageOps.push({ kind: 'line', x1: x, y1: y, x2: offX + num(e.x2 ?? num(e.x) + 10), y2: offY + num(e.y2 ?? e.y), rot, stroke: e.stroke?.color ?? '#333333', sw: num(e.stroke?.width ?? 0.5), dash: e.stroke?.style === 'dashed' ? 'dash' : e.stroke?.style === 'dotted' ? 'dot' : '' });
          break;
        case 'table': {
          const rowsT = Math.max(1, Math.round(num(e.rows ?? 3, 3)));
          const colsT = Math.max(1, Math.round(num(e.cols ?? 3, 3)));
          const cw = w / colsT, ch = h / rowsT;
          if (e.showBorder !== false) {
            for (let r2 = 0; r2 <= rowsT; r2++) pageOps.push({ kind: 'line', x1: x, y1: y + r2 * ch, x2: x + w, y2: y + r2 * ch, rot: 0, stroke: e.borderColor ?? '#333333', sw: num(e.borderWidth ?? 0.3), dash: '' });
            for (let c2 = 0; c2 <= colsT; c2++) pageOps.push({ kind: 'line', x1: x + c2 * cw, y1: y, x2: x + c2 * cw, y2: y + h, rot: 0, stroke: e.borderColor ?? '#333333', sw: num(e.borderWidth ?? 0.3), dash: '' });
          }
          for (let r2 = 0; r2 < rowsT; r2++) for (let c2 = 0; c2 < colsT; c2++) {
            const txt = String(e.cells?.[r2 * colsT + c2] ?? '');
            if (!txt) continue;
            pageOps.push({ kind: 'text', x: x + c2 * cw, y: y + r2 * ch, w: cw, h: ch, rot: 0, text: txt, sizeMm: (num(e.font?.size ?? 9) * 25.4) / 72, color: e.font?.color ?? '#000000', align: 'center', bold: false, italic: false, family: e.font?.family ?? 'Arial' });
          }
          break;
        }
        case 'barcode': {
          const spec = e.barcode ?? {};
          const content = String(e.rendered ?? spec.content ?? '');
          if (e.curve?.enabled) warnings.add(`弧形条码元素 ${String(e.id ?? '')}：矢量 PDF 暂按直线绘制，弧形近似请用 SVG 导出通道`);
          try {
            const svg = barcodeSvg ? barcodeSvg({ ...spec, content, showText: false }) : renderBarcodeSvg({ ...spec, content, showText: false } as any);
            const d = /<path[^>]*d="([^"]+)"/.exec(svg)?.[1] ?? '';
            const parsed = parseBarcodeSegments(d);
            if (!parsed.segments.length) throw new Error('未解析到条码线段');
            const showText = !!spec.showText;
            const codeH = showText ? Math.max(1, h - 3) : h;
            pageOps.push({ kind: 'barcode', x, y, w, h: codeH, rot, segments: parsed.segments, bbox: parsed.bbox });
            if (showText) pageOps.push({ kind: 'text', x, y: y + codeH, w, h: 3, rot, text: content, sizeMm: (num(spec.textFont?.size ?? 8) * 25.4) / 72, color: '#000000', align: 'center', bold: false, italic: false, family: spec.textFont?.family ?? 'Arial' });
          } catch (err: any) {
            warnings.add(`条码矢量化失败（${String(spec.sym ?? '')}）：${String(err?.message ?? err).slice(0, 100)}`);
          }
          break;
        }
        case 'qrcode': {
          const spec = e.qrcode ?? {};
          const content = String(e.rendered ?? spec.content ?? '');
          try {
            const svg = qrcodeSvg ? qrcodeSvg({ ...spec, content }) : renderQrcodeSvg({ ...spec, content } as any);
            if (!/<path|<rect/.test(svg)) throw new Error('未解析到二维码图形');
            // pdf-lib drawSvgPath 对 bwip 多子路径填充有坐标 bug，二维码走高-DPI 位图（诚实标注）
            pageOps.push({ kind: 'qrcode', x, y, w, h, rot, svg });
            warnings.add('二维码为高-DPI 位图嵌入（pdf-lib 多子路径填充存在坐标 bug）；一维条码/图形/拉丁文本仍为矢量');
          } catch (err: any) {
            warnings.add(`二维码矢量化失败：${String(err?.message ?? err).slice(0, 100)}`);
          }
          break;
        }
        case 'image': {
          const src = String(e.src ?? '');
          if (/^data:image\/(png|jpeg|jpg);base64,/i.test(src)) {
            pageOps.push({ kind: 'image', x, y, w, h, rot, src });
          } else if (src) {
            warnings.add('矢量 PDF 跳过外链图片（仅嵌入 data: URI 的 PNG/JPEG）');
          }
          break;
        }
        default: break;
      }
    }

    if ((i + 1) % perSheet === 0 || i === plan.length - 1) {
      pages.push({ widthMm: sheetW, heightMm: sheetH, ops: pageOps });
      pageOps = [];
    }
  });

  return { pages, warnings: [...warnings], labelCount: plan.length };
}

/** 把整个 doc 的内容在 mm 坐标系里平移（出血时用）：原地修改，返回 doc */
export function translateDocOps(doc: VectorDoc, dxMm: number, dyMm: number): VectorDoc {
  if (!dxMm && !dyMm) return doc;
  for (const page of doc.pages) {
    page.widthMm += dxMm * 2;
    page.heightMm += dyMm * 2;
    for (const op of page.ops) {
      switch (op.kind) {
        case 'text': case 'rect': case 'ellipse': case 'barcode': case 'qrcode': case 'image':
          op.x += dxMm; op.y += dyMm; break;
        case 'line':
          op.x1 += dxMm; op.y1 += dyMm; op.x2 += dxMm; op.y2 += dyMm; break;
      }
    }
  }
  return doc;
}

/** 把结构化指令画到一页 PDF（矢量为止，CJK 文本块 hybrid 位图） */
async function drawPage(
  doc: PDFDocument, page: PDFPage, pg: VectorPdfPage, font: PDFFont, opts: VectorPdfOptions,
): Promise<void> {
  const H = pg.heightMm;
  const rasterize = opts.rasterizeText ?? defaultRasterizeText;
  for (const op of pg.ops) {
    switch (op.kind) {
      case 'rect': {
        const cx = op.x + op.w / 2, cy = op.y + op.h / 2;
        const fill = pdfColor(op.fill), stroke = pdfColor(op.stroke), bw = Math.max(0, mmToPt(op.sw));
        if (Math.abs(op.rot) < 0.01) {
          // 未旋转：drawRectangle 原生，坐标 = 外接框左下角（y 从底算）
          page.drawRectangle({
            x: mmToPt(op.x), y: mmToPt(H - op.y - op.h),
            width: mmToPt(op.w), height: mmToPt(op.h),
            color: fill, borderColor: stroke, borderWidth: bw,
          });
        } else {
          // 旋转矩形：drawSvgPath 以左上角为基准 + 负 yScale + 原始 (0,0)-(w,h) path，rotate 绕左上角
          const d = `M 0 0 H ${op.w} V ${op.h} H 0 Z`;
          page.drawSvgPath(d, {
            x: mmToPt(op.x), y: mmToPt(H - op.y),
            xScale: mmToPt(1), yScale: -mmToPt(1),
            rotate: degrees(-op.rot), color: fill, borderColor: stroke, borderWidth: bw,
          } as any);
        }
        break;
      }
      case 'ellipse': {
        const cx = op.x + op.w / 2, cy = op.y + op.h / 2;
        const rx = op.w / 2, ry = op.h / 2;
        const c = pdfColor(op.fill), stroke = pdfColor(op.stroke);
        if (Math.abs(op.rot) < 0.01) {
          // 未旋转：drawEllipse 的 (x,y) 是外接矩形左下角
          page.drawEllipse({
            x: mmToPt(op.x), y: mmToPt(H - op.y - op.h),
            xScale: mmToPt(rx), yScale: mmToPt(ry),
            color: c, borderColor: stroke, borderWidth: Math.max(0, mmToPt(op.sw)),
          });
        } else {
          // 旋转椭圆用 32 段折线近似（矢量）
          const steps = 32; let prev: { x: number; y: number } | null = null;
          for (let i = 0; i <= steps; i++) {
            const a = (i / steps) * Math.PI * 2;
            const p = toPdfPoint(cx, cy, rx * Math.cos(a), ry * Math.sin(a), op.rot, H);
            if (prev) page.drawLine({ start: prev, end: p, color: stroke, thickness: Math.max(0.05, mmToPt(op.sw)) });
            prev = p;
          }
        }
        break;
      }
      case 'line': {
        const rot = op.rot;
        const cx = (op.x1 + op.x2) / 2, cy = (op.y1 + op.y2) / 2;
        const dx = op.x2 - cx, dy = op.y2 - cy;
        const p1 = toPdfPoint(cx, cy, -dx, -dy, rot, H);
        const p2 = toPdfPoint(cx, cy, dx, dy, rot, H);
        page.drawLine({ start: p1, end: p2, color: pdfColor(op.stroke), thickness: Math.max(0.05, mmToPt(op.sw)), dashArray: op.dash === 'dash' ? [mmToPt(op.sw) * 3, mmToPt(op.sw) * 2] : op.dash === 'dot' ? [mmToPt(op.sw), mmToPt(op.sw)] : undefined });
        break;
      }
      case 'barcode': {
        const cx = op.x + op.w / 2, cy = op.y + op.h / 2;
        const span = op.bbox.maxX - op.bbox.minX || 1;
        const sx = op.w / span;
        for (const [x1, , x2] of op.segments) {
          // 竖线：从元素顶到元素底，横坐标按 (x-minX)*sx 相对中心
          const lx = ((x1 + x2) / 2 - op.bbox.minX) * sx - op.w / 2;
          const p1 = toPdfPoint(cx, cy, lx, -op.h / 2, op.rot, H);
          const p2 = toPdfPoint(cx, cy, lx, op.h / 2, op.rot, H);
          page.drawLine({ start: p1, end: p2, color: rgb(0, 0, 0), thickness: Math.max(0.15, mmToPt(Math.max(0.15, op.w / span * 0.5))) });
        }
        break;
      }
      case 'qrcode': {
        // 二维码（含 PDF417/DataMatrix 等矩阵码）走高-DPI 位图：pdf-lib drawSvgPath
        // 对 bwip 多子路径填充存在坐标 bug，无法可靠矢量；600dpi 位图完全可扫码。
        const dpi = opts.textDpi ?? DEFAULT_TEXT_RASTER_DPI;
        const rasterQr = opts.rasterizeQrcode ?? defaultRasterizeQrcode;
        try {
          const png = await rasterQr(op.svg, dpi);
          const img = await doc.embedPng(png);
          const cx = op.x + op.w / 2, cy = op.y + op.h / 2;
          const tl = toPdfPoint(cx, cy, -op.w / 2, -op.h / 2, op.rot, H);
          page.drawImage(img, { x: tl.x, y: tl.y - mmToPt(op.h), width: mmToPt(op.w), height: mmToPt(op.h) });
        } catch { /* 栅格化失败跳过 */ }
        break;
      }
      case 'image': {
        const b64 = op.src.replace(/^data:image\/(?:png|jpeg|jpg);base64,/i, '');
        try {
          const img = /jpeg|jpg/i.test(op.src) ? await doc.embedJpg(Buffer.from(b64, 'base64')) : await doc.embedPng(Buffer.from(b64, 'base64'));
          const cx = op.x + op.w / 2, cy = op.y + op.h / 2;
          const tl = toPdfPoint(cx, cy, -op.w / 2, -op.h / 2, op.rot, H);
          page.drawImage(img, { x: tl.x, y: tl.y - mmToPt(op.h), width: mmToPt(op.w), height: mmToPt(op.h) });
        } catch { /* 坏图片跳过，不拖垮整页 */ }
        break;
      }
      case 'text': {
        await drawText(page, doc, font, op, H, opts, rasterize);
        break;
      }
      default: break;
    }
  }
}

async function drawText(
  page: PDFPage, doc: PDFDocument, font: PDFFont, op: Extract<DrawOp, { kind: 'text' }>,
  H: number, opts: VectorPdfOptions, rasterize: NonNullable<VectorPdfOptions['rasterizeText']>,
): Promise<void> {
  const isCjk = hasCjk(op.text);
  const cx = op.x + op.w / 2, cy = op.y + op.h / 2;
  const anchor = op.align === 'center' ? cx : op.align === 'right' ? op.x + op.w : op.x;
  const baseline = op.y + op.sizeMm * 0.85;
  const t = (op.rot * Math.PI) / 180;
  const pdfAnchor = toPdfPoint(cx, cy, anchor - cx, baseline - cy, op.rot, H);

  if (isCjk) {
    const dpi = opts.textDpi ?? DEFAULT_TEXT_RASTER_DPI;
    try {
      const png = await rasterize(op.text, op.sizeMm, op.color, dpi);
      const img = await doc.embedPng(png);
      const meta = await sharp(png).metadata();
      const pxW = meta.width ?? 1, pxH = meta.height ?? 1;
      // PNG 像素 → mm（按 dpi）；宽度不超过元素框，避免溢出
      let imgWMm = (pxW / dpi) * 25.4, imgHMm = (pxH / dpi) * 25.4;
      if (imgWMm > op.w && imgWMm > 0) { const k = op.w / imgWMm; imgWMm *= k; imgHMm *= k; }
      let x0 = op.align === 'center' ? cx - imgWMm / 2 : op.align === 'right' ? op.x + op.w - imgWMm : op.x;
      let y0 = op.y;
      const tl = toPdfPoint(cx, cy, x0 - cx, y0 - cy, op.rot, H);
      page.drawImage(img, { x: tl.x, y: tl.y - mmToPt(imgHMm), width: mmToPt(imgWMm), height: mmToPt(imgHMm) });
    } catch { /* 栅格化失败跳过该文本，warning 在 buildVectorDoc 已提示 */ }
    return;
  }

  // 拉丁文本：标准字体矢量
  const sizePt = mmToPt(op.sizeMm);
  let twPt = 0;
  try { twPt = font.widthOfTextAtSize(op.text, sizePt); } catch { /* 个别字符不可编码 */ }
  const twMm = twPt / (72 / 25.4); // pdf-lib 宽度单位是 pt，转回 mm
  let lx: number;
  if (op.align === 'center') lx = cx - twMm / 2;
  else if (op.align === 'right') lx = op.x + op.w - twMm;
  else lx = op.x;
  // degrees() 支持任意角度旋转（pdf-lib 内部用 cm 矩阵实现）
  const p = toPdfPoint(cx, cy, lx - cx, baseline - cy, op.rot, H);
  try {
    page.drawText(op.text, { x: p.x, y: p.y, size: sizePt, font, color: pdfColor(op.color), rotate: degrees(-op.rot) });
  } catch { /* 标准字体无法编码的字符（如 emoji）跳过 */ }
}

async function defaultRasterizeQrcode(svg: string, dpi: number): Promise<Buffer> {
  // 按 dpi 计算目标像素：给一个足够大的基准（viewBox 通常是 126 或更小），按 12mm 参考放大
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  void vb; // viewBox 由 svg 自带 preserveAspectRatio 处理，这里只设定像素尺寸
  const px = Math.max(128, Math.min(2400, Math.round((12 * dpi) / 25.4)));
  const resizedSvg = svg.replace(/<svg([^>]*)>/i, (m, attrs) => {
    const clean = String(attrs).replace(/\s(width|height)="[^"]*"/gi, '');
    return `<svg${clean} width="${px}" height="${px}">`;
  });
  return sharp(Buffer.from(resizedSvg), { density: dpi }).resize(px, px, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
}

async function defaultRasterizeText(text: string, sizeMm: number, color: string, dpi: number): Promise<Buffer> {
  const wPx = Math.max(8, Math.ceil((sizeMm * text.length * 1.1 * dpi) / 25.4));
  const hPx = Math.max(8, Math.ceil((sizeMm * 1.6 * dpi) / 25.4));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${wPx}px" height="${hPx}px" viewBox="0 0 ${wPx} ${hPx}"><text x="0" y="${(hPx * 0.8).toFixed(1)}" font-family="Noto Sans CJK SC, sans-serif" font-size="${((sizeMm * dpi) / 25.4).toFixed(1)}" fill="${/^#?[0-9a-f]{6}$/i.test(color) ? color : '#000'}">${escapeXml(text)}</text></svg>`;
  return sharp(Buffer.from(svg), { density: dpi }).png().toBuffer();
}

function escapeXml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 矢量 PDF 主入口：结构化指令 → pdf-lib PDF bytes */
export async function renderVectorPdf(
  doc: VectorDoc, opts: VectorPdfOptions = {}, marks?: { ops: MarkOp[] },
): Promise<{ bytes: Buffer; pageCount: number; warnings: string[] }> {
  if (!doc.pages.length) throw new Error('没有可导出的页面');
  if (doc.pages.length > MAX_VECTOR_PAGES) throw new Error(`页数 ${doc.pages.length} 超过上限 ${MAX_VECTOR_PAGES}`);
  const pdf = await PDFDocument.create();
  pdf.setTitle(opts.title ?? 'LabelFlow Vector Export');
  pdf.setProducer('LabelFlow vector-pdf');
  pdf.setCreator('LabelFlow');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const warnings: string[] = [...doc.warnings];

  for (const pg of doc.pages) {
    const page = pdf.addPage([mmToPt(pg.widthMm), mmToPt(pg.heightMm)]);
    await drawPage(pdf, page, pg, font, opts);
    if (marks?.ops?.length) drawMarks(page, marks.ops, pg.heightMm);
  }
  warnings.push('PDF 正文为矢量绘制（一维条码/图形/拉丁文本）；二维码与含中文文本块为高-DPI 位图，非纯矢量');
  return { bytes: Buffer.from(await pdf.save()), pageCount: doc.pages.length, warnings };
}

function drawMarks(page: PDFPage, ops: MarkOp[], pageHMm: number): void {
  for (const op of ops) {
    if (op.kind === 'line') {
      const p1 = { x: mmToPt(op.x1), y: mmToPt(pageHMm - op.y1) };
      const p2 = { x: mmToPt(op.x2), y: mmToPt(pageHMm - op.y2) };
      page.drawLine({ start: p1, end: p2, color: pdfColorFromCmyk(op.cmyk), thickness: mmToPt(op.width) });
    } else if (op.kind === 'rect') {
      const tl = { x: mmToPt(op.x), y: mmToPt(pageHMm - op.y) };
      page.drawRectangle({ x: tl.x, y: tl.y - mmToPt(op.h), width: mmToPt(op.w), height: mmToPt(op.h), color: pdfColorFromCmyk(op.fill) });
    } else if (op.kind === 'circle') {
      const c = { x: mmToPt(op.cx), y: mmToPt(pageHMm - op.cy) };
      page.drawEllipse({ x: c.x, y: c.y, xScale: mmToPt(op.r), yScale: mmToPt(op.r), borderColor: pdfColorFromCmyk(op.cmyk), borderWidth: mmToPt(op.width) });
    }
  }
}

/** CMYK(0..1) → RGB 近似（仅用于 PDF 标记显示；真分色请用印前软件） */
function pdfColorFromCmyk(c: [number, number, number, number]): Color {
  const [cy, m, y, k] = c;
  return rgb(Math.max(0, 1 - Math.min(1, cy + k)), Math.max(0, 1 - Math.min(1, m + k)), Math.max(0, 1 - Math.min(1, y + k)));
}
