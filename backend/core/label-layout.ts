// =============================================================================
// label-layout.ts —— 「给字段 → 出一版精美标签」的确定性排版引擎（A1）
//
// 【为什么要有它】LLM 排版好看但不保证合规矩（越界、重叠、字号乱、模块宽取整走样），
// 而车间要的是「每个字段都在该在的位置、码能扫、纸能打」。所以先用规则引擎出一版
// 结构正确的版式：标题带 / 信息两列 / 码区 / 页脚 / 分割线，全部落在 mm 网格内，
// 模块宽与线宽按 dpi 取整点（P0-3）；LLM 只在这个骨架上做"美化"，不许丢字段。
//
// 【口径】纯函数，不依赖框架，可单测。所有坐标 mm，原点左上。
// =============================================================================

import { snapToDot } from './dot-fit';

export type LayoutFieldType = 'text' | 'number' | 'date' | 'barcode' | 'qrcode';

export interface LayoutField {
  /** 变量名（ASCII，模板里以 {{name}} 引用） */
  name: string;
  /** 中文名，显示在同一行左侧 */
  label?: string;
  type?: LayoutFieldType;
  /** 示例值，写进 defaultValue，打印页/预览能直接看到成品效果 */
  sample?: string;
  required?: boolean;
  /** 强调行（加粗、字号大一号），如产品名/规格/价格 */
  emphasis?: boolean;
  /** 一维码码制，默认 CODE128 */
  barcodeSym?: string;
}

export type LayoutStyle = 'medical' | 'industrial' | 'retail' | 'clean';

export interface LayoutOptions {
  widthMm: number;
  heightMm: number;
  dpi: number;
  fields: LayoutField[];
  style?: LayoutStyle;
  /** 标题文本，缺省用第一个 emphasis/title 字段或「产品标签」 */
  title?: string;
  /** 页脚，如企业名/地址 */
  footer?: string;
  /** 外框，默认 true */
  border?: boolean;
  /** 标题下方的强调色（左侧色条 / 分割线） */
  accent?: string;
}

export interface LayoutResult {
  template: any;
  warnings: string[];
  meta: {
    rows: number;
    columns: 1 | 2;
    rowHeightMm: number;
    fontPt: number;
    titleHeightMm: number;
    codeZoneMm: number;
    dotMm: number;
  };
}

const STYLE_ACCENT: Record<LayoutStyle, string> = {
  medical: '#1f6feb',
  industrial: '#111111',
  retail: '#e8590c',
  clean: '#8a6d3b',
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
}

/** 判断字段是码：类型显式声明，或名字像条码/二维码 */
function isCodeField(f: LayoutField): boolean {
  if (f.type === 'barcode' || f.type === 'qrcode') return true;
  return /^(barcode|qrcode|qr|qrCode|barcodeNo|barcodeValue)$/i.test(f.name);
}

function isQrField(f: LayoutField): boolean {
  return f.type === 'qrcode' || /^(qrcode|qr|qrCode)$/i.test(f.name);
}

/**
 * 生成一版结构合规的标签模板。
 * 版式：外框 → 标题带（可带左侧色条）→ 分割线 → 信息区（1/2 列，标签列浅灰 + 值列黑）
 *        → 码区（二维码右上 / 一维码底部通栏）→ 页脚。
 */
export function buildLabelLayout(opts: LayoutOptions): LayoutResult {
  const dpi = clamp(opts.dpi || 203, 72, 1200);
  const widthMm = clamp(opts.widthMm || 60, 10, 1000);
  const heightMm = clamp(opts.heightMm || 40, 10, 1000);
  const warnings: string[] = [];
  const dotMm = round2(25.4 / dpi);

  const style: LayoutStyle = opts.style ?? (opts.fields.some((f) => /lot|expiry|udi|gtin/i.test(f.name)) ? 'medical' : 'clean');
  const accent = opts.accent || STYLE_ACCENT[style];

  // 边距/内框：小标签 1.5mm，大标签 2mm，保证 203dpi 下边框不糊
  const margin = widthMm <= 55 || heightMm <= 35 ? 1.5 : 2;
  const innerX = margin;
  const innerY = margin;
  const innerW = widthMm - margin * 2;
  const innerH = heightMm - margin * 2;

  // ---- 字段归类：码字段最多各 1 个，其余转文本；标题字段从信息区摘出去 ----
  const codeFields = opts.fields.filter(isCodeField);
  const textFields = opts.fields.filter((f) => !isCodeField(f));
  const qrField = codeFields.find(isQrField);
  const barRaw = codeFields.find((f) => !isQrField(f));
  const extraCodes = codeFields.filter((f) => f !== qrField && f !== barRaw);
  if (extraCodes.length) {
    warnings.push(`一维码/二维码只保留 1 个一维码 + 1 个二维码，其余 ${extraCodes.length} 个字段按文本排版（${extraCodes.map((f) => f.name).join('、')}）`);
  }

  // 标题：显式 title > emphasis 的第一个字段 > productName > 产品标签
  const titleField = textFields.find((f) => f.emphasis) ?? textFields.find((f) => /productName|name|title/i.test(f.name));
  const titleText = opts.title || (titleField ? `{{${titleField.name}}}` : '产品标签');
  let rowsSource = titleField && !opts.title ? textFields.filter((f) => f !== titleField) : textFields;

  // ---- 纵向分区：标题带 / 信息区 / 码区 / 页脚 ----
  const hasFooter = !!opts.footer?.trim();
  const footerH = hasFooter ? clamp(heightMm * 0.09, 2.6, 5) : 0;
  const titleH = clamp(heightMm * 0.22, 5, 10);
  const codeBottom = innerY + innerH - footerH - (hasFooter ? 0.8 : 0);

  // ---- 一维码可行性：GS1 内容必须 GS1_128；宽度按模块数实算，太窄就宁可不出码 ----
  const dot = 25.4 / dpi;
  const snapDown = (mm: number) => Math.max(dot, Math.floor(mm / dot + 1e-6) * dot);
  const gs1Like = (v?: string) => !!v && /^\((\d{2})\)/.test(v.trim());
  let barField = barRaw;
  let barSym = ''; let barModule = 0;
  if (barRaw) {
    const sample = barRaw.sample?.trim() ?? '';
    barSym = barRaw.barcodeSym || (gs1Like(sample) ? 'GS1_128' : 'CODE128');
    const chars = Math.max(sample.length, 4);
    const modulesNeeded = 11 * (chars + 4) + 20; // 起止符+校验+每字符 11 模块，留余量
    const rawMax = Math.min(0.25, innerW / modulesNeeded); // 物理上限（未取整）
    if (rawMax < 0.19) {
      warnings.push(
        chars <= 24
          ? `一维码内容约 ${chars} 字符，${round2(innerW)}mm 内每个模块最多 ${round2(rawMax)}mm（<0.19mm 扫不稳），已改按文本排版；要扫码请缩短码值或改成二维码`
          : `一维码内容约 ${chars} 字符，${round2(innerW)}mm 内需约 ${round2(rawMax * 11 * (chars + 4))}mm，超出可印宽（<0.19mm/模块扫不稳），该字段未印；请改用二维码（UDI 单件标推荐二维码）`,
      );
      barField = undefined;
      if (chars <= 24) rowsSource = [...rowsSource, barRaw];
    } else {
      // 首选 0.25mm（按 dpi 取整点）；放不下就往下取到整点，但低于 0.19mm 就宁愿不出码
      const target = snapToDot(0.25, dpi);
      barModule = target * modulesNeeded <= innerW ? target : snapDown(rawMax);
      if (barModule < 0.19) {
        warnings.push(`一维码内容约 ${chars} 字符，${dpi}dpi 下最多 ${round2(rawMax)}mm/模块，但整点只能给 ${round2(barModule)}mm（<0.19mm 扫不稳），已省略一维码；请改用二维码或缩短码值`);
        barField = undefined;
        if (chars <= 24) rowsSource = [...rowsSource, barRaw];
        barModule = 0;
        barSym = '';
      }
    }
  }
  let codeZoneH = barField ? clamp(innerH * 0.3, 8, 16) : 0;
  let barTop = barField ? codeBottom - codeZoneH : codeBottom;

  // ---- 二维码：先按内容长度估需要多大，放不下就先砍一维码（UDI 场景二维码优先） ----
  const qrChars = (qrField?.sample ?? '').trim().length || 24;
  // QR 版本容量（ECC M，含 3 字节开销的保守值）：v2 25 模块≈26 字符，v3 29≈42，v4 33≈62，v5 37≈84
  const qrModules = qrChars <= 18 ? 21 : qrChars <= 26 ? 25 : qrChars <= 42 ? 29 : qrChars <= 62 ? 33 : qrChars <= 84 ? 37 : 41;
  const qrModuleSize = snapToDot(0.33, dpi);
  const qrNeed = round2(qrModules * qrModuleSize + 2.5);
  const qrTop = innerY + titleH + 1.4;
  if (qrField && barField) {
    const avail = barTop - 0.8 - qrTop;
    if (avail < qrNeed) {
      warnings.push(`纸型偏小：二维码需 ${qrNeed}mm 高、余 ${round2(avail)}mm，已省略底部一维码（UDI 以二维码为准）；如需一维码请加高标签`);
      barField = undefined; codeZoneH = 0; barTop = codeBottom;
    }
  }
  let qrSize = 0;
  if (qrField) {
    const avail = barField ? barTop - 0.8 - qrTop : codeBottom - qrTop;
    qrSize = Math.min(Math.max(qrNeed, 10), avail, innerW * 0.45, 26);
    if (qrSize + 0.01 < qrNeed) {
      warnings.push(`二维码内容约 ${qrChars} 字符，需要约 ${qrNeed}mm，当前只有 ${round2(qrSize)}mm，可能扫不出；建议加大标签或缩短内容`);
    }
    if (qrSize < 8) {
      warnings.push(`二维码可用空间仅 ${round2(Math.max(0, avail))}mm，已按 8mm 下限处理；打印后请扫码复核`);
      qrSize = Math.min(8, Math.max(6, avail));
    }
    qrSize = round2(qrSize);
  }

  const infoTop = qrTop;
  const infoBottom = barField ? barTop - 1 : codeBottom;
  const infoH = infoBottom - infoTop;
  if (infoH < 4) warnings.push(`信息区可用高度仅 ${round2(infoH)}mm，字段过多；建议加大标签高度或减少字段`);

  // ---- 信息区列数：宽 ≥55mm 且字段 ≥4 分两列；放不下时先改两列，再压行高，最后才省略 ----
  // 商业口径：宁可明确少印几个字段并报出来，也不把元素排到纸外（打出来是废签）。
  const MIN_ROW_MM = 2.4;
  let cols: 1 | 2 = (barField && innerW >= 90) || (innerW >= 55 && rowsSource.length >= 4 && !qrField) ? 2 : 1;
  const qrOnRight = !!qrField && (innerW >= 35);
  let infoW = qrOnRight ? innerW - qrSize - 2 : innerW;
  const maxRows = Math.max(1, Math.floor(infoH / MIN_ROW_MM));
  if (rowsSource.length > maxRows && cols === 1 && infoW >= 30) cols = 2;
  const capacity = maxRows * cols;
  let fieldsToPlace = rowsSource;
  if (rowsSource.length > capacity) {
    const dropped = rowsSource.slice(capacity);
    fieldsToPlace = rowsSource.slice(0, capacity);
    warnings.push(
      `信息区只放得下 ${capacity} 个字段，已省略 ${dropped.length} 个（${dropped.map((f) => f.label || f.name).join('、')}）；请加大标签尺寸或减少字段`,
    );
  }
  const rows = Math.max(1, Math.ceil(fieldsToPlace.length / cols));
  const rowH = clamp(infoH / rows, MIN_ROW_MM, 7);
  const valuePt = clamp(rowH * 2.1, 5, 12);
  const labelPt = clamp(valuePt * 0.9, 4.6, 10);
  const labelColW = cols === 2 ? infoW / 2 * 0.42 : Math.min(innerW * 0.34, 20);
  if (valuePt < 6) warnings.push(`字号只有 ${round2(valuePt)}pt，车间 1m 外看不清；建议加大标签或减少字段`);

  const elements: any[] = [];
  const variables: any[] = [];
  let z = 1;
  let eid = 0;
  const id = (p: string) => `${p}${++eid}`;

  // ---- 变量表：标题字段放最前（打印页按此顺序渲染），码变量只在真正出码时声明 ----
  if (titleField && !opts.title) {
    variables.push({
      name: titleField.name,
      type: titleField.type === 'number' ? 'number' : titleField.type === 'date' ? 'date' : 'text',
      label: titleField.label || titleField.name,
      defaultValue: titleField.sample ?? '',
      required: !!titleField.required,
    });
  }
  for (const f of fieldsToPlace) {
    variables.push({
      name: f.name,
      type: f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text',
      label: f.label || f.name,
      defaultValue: f.sample ?? '',
      required: !!f.required,
    });
  }
  if (barField) variables.push({ name: barField.name, type: 'text', label: barField.label || '条码', defaultValue: barField.sample ?? '', required: !!barField.required });
  if (qrField) variables.push({ name: qrField.name, type: 'text', label: qrField.label || '二维码', defaultValue: qrField.sample ?? '', required: !!qrField.required });

  // ---- 外框 ----
  if (opts.border !== false) {
    elements.push({
      id: id('border'), type: 'rect', x: 0.8, y: 0.8, w: round2(widthMm - 1.6), h: round2(heightMm - 1.6),
      fill: '#ffffff', stroke: { width: snapToDot(0.2, dpi), color: '#333333' }, zIndex: z++,
    });
  }

  // ---- 标题带 ----
  const titlePadX = 1.6;
  let titleX = innerX + titlePadX;
  if (style === 'medical' || style === 'retail') {
    // 左侧色条：小标签上比整条底纹省墨，也比纯文字更像"成品"
    elements.push({
      id: id('accent'), type: 'rect', x: innerX, y: innerY + 0.6, w: 1.1, h: round2(titleH - 1.2),
      fill: accent, stroke: { width: 0, color: accent }, zIndex: z++,
    });
    titleX = innerX + 2.2;
  }
  elements.push({
    id: id('title'), type: 'text', x: titleX, y: innerY + 0.5, w: round2(innerX + innerW - titleX), h: round2(titleH - 1),
    text: titleText,
    font: { family: 'Microsoft YaHei', size: clamp(titleH * 1.9, 7, 16), bold: true, color: '#111111', align: 'left', vAlign: 'middle', wrap: false },
    zIndex: z++,
  });

  // 标题下分割线
  elements.push({
    id: id('rule'), type: 'line', x: innerX, y: round2(innerY + titleH), x2: round2(innerX + innerW), y2: round2(innerY + titleH),
    stroke: { width: snapToDot(0.25, dpi), color: accent === '#111111' ? '#333333' : accent },
    zIndex: z++,
  });

  // ---- 信息区：标签列 + 值列 ----
  let fieldIdx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const f = fieldsToPlace[fieldIdx++];
      if (!f) continue;
      const colW = cols === 2 ? infoW / 2 : infoW;
      const x0 = innerX + (cols === 2 ? c * colW : 0);
      const y0 = infoTop + r * rowH;
      const labelW = cols === 2 ? colW * 0.42 : labelColW;
      elements.push({
        id: id('lb'), type: 'text', x: round2(x0), y: round2(y0), w: round2(labelW - 1), h: round2(rowH),
        text: `${f.label || f.name}`,
        font: { family: 'Microsoft YaHei', size: labelPt, bold: false, color: '#666666', align: 'left', vAlign: 'middle', wrap: false },
        zIndex: z++,
      });
      elements.push({
        id: id('val'), type: 'text', x: round2(x0 + labelW), y: round2(y0), w: round2(colW - labelW - 0.6), h: round2(rowH),
        text: `{{${f.name}}}`,
        font: { family: 'Microsoft YaHei', size: f.emphasis ? clamp(valuePt * 1.15, valuePt, 13) : valuePt, bold: !!f.emphasis, color: '#111111', align: 'left', vAlign: 'middle', wrap: false },
        zIndex: z++,
      });
    }
  }

  // ---- 页脚 ----
  if (hasFooter) {
    elements.push({
      id: id('footer'), type: 'text', x: innerX, y: round2(innerY + innerH - footerH), w: round2(innerW), h: round2(footerH),
      text: opts.footer!,
      font: { family: 'Microsoft YaHei', size: clamp(footerH * 1.7, 5, 8), bold: false, color: '#777777', align: 'left', vAlign: 'middle', wrap: false },
      zIndex: z++,
    });
  }

  // ---- 一维码：底部通栏（模块宽已按内容长度取整，保证整体落在可印宽内） ----
  if (barField) {
    const barH = Math.max(6, codeZoneH - 3.2);
    const barY = barTop + 0.8;
    elements.push({
      id: id('barcode'), type: 'barcode', x: innerX, y: round2(barY), w: round2(innerW), h: round2(codeZoneH),
      barcode: {
        sym: barSym,
        content: `{{${barField.name}}}`,
        moduleWidthMm: round2(barModule),
        wideRatio: 2.5,
        heightMm: round2(barH),
        showText: true,
        textPosition: 'bottom',
        quietZoneMm: snapToDot(2, dpi),
        textFont: { family: 'Arial', size: clamp(barH * 0.4, 2.5, 4) },
      },
      zIndex: z++,
    });
    if (barSym === 'GS1_128' && !gs1Like(barField.sample)) {
      warnings.push('一维码按 GS1_128 输出，但示例值不是 (AI) 格式；打印前请确认数据格式');
    }
  }

  // ---- 二维码：右上角（信息区在左） ----
  if (qrField) {
    const qx = innerX + innerW - qrSize;
    const qy = qrTop;
    elements.push({
      id: id('qrcode'), type: 'qrcode', x: round2(qx), y: round2(qy), w: round2(qrSize), h: round2(qrSize),
      qrcode: {
        sym: 'QRCODE',
        content: `{{${qrField.name}}}`,
        ecc: 'M',
        moduleSizeMm: round2(qrModuleSize),
        quietZoneMm: snapToDot(1.5, dpi),
        version: 0,
      },
      zIndex: z++,
    });
  }

  const template = {
    schemaVersion: 1,
    page: {
      widthMm, heightMm, dpi, orientation: 0, unit: 'mm',
      columns: 1, rows: 1, gapXMm: 2, gapYMm: 2, marginMm: 0,
      copies: 1, duplex: false, mediaType: 'gap', gapMm: 2, blackMarkMm: 3,
      offsetXMm: 0, offsetYMm: 0, calibrateXMm: 0, calibrateYMm: 0, guides: [],
    },
    variables,
    elements,
  };

  return {
    template,
    warnings,
    meta: {
      rows, columns: cols as 1 | 2, rowHeightMm: round2(rowH), fontPt: round2(valuePt),
      titleHeightMm: round2(titleH), codeZoneMm: round2(codeZoneH), dotMm,
    },
  };
}
