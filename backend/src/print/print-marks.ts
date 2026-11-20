// =============================================================================
// print-marks.ts —— 印刷工艺标记（第二层 · 印刷级输出）
//
// 职责：在已拼版的 SVG sheet 上施加印前标记，并向矢量 PDF 通道输出同口径的绘制指令。
//   · 出血 bleed      —— 页面四周各扩 b mm，原内容整体内移 b，避免裁切露白
//   · 裁切线 crop     —— 成品四角外侧的短细线（默认 3mm 线长 / 1.5mm 偏移）
//   · 套准线 register —— 四边中点的十字 + 圆环，供四色套准
//   · 色标 color bar  —— CMYK 四色密度块 + 可选专色块（以 CMYK 近似，非真 Separation）
//
// 【诚实边界】
//   · 专色（Pantone/Spot）在本层只有「名称 + CMYK 近似值」，不生成印刷机可分离的
//     Separation/DeviceN 色彩空间；需要真专色分色请用印前软件打开 SVG。
//   · 所有标记以 mm 为单位，坐标口径与 vector-renderer / layoutSheets 完全一致。
//   · 纯函数、不依赖 NestJS / sharp / pdf-lib，可 node --test 直跑。
// =============================================================================

export const DEFAULT_MARK_COLOR = '#000000';
export const MAX_BLEED_MM = 20;

export interface SpotColor {
  name: string;
  /** 0..1 的 CMYK 近似值 */
  cmyk: [number, number, number, number];
}

export interface PrintMarksOptions {
  /** 出血宽度（mm），0 表示不加出血。会被夹取到 [0, 20] */
  bleedMm?: number;
  /** 成品四角裁切线 */
  cropMarks?: boolean;
  /** 四边中点套准十字 */
  registrationMarks?: boolean;
  /** 底部 CMYK 色标（含可选专色） */
  colorBars?: boolean;
  /** 标记线颜色，默认黑 */
  markColor?: string;
  /** 专色列表（仅用于色标标注，CMYK 近似） */
  spotColors?: SpotColor[];
  /** 裁切线线长（mm），默认 3 */
  cropLineMm?: number;
  /** 裁切线与成品边距离（mm），默认 1.5，必须 < bleed 否则落在出血外 */
  cropOffsetMm?: number;
  /** 底部标记区额外高度（mm）：放色标/底部套准线；默认色标 8、仅套准 5、无标记 0 */
  markZoneMm?: number;
}

/** 矢量 PDF 通道可直接消费的绘制指令（mm 坐标 + CMYK） */
export type MarkOp =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; cmyk: CMYK }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: CMYK }
  | { kind: 'circle'; cx: number; cy: number; r: number; width: number; cmyk: CMYK };

export type CMYK = [number, number, number, number];

export interface MarkedSheets {
  sheets: string[];
  sheetWidthMm: number;
  sheetHeightMm: number;
  bleedMm: number;
  /** 底部标记区高度（mm），调用方据此平安内容：内容只需平移 bleed，标记区在底部 */
  markZoneMm: number;
  /** 供矢量 PDF 通道绘制标记（每张 sheet 的指令；PDF 正文仍走 SVG→PDF 转换） */
  pdfOps: MarkOp[];
  warnings: string[];
}

function num(v: any, d = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function n3(v: number): number {
  return Number(v.toFixed(3));
}

/** #RRGGBB → CMYK（0..1）。解析失败回退黑色。 */
export function hexToCmyk(hex: string): CMYK {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return [0, 0, 0, 1];
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1 - 1e-9) return [0, 0, 0, 1];
  return [
    Number(((1 - r - k) / (1 - k)).toFixed(4)),
    Number(((1 - g - k) / (1 - k)).toFixed(4)),
    Number(((1 - b - k) / (1 - k)).toFixed(4)),
    Number(k.toFixed(4)),
  ];
}

/** 从根 <svg> 中取内部内容（受控输入：layoutSheets 产出的 svg） */
function innerOf(svg: string): string {
  return String(svg)
    .replace(/<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .trim();
}

/** 取根 svg 的 width/height（形如 "84mm"），失败回退传入值 */
function sizeOf(svg: string, fallbackW: number, fallbackH: number): { w: number; h: number } {
  const w = /width="([\d.]+)mm"/i.exec(svg)?.[1];
  const h = /height="([\d.]+)mm"/i.exec(svg)?.[1];
  return { w: w ? Number(w) : fallbackW, h: h ? Number(h) : fallbackH };
}

/**
 * 施加印前标记到拼版 sheet 数组。
 * 输入 sheets 为 vector-renderer.layoutSheets 的输出（根 <svg width="Xmm" ...>）。
 * 返回页尺寸（含出血）、标记后的 sheets、以及等价的 PDF 绘制指令。
 */
export function applyPrintMarks(
  sheets: string[],
  sheetWidthMm: number,
  sheetHeightMm: number,
  opts: PrintMarksOptions = {},
): MarkedSheets {
  const bleed = Math.max(0, Math.min(MAX_BLEED_MM, num(opts.bleedMm, 0)));
  const markColor = String(opts.markColor || DEFAULT_MARK_COLOR);
  const cropLine = Math.max(0.5, Math.min(8, num(opts.cropLineMm, 3)));
  // 裁切偏移不能超过出血（无出血时也允许画裁切线，落在页内顶点外侧）
  const cropOffset = Math.max(0.2, Math.min(Math.max(0.2, bleed || 10), num(opts.cropOffsetMm, 1.5)));
  const warnings: string[] = [];
  const markCmyk = hexToCmyk(markColor);

  if (opts.spotColors?.length) {
    warnings.push(`专色以 CMYK 近似标注（${opts.spotColors.map((s) => s.name).join('、')}），未生成印刷机可分离的 Separation 通道；真专色请用印前软件打开 SVG`);
  }
  if (bleed > 0 && (opts.cropMarks || opts.registrationMarks) && cropOffset >= bleed) {
    warnings.push(`裁切/套准偏移 ${cropOffset}mm 不小于出血 ${bleed}mm，标记可能落在出血区外`);
  }

  // 底部标记区：色标需要 ≈8mm、仅底部套准 ≈5mm；放在出血之外，避免遮挡内容
  const markZone = Math.max(0, Math.min(30, num(opts.markZoneMm, opts.colorBars ? 8 : opts.registrationMarks ? 5 : 0)));
  const outW = n3(sheetWidthMm + 2 * bleed);
  const outH = n3(sheetHeightMm + 2 * bleed + markZone);
  const ops: MarkOp[] = [];
  const svgParts: string[] = [];

  const pushLine = (x1: number, y1: number, x2: number, y2: number, width = 0.15) => {
    ops.push({ kind: 'line', x1: n3(x1), y1: n3(y1), x2: n3(x2), y2: n3(y2), width, cmyk: markCmyk });
    svgParts.push(`<line x1="${n3(x1)}" y1="${n3(y1)}" x2="${n3(x2)}" y2="${n3(y2)}" stroke="${markColor}" stroke-width="${width}" />`);
  };
  const pushCircle = (cx: number, cy: number, r: number, width = 0.15) => {
    ops.push({ kind: 'circle', cx: n3(cx), cy: n3(cy), r: n3(r), width, cmyk: markCmyk });
    svgParts.push(`<circle cx="${n3(cx)}" cy="${n3(cy)}" r="${n3(r)}" fill="none" stroke="${markColor}" stroke-width="${width}" />`);
  };
  const pushRect = (x: number, y: number, w: number, h: number, fill: CMYK, hex: string) => {
    ops.push({ kind: 'rect', x: n3(x), y: n3(y), w: n3(w), h: n3(h), fill });
    svgParts.push(`<rect x="${n3(x)}" y="${n3(y)}" width="${n3(w)}" height="${n3(h)}" fill="${hex}" />`);
  };

  // 标记坐标基于「成品页（未出血）」在扩展页中的位置：left=bleed, top=bleed
  const L = bleed, T = bleed, R = bleed + sheetWidthMm, B = bleed + sheetHeightMm;

  if (opts.cropMarks) {
    // 四角各两条线：水平线在成品边外侧，垂直线在成品边外侧
    for (const [cx, dirX] of [[L, -1], [R, 1]] as const) {
      for (const [cy, dirY] of [[T, -1], [B, 1]] as const) {
        const hx1 = cx + dirX * cropOffset, hx2 = cx + dirX * (cropOffset + cropLine);
        pushLine(hx1, cy, hx2, cy, 0.12);
        const vy1 = cy + dirY * cropOffset, vy2 = cy + dirY * (cropOffset + cropLine);
        pushLine(cx, vy1, cx, vy2, 0.12);
      }
    }
  }

  if (opts.registrationMarks) {
    const marks: Array<[number, number]> = [
      [(L + R) / 2, T - cropOffset - 1.5],
      [(L + R) / 2, B + Math.max(1.5, Math.min(markZone || 3, 3))],
      [L - cropOffset - 1.5, (T + B) / 2],
      [R + cropOffset + 1.5, (T + B) / 2],
    ];
    for (const [cx, cy] of marks) {
      pushLine(cx - 2, cy, cx + 2, cy, 0.12);
      pushLine(cx, cy - 2, cx, cy + 2, 0.12);
      pushCircle(cx, cy, 1.2, 0.12);
    }
  }

  if (opts.colorBars) {
    const barW = 3, barH = 6, gap = 0.4;
    const cmykDefs: Array<[string, CMYK]> = [
      ['#00AEEF', hexToCmyk('#00AEEF')], // C
      ['#EC008C', hexToCmyk('#EC008C')], // M
      ['#FFF200', hexToCmyk('#FFF200')], // Y
      ['#000000', [0, 0, 0, 1]],         // K
    ];
    const spots = (opts.spotColors ?? []).map((s) => [s.name, s.cmyk] as [string, CMYK]);
    const all = [...cmykDefs, ...spots.map(([name, c]) => [name, c] as [string, CMYK])];
    const totalW = all.length * barW + (all.length - 1) * gap;
    const startX = L + (sheetWidthMm - totalW) / 2;
    // 色标放在成品底 B 之下的标记区内（高 6mm），不超出页面
    const startY = B + Math.max(0.5, (markZone - 6) / 2);
    all.forEach(([hexOrName, cmyk], i) => {
      const hex = /^#?[0-9a-f]{6}$/i.test(hexOrName) ? hexOrName : `#${Math.round(cmyk[0] * 255).toString(16).padStart(2, '0')}${Math.round(cmyk[1] * 255).toString(16).padStart(2, '0')}${Math.round(cmyk[2] * 255).toString(16).padStart(2, '0')}`;
      pushRect(startX + i * (barW + gap), startY, barW, barH, cmyk, hex);
    });
  }

  const marksSvg = svgParts.join('\n  ');
  const marked = (sheets ?? []).map((svg) => {
    const sz = sizeOf(svg, sheetWidthMm, sheetHeightMm);
    const content = `<g transform="translate(${n3(bleed)} ${n3(bleed)})">${innerOf(svg)}</g>`;
    // 出血背景：白色铺满扩展页，避免裁切区透明
    const bg = `<rect x="0" y="0" width="${outW}" height="${outH}" fill="#FFFFFF" />`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}mm" height="${outH}mm" viewBox="0 0 ${outW} ${outH}">${bg}${content}${marksSvg ? `\n  ${marksSvg}` : ''}</svg>`;
  });

  if (bleed > 0) warnings.push(`出血 ${bleed}mm 已施加：页面 ${n3(sheetWidthMm)}×${n3(sheetHeightMm)}mm → ${outW}×${outH}mm`);
  if (opts.cropMarks || opts.registrationMarks || opts.colorBars) warnings.push('已叠加印前标记（裁切线/套准线/色标）；标记不参与内容区，可在印前软件中关闭');

  return { sheets: marked, sheetWidthMm: outW, sheetHeightMm: outH, bleedMm: bleed, markZoneMm: markZone, pdfOps: ops, warnings };
}

/** 是否请求了任一印前标记（用于导出端点判断是否走 applyPrintMarks） */
export function hasAnyMarks(opts: PrintMarksOptions): boolean {
  return !!(
    num(opts.bleedMm, 0) > 0 || opts.cropMarks || opts.registrationMarks || opts.colorBars
  );
}
