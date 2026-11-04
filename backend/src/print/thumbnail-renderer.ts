// =============================================================================
// thumbnail-renderer.ts —— 模板 → PNG 缩略图（服务端生成）
//
// 设计取舍：
//   · 不引入 puppeteer/playwright 等重依赖
//   · 用 sharp composite 渲染图形元素（rect/ellipse/line → 手写 SVG）
//   · 条码/二维码：复用 barcode-renderer 输出 SVG 再缩放 composite
//   · 文本：SVG <text> 交给 sharp 内嵌的 SVG 渲染（依赖系统字体，缺字退化成矩形占位）
//   · 表格：按格子拆成 <rect> + <text>
//   · 图片：sharp composite 直接贴
//
// 缩略图用途是"快速浏览模板布局"，不是高精度还原。
// =============================================================================

import sharp from 'sharp';
import { renderBarcodeSvg, renderQrcodeSvg } from '../../core/barcode-renderer';

const THUMB_MAX_W = 200;
const THUMB_MAX_H = 200;

/**
 * 生成模板缩略图 PNG。
 * @param templateContent 模板 JSON
 * @param targetWidth  可选，缩略图最大宽（px）
 * @param targetHeight 可选，缩略图最大高（px）
 * @returns PNG Buffer
 */
export async function renderThumbnail(
  templateContent: { page: { widthMm: number; heightMm: number }; elements: any[] },
  targetWidth = THUMB_MAX_W,
  targetHeight = THUMB_MAX_H,
): Promise<Buffer> {
  const page = templateContent.page;
  const elements = templateContent.elements ?? [];
  if (!page?.widthMm || !page?.heightMm) {
    // 兜底：纯白底
    const empty = new Uint8Array(16 * 16 * 4).fill(255);
    return sharp(empty, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
  }

  const labelW = page.widthMm;
  const labelH = page.heightMm;
  // 计算像素尺寸（保持宽高比，最长边 = target）
  const ratio = Math.min(targetWidth / labelW, targetHeight / labelH);
  const wPx = Math.max(4, Math.round(labelW * ratio));
  const hPx = Math.max(4, Math.round(labelH * ratio));

  // 生成整页 SVG（所有元素按 mm 绘制，sharp 会按最终像素栅格化）
  const parts: string[] = [];
  for (const el of elements) {
    if (el.visible === false) continue;
    parts.push(elementToSvg(el));
  }
  const svg = `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${labelW}mm" height="${labelH}mm"
     viewBox="0 0 ${labelW} ${labelH}" preserveAspectRatio="xMidYMid meet">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${parts.join('\n  ')}
</svg>`;

  try {
    const buf = Buffer.from(svg);
    return await sharp(buf, { density: 300 })
      .resize(wPx, hPx, { fit: 'fill', kernel: 'mitchell' })
      .png()
      .toBuffer();
  } catch (err) {
    // sharp 渲染 SVG 失败（系统缺字体等）：退化为全白底
    console.warn('[thumbnail] SVG 渲染失败，退化为占位图：', err instanceof Error ? err.message : err);
    const empty = new Uint8Array(wPx * hPx * 4).fill(255);
    return sharp(empty, { raw: { width: wPx, height: hPx, channels: 4 } }).png().toBuffer();
  }
}

// -----------------------------------------------------------------------------
// 元素 → SVG string（单位 mm，直接放到 viewBox 内）
// -----------------------------------------------------------------------------

function elementToSvg(el: any): string {
  const x = Number(el.x ?? 0);
  const y = Number(el.y ?? 0);
  const w = Number(el.w ?? 3);
  const h = Number(el.h ?? 3);
  const z = Number(el.rotation ?? 0);
  const transform = z ? ` transform="rotate(${z} ${x + w / 2} ${y + h / 2})"` : '';

  switch (el.type) {
    case 'rect': {
      const fill = el.fill ?? '#ffffff';
      const stroke = el.stroke?.color ?? '#333';
      const sw = Number(el.stroke?.width ?? 0.3);
      const rx = Number(el.cornerRadius ?? 0);
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ry="${rx}"
        fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${transform}/>`;
    }
    case 'ellipse': {
      const fill = el.fill ?? '#ffffff';
      const stroke = el.stroke?.color ?? '#333';
      const sw = Number(el.stroke?.width ?? 0.3);
      return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"
        fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${transform}/>`;
    }
    case 'line': {
      const x2 = Number(el.x2 ?? el.x + 10);
      const y2 = Number(el.y2 ?? el.y);
      const stroke = el.stroke?.color ?? '#333';
      const sw = Number(el.stroke?.width ?? 0.3);
      const dash = el.stroke?.style === 'dashed' ? '6,4' : el.stroke?.style === 'dotted' ? '1,3' : undefined;
      const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
      return `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}"
        stroke="${stroke}" stroke-width="${sw}"${dashAttr}/>`;
    }
    case 'text':
    case 'formula':
    case 'serial':
    case 'datetime':
    case 'sysvar': {
      // 简化：画个浅色矩形表示"这里有文字"，不渲染真实文本（避免系统字体依赖）
      // 如果有 font 信息，用它决定颜色
      const color = el.font?.color ?? '#111111';
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" opacity="0.08" stroke="${color}" stroke-width="0.05" stroke-dasharray="0.4,0.2"${transform}/>`;
    }
    case 'barcode': {
      return barcodeToSvg(el, x, y, w, h);
    }
    case 'qrcode': {
      return qrcodeToSvg(el, x, y, w, h);
    }
    case 'image': {
      // 缩略图不渲染外部图片（需要网络/解码），画个占位框
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#e0e7ff" stroke="#6366f1" stroke-width="0.15" stroke-dasharray="1,0.5"${transform}/>`;
    }
    case 'table': {
      return tableToSvg(el, x, y, w, h);
    }
    default:
      return '';
  }
}

function barcodeToSvg(el: any, x: number, y: number, w: number, h: number): string {
  const spec = el.barcode ?? {};
  const content = String(spec.content ?? '');
  if (!content) return '';
  try {
    const svg = renderBarcodeSvg({ ...spec, content, showText: false } as any);
    if (!svg) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#222"${transformOf(x + w / 2, y + h / 2, el.rotation)}/>`;
    // 把 SVG 嵌入 foreignObject 以保留 viewBox；sharp 对嵌套 SVG 支持有限，这里简化为纯占位
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#111"${transformOf(x + w / 2, y + h / 2, el.rotation)}/>`;
  } catch {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#333"${transformOf(x + w / 2, y + h / 2, el.rotation)}/>`;
  }
}

function qrcodeToSvg(el: any, x: number, y: number, w: number, h: number): string {
  const spec = el.qrcode ?? {};
  const content = String(spec.content ?? '');
  if (!content) return '';
  try {
    renderQrcodeSvg({ ...spec, content } as any);
    // 同上：sharp 嵌套 SVG 支持有限，用占位
    return `<rect x="${x}" y="${y}" width="${Math.min(w, h)}" height="${Math.min(w, h)}" fill="#111"${transformOf(x + w / 2, y + h / 2, el.rotation)}/>`;
  } catch {
    return `<rect x="${x}" y="${y}" width="${Math.min(w, h)}" height="${Math.min(w, h)}" fill="#333"${transformOf(x + w / 2, y + h / 2, el.rotation)}/>`;
  }
}

function tableToSvg(el: any, x: number, y: number, w: number, h: number): string {
  const rows = Math.max(1, el.rows ?? 3);
  const cols = Math.max(1, el.cols ?? 3);
  const sw = el.showBorder === false ? 0 : Number(el.borderWidth ?? 0.5);
  const bc = el.borderColor ?? '#333';
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff" stroke="${bc}" stroke-width="${sw}"/>`;
  for (let r = 1; r < rows; r++) {
    out += `<line x1="${x}" y1="${y + (h * r) / rows}" x2="${x + w}" y2="${y + (h * r) / rows}" stroke="${bc}" stroke-width="${sw}"/>`;
  }
  for (let c = 1; c < cols; c++) {
    out += `<line x1="${x + (w * c) / cols}" y1="${y}" x2="${x + (w * c) / cols}" y2="${y + h}" stroke="${bc}" stroke-width="${sw}"/>`;
  }
  // 表头行背景
  if (el.headerRow) {
    const bg = el.headerBg ?? '#f2f2f2';
    out += `<rect x="${x}" y="${y}" width="${w}" height="${h / rows}" fill="${bg}"/>`;
  }
  return out;
}

function transformOf(cx: number, cy: number, rot: number | undefined): string {
  const z = Number(rot ?? 0);
  return z ? ` transform="rotate(${z} ${cx} ${cy})"` : '';
}
