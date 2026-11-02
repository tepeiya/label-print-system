// =============================================================================
// print/html-renderer.ts —— 模板 → 可打印 HTML
// =============================================================================

import { RenderService } from './render.service';
import { renderBarcodeSvg, renderQrcodeSvg } from '../../core/barcode-renderer';

/** 让 bwip SVG 拉伸填满容器（一维码按元素宽高铺满） */
function svgToFill(svg: string): string {
  return svg.replace('<svg ', '<svg preserveAspectRatio="none" style="width:100%;height:100%;display:block" ');
}

/** 让 bwip SVG 等比缩放并居中（二维码） */
function svgToContain(svg: string): string {
  return svg.replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="max-width:100%;max-height:100%;width:auto;height:auto;display:block" ');
}

/** HTML 实体转义 */
function enc(s: any): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface HtmlRenderInput {
  templateContent: {
    schemaVersion?: number;
    page: { widthMm: number; heightMm: number; dpi: number; orientation?: number };
    elements: any[];
  };
  rows?: Record<string, any>[];
  copies?: number;
}

export interface HtmlRenderOutput {
  html: string;      // 完整 HTML（含 <!doctype>、<style>、标签页内容）
  mmToPx: number;    // 换算系数
  widthMm: number;
  heightMm: number;
  dpi: number;
  labelCount: number;
}

export function renderPrintHtml(input: HtmlRenderInput): HtmlRenderOutput {
  const { templateContent, rows = [{}], copies = 1 } = input;
  const page = templateContent.page;
  const dpi = page.dpi || 300;
  const mmToPx = dpi / 25.4;            // 1mm ≈ dpi/25.4 px（精准）
  const wMm = page.widthMm, hMm = page.heightMm;
  const wPx = +(wMm * mmToPx).toFixed(2);
  const hPx = +(hMm * mmToPx).toFixed(2);

  const render = new RenderService();
  const serialMap: Record<string, string[]> = {};
  const labels: string[] = [];

  const totalLabels = rows.length * copies;
  for (let i = 0; i < totalLabels; i++) {
    const row = rows[i % rows.length];
    const copyIndex = Math.floor(i / rows.length);
    const pageNo = i + 1;
    const pageTotal = totalLabels;
    const sysVars = {
      printDate: new Date().toISOString().slice(0, 10),
      printTime: new Date().toISOString().slice(11, 19),
      pageNo, pageTotal,
      copyIndex,
      uuid: require('crypto').randomUUID?.() ?? 'no-uuid',
    };
    const serials: Record<string, string[]> = {}; // 预览不预分配，留空
    const rendered = render.renderRow(templateContent.elements, row, serials, sysVars, copyIndex);
    labels.push(renderedToLabel(rendered, mmToPx));
  }

  const html = assembleDocument({ wPx, hPx, wMm, hMm, dpi, labels });
  return { html, mmToPx, widthMm: wMm, heightMm: hMm, dpi, labelCount: totalLabels };
}

// -----------------------------------------------------------------------------
function renderedToLabel(elements: any[], mmToPx: number): string {
  const parts: string[] = [];
  for (const e of elements) {
    parts.push(renderElement(e, mmToPx));
  }
  return `<div class="lbl">${parts.join('')}</div>`;
}

function renderElement(e: any, mmToPx: number): string {
  const x = +(e.x * mmToPx).toFixed(2);
  const y = +(e.y * mmToPx).toFixed(2);
  const w = +((e.w ?? 3) * mmToPx).toFixed(2);
  const h = +((e.h ?? 3) * mmToPx).toFixed(2);
  const rot = e.rotation || 0;
  const common = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;transform:rotate(${rot}deg);`;

  switch (e.type) {
    case 'text':
    case 'richtext':
    case 'serial': {
      const text = enc(e.rendered ?? e.text ?? '');
      const f = e.font ?? {};
      const sizePx = +((f.size ?? 10) * mmToPx / 2.45).toFixed(1); // pt → px 近似
      const bold = f.bold ? 'font-weight:bold;' : '';
      const italic = f.italic ? 'font-style:italic;' : '';
      const underline = f.underline ? 'text-decoration:underline;' : '';
      const color = f.color ?? '#000';
      const align = f.align ?? 'left';
      const vAlign = f.vAlign ?? 'top';
      const wrap = f.wrap !== false ? 'white-space:pre-wrap;word-break:break-all;' : 'white-space:nowrap;';
      return `<div style="position:absolute;${common}font-family:${f.family ?? 'Arial'};font-size:${sizePx}px;color:${color};text-align:${align};vertical-align:${vAlign};${bold}${italic}${underline}${wrap}line-height:1.1;">${text}</div>`;
    }
    case 'formula': {
      const text = enc(e.rendered ?? '{{F_ERR}}');
      const f = e.font ?? {};
      const sizePx = +((f.size ?? 10) * mmToPx / 2.45).toFixed(1);
      return `<div style="position:absolute;${common}font-family:${f.family ?? 'Arial'};font-size:${sizePx}px;color:${f.color ?? '#531dab'};text-align:${f.align ?? 'left'};font-style:italic;">${text}</div>`;
    }
    case 'sysvar':
    case 'datetime': {
      const text = enc(e.rendered ?? e.datetime?.pattern ?? '');
      const f = e.font ?? {};
      const sizePx = +((f.size ?? 10) * mmToPx / 2.45).toFixed(1);
      return `<div style="position:absolute;${common}font-family:${f.family ?? 'Arial'};font-size:${sizePx}px;color:${f.color ?? '#666'};text-align:${f.align ?? 'left'};">${text}</div>`;
    }
    case 'rect': {
      const fill = e.fill ?? '#ffffff';
      const stroke = e.stroke?.color ?? '#333';
      const sw = +((e.stroke?.width ?? 0.5) * mmToPx).toFixed(2);
      const r = +((e.cornerRadius ?? 0) * mmToPx).toFixed(2);
      return `<div style="position:absolute;${common}background:${fill};border:${sw}px solid ${stroke};border-radius:${r}px;box-sizing:border-box;"></div>`;
    }
    case 'ellipse': {
      const fill = e.fill ?? '#ffffff';
      const stroke = e.stroke?.color ?? '#333';
      const sw = +((e.stroke?.width ?? 0.5) * mmToPx).toFixed(2);
      return `<div style="position:absolute;${common}background:${fill};border:${sw}px solid ${stroke};border-radius:50%;box-sizing:border-box;"></div>`;
    }
    case 'line': {
      const x2 = +((e.x2 ?? e.x + 10) * mmToPx).toFixed(2);
      const y2 = +((e.y2 ?? e.y) * mmToPx).toFixed(2);
      const x1 = +(e.x * mmToPx).toFixed(2);
      const y1 = +(e.y * mmToPx).toFixed(2);
      const sw = +((e.stroke?.width ?? 0.5) * mmToPx).toFixed(2);
      const color = e.stroke?.color ?? '#333';
      // 用 SVG 画直线（支持 dash）
      const dash = e.stroke?.style === 'dashed' ? '6,4' : e.stroke?.style === 'dotted' ? '1,3' : 'none';
      const width = Math.max(2, Math.abs(x2 - x1));
      const height = Math.max(2, Math.abs(y2 - y1));
      return `<svg style="position:absolute;left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${width}px;height:${height}px;overflow:visible;"><line x1="${x1 - Math.min(x1, x2)}" y1="${y1 - Math.min(y1, y2)}" x2="${x2 - Math.min(x1, x2)}" y2="${y2 - Math.min(y1, y2)}" stroke="${color}" stroke-width="${sw}" stroke-dasharray="${dash}" /></svg>`;
    }
    case 'table': {
      const rows = e.rows ?? 3, cols = e.cols ?? 3;
      const showBorder = e.showBorder !== false;
      const sw = +((e.borderWidth ?? 1) * mmToPx).toFixed(2);
      const color = e.borderColor ?? '#333';
      const cellW = w / cols, cellH = h / rows;
      const parts: string[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const txt = (e.cells?.[idx] ?? '').replace(/\{\{[^}]+\}\}/g, (m: any) => m);
          const f = e.font ?? {};
          const sizePx = +((f.size ?? 9) * mmToPx / 2.45).toFixed(1);
          const bg = r === 0 && e.headerRow ? (e.headerBg ?? '#fafafa') : '#ffffff';
          const bold = r === 0 && e.headerRow ? 'font-weight:bold;' : '';
          const align = f.align ?? 'center';
          const style = [
            `position:absolute`,
            `left:${x + c * cellW}px`,
            `top:${y + r * cellH}px`,
            `width:${cellW}px`,
            `height:${cellH}px`,
            `background:${bg}`,
            `box-sizing:border-box`,
            `display:flex`,
            `align-items:center`,
            `justify-content:${align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center'}`,
            `padding:1px`,
            `font-family:${f.family ?? 'Arial'}`,
            `font-size:${sizePx}px`,
            `color:${f.color ?? '#000'}`,
            bold,
            showBorder ? `border:${sw}px solid ${color}` : '',
          ].join(';');
          parts.push(`<div style="${style}">${txt || '&nbsp;'}</div>`);
        }
      }
      return parts.join('');
    }
    case 'image': {
      const src = e.src ?? '';
      return `<img src="${src}" style="position:absolute;${common}object-fit:contain;" />`;
    }
    case 'barcode': {
      const spec: any = e.barcode ?? {};
      const content = String(e.rendered ?? spec.content ?? '');
      const showText = !!spec.showText;
      let svg = '';
      try {
        // 打印 HTML 不内置明文，明文单独排版，避免拉伸变形
        svg = svgToFill(renderBarcodeSvg({ ...spec, content, showText: false } as any));
      } catch (err: any) {
        svg = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(90deg,#000 0 2px,#fff 2px 4px);color:#b00;font-size:9px;">条码编码失败</div>`;
      }
      const textCss = `font-family:${spec.textFont?.family ?? 'Arial'};font-size:${+((spec.textFont?.size ?? 2.6) * 1).toFixed(2)}mm;line-height:1.1;text-align:center;overflow:hidden;`;
      return `<div style="position:absolute;${common}display:flex;flex-direction:column;overflow:hidden;">`
        + `<div style="flex:1;min-height:0;">${svg}</div>`
        + (showText ? `<div style="flex:0 0 auto;${textCss}">${enc(content)}</div>` : '')
        + `</div>`;
    }
    case 'qrcode': {
      const spec: any = e.qrcode ?? {};
      const content = String(e.rendered ?? spec.content ?? '');
      let svg = '';
      try {
        svg = svgToContain(renderQrcodeSvg({ ...spec, content } as any));
      } catch (err: any) {
        svg = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;border:1px dashed #b00;color:#b00;font-size:9px;">二维码编码失败</div>`;
      }
      return `<div style="position:absolute;${common}display:flex;align-items:center;justify-content:center;">${svg}</div>`;
    }
    default:
      return '';
  }
}

// -----------------------------------------------------------------------------
function assembleDocument({ wPx, hPx, wMm, hMm, dpi, labels }: {
  wPx: number; hPx: number; wMm: number; hMm: number; dpi: number; labels: string[];
}): string {
  const pageCSS = `
    @page { size: ${wMm}mm ${hMm}mm; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: #fff; }
    body {
      font-family: Arial, sans-serif;
    }
    .lbl {
      position: relative;
      width: ${wPx}px;
      height: ${hPx}px;
      background: #fff;
      overflow: hidden;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    body.print-ready .lbl { display: block; }
    body:not(.print-ready) .lbl { display: none; }
    @media screen {
      body { padding: 20px; background: #ddd; }
      body:not(.print-ready) .lbl { display: block; box-shadow: 0 0 0 1px #999; margin: 8px auto; }
    }
  `;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>LabelFlow Print Preview · ${wMm}×${hMm}mm · ${dpi}dpi</title><style>${pageCSS}</style></head>
<body class="print-ready">${labels.join('')}</body></html>`;
}
