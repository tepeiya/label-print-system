// =============================================================================
// model.ts —— 元素工厂 / 默认值 / 常量（web/js/model.js 的 TS 版）
// 语义必须与原生版逐条对齐：同一份模板 JSON 要能在原生页、Vue 页、打印端得到
// 完全相同的画面，所以这里不擅自补默认值、不重排字段。
// =============================================================================

import { uid, r2, clamp } from './engine/util';
import type { ElementData, ElementType, TemplateData } from './types';

export const PAGE_PRESETS = [
  { name: '40 × 30 mm', w: 40, h: 30 },
  { name: '50 × 30 mm', w: 50, h: 30 },
  { name: '60 × 40 mm', w: 60, h: 40 },
  { name: '70 × 40 mm', w: 70, h: 40 },
  { name: '100 × 50 mm', w: 100, h: 50 },
  { name: '100 × 100 mm', w: 100, h: 100 },
  { name: 'A6 105 × 148', w: 105, h: 148 },
  { name: 'A4 210 × 297', w: 210, h: 297 },
];

export const DPI_OPTIONS = [203, 300, 600];

export const BARCODE_SYMS = [
  'CODE128', 'GS1_128', 'CODE39', 'CODE93', 'EAN13', 'EAN8', 'UPC', 'UPC_E',
  'ITF14', 'ITF', 'CODABAR', 'MSI', 'PHARMACODE', 'CODE16K',
  // P8.4 工业码制（位图预览，无打印机原生指令）
  'HIBC_128', 'HIBC_CODE39', 'PZN',
];

export const QRCODE_SYMS = [
  'QRCODE', 'MICROQR', 'DATAMATRIX', 'DATAMATRIX_RECT', 'PDF417', 'AZTEC',
  // P8.4 工业码制（位图预览，无打印机原生指令）
  'MAXICODE', 'HIBC_DATAMATRIX', 'HIBC_QR',
];

// -----------------------------------------------------------------------------
// P7.5 受限标记：与后端 core/symbology.capabilities.ts 的能力真源**同口径**。
// 这里只存「该码制能原生打印的指令协议」，展示文案由 buildSymOptions 派生，
// 保证前端下拉、生成器白名单、warnings 文案不各写一份（P7.2 复核的核心教训）。
// 后端提供 GET /print/symbologies 返回权威列表；前端这份是**离线兜底**
// （设计器首次加载、后端不可达时仍能正确标注），两者不一致以后端为准。
// 口径：无任何指令协议 → "预览仅"；其余列出可用协议；有协议但某协议降级 → 标注。
// P7.3：DMATRIX/PDF417/AZTEC 在 TSPL/TSPL2 官方手册有原生指令，从 ['ZPL'] 同步为 ['ZPL','TSPL']。
// -----------------------------------------------------------------------------
const PRINT_PROTOCOLS: Record<string, string[]> = {
  CODE128: ['ZPL', 'TSPL', 'EPL'], GS1_128: ['ZPL', 'TSPL'],
  CODE39: ['ZPL', 'TSPL', 'EPL'], CODE93: ['ZPL', 'TSPL'],
  EAN13: ['ZPL', 'TSPL', 'EPL'], EAN8: ['ZPL', 'TSPL', 'EPL'],
  UPC: ['ZPL', 'TSPL', 'EPL'], UPC_E: ['ZPL', 'TSPL', 'EPL'],
  ITF14: ['ZPL', 'TSPL'], ITF: ['ZPL', 'TSPL', 'EPL'],
  CODABAR: ['ZPL', 'TSPL', 'EPL'], MSI: ['ZPL', 'TSPL'],
  PHARMACODE: [], CODE16K: [],
  QRCODE: ['ZPL', 'TSPL', 'EPL'], MICROQR: ['ZPL'],  // MICROQR 在 TSPL 降级为标准 QR
  // P7.3：TSPL 原生二维指令（需固件门槛，见后端 caps.hint）
  DATAMATRIX: ['ZPL', 'TSPL'], DATAMATRIX_RECT: ['ZPL', 'TSPL'],
  PDF417: ['ZPL', 'TSPL'], AZTEC: ['ZPL', 'TSPL'],
  // P8.4 工业码制：位图通道可用，ZPL/TSPL/EPL 均无原生指令 → 标「预览仅·需图像通道」
  MAXICODE: [], HIBC_128: [], HIBC_CODE39: [], HIBC_DATAMATRIX: [], HIBC_QR: [], PZN: [],
};

/** 某些码制在指定协议下会降级（与后端 SymUiItem.degradeOn 同口径） */
const DEGRADE_ON: Record<string, string[]> = {
  MICROQR: ['TSPL'],  // TSPL 无 Micro QR，降级为标准 QRCODE
};

/** 生成 [value, label] 元组选项（FSelect 原生支持），label 带受限/降级标记 */
export function buildSymOptions(syms: string[]): Array<[string, string]> {
  return syms.map((sym) => {
    const protocols = PRINT_PROTOCOLS[sym] ?? [];
    const degrade = DEGRADE_ON[sym] ?? [];
    let badge: string;
    if (!protocols.length) {
      badge = '（预览仅·需图像通道）';
    } else {
      const degradeNote = degrade.length ? `；${degrade.join('/')}降级` : '';
      badge = `（${protocols.join('/')}${degradeNote}）`;
    }
    return [sym, `${sym} ${badge}`] as [string, string];
  });
}

export const BARCODE_SYM_OPTIONS = buildSymOptions(BARCODE_SYMS);
export const QRCODE_SYM_OPTIONS = buildSymOptions(QRCODE_SYMS);

export const MEDIA_TYPES = [
  { value: 'gap', label: '间隙标签（GAP）' },
  { value: 'black', label: '黑标标签（BM）' },
  { value: 'continuous', label: '连续纸（CONTINUOUS）' },
];

export const VAR_VALIDATIONS = [
  { value: '', label: '不校验' },
  { value: 'nonempty', label: '必填' },
  { value: 'number', label: '数字' },
  { value: 'integer', label: '整数' },
  { value: 'unique', label: '唯一（重复码检测）' },
  { value: 'regex', label: '正则' },
];

export const SYSVAR_KEYS: Array<[string, string]> = [
  ['printDate', '打印日期'],
  ['printTime', '打印时间'],
  ['pageNo', '当前页号'],
  ['pageTotal', '总页数'],
  ['printerName', '打印机名'],
  ['tenantName', '租户名'],
  ['printUser', '打印人'],
  ['uuid', 'UUID'],
];

export const FONT_FAMILIES = [
  'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Verdana',
  'Courier New', 'Consolas', 'SimSun', 'SimHei', 'Microsoft YaHei',
];

export const TYPE_LABELS: Record<ElementType, string> = {
  text: '文本', richtext: '富文本', rect: '矩形', ellipse: '椭圆', line: '直线', table: '表格', image: '图片',
  barcode: '一维码', qrcode: '二维码', formula: '公式', serial: '流水号',
  datetime: '日期', sysvar: '系统变量', dbField: 'DB字段',
};

export const TYPE_ICONS: Record<ElementType, string> = {
  text: 'T', richtext: '𝐓', rect: '▭', ellipse: '◯', line: '／', table: '▦', image: '🖼',
  barcode: '▮▮', qrcode: '▩', formula: 'ƒ', serial: '#', datetime: '📅', sysvar: '{}', dbField: '⛁',
};

export interface ToolItem {
  type: ElementType;
  label: string;
  icon: string;
  /** 白话副标题：一句话说明这个元素拿来干什么 */
  desc: string;
  /** 悬浮详细解释：解决「它和另一个有什么区别」的疑问 */
  tip: string;
}

export const TOOLS: Array<{ group: string; items: ToolItem[] }> = [
  {
    group: '基本图形',
    items: [
      { type: 'text', label: '文本', icon: 'T', desc: '写一行字', tip: '在右侧填写文字；双击标签可以直接在画布上改。支持 {{变量名}} 插入动态内容。' },
      { type: 'richtext', label: '富文本', icon: '𝐓', desc: '一段里多种样式', tip: '把文字拆成多个片段，每段单独设粗体/颜色/字号。适合「品名加粗 + 规格 normal」这类混排。' },
      { type: 'line', label: '直线', icon: '／', desc: '画分隔线', tip: '在属性里设起点/终点和线宽，可以做标签边框或分隔。' },
      { type: 'rect', label: '矩形', icon: '▭', desc: '画方框/底色', tip: '可设填充色、边框和圆角，常用来做标签背景或色块。' },
      { type: 'ellipse', label: '椭圆', icon: '◯', desc: '画圆/椭圆', tip: '适合做圆形图标底、角标或装饰。' },
      { type: 'table', label: '表格', icon: '▦', desc: '行列排内容', tip: '在「单元格」里逐格填内容，可合并单元格。适合成分表、参数表。' },
      { type: 'image', label: '图片', icon: '🖼', desc: '放 logo/照片', tip: '右侧填图片地址或 base64。建议用绝对路径，打印时才不会丢图。' },
    ],
  },
  {
    group: '条码二维码',
    items: [
      { type: 'barcode', label: '一维码', icon: '▮▮', desc: '商品/SKU 条码', tip: '选择码制（Code128/EAN 等）并填内容。勾选「校验位」会自动补校验字符。' },
      { type: 'qrcode', label: '二维码', icon: '▩', desc: '扫一扫跳转/溯源', tip: '填网址或文本，扫码即可打开。可设纠错级别，越高越耐脏污。' },
    ],
  },
  {
    group: '动态字段',
    items: [
      { type: 'formula', label: '公式', icon: 'ƒ', desc: '自动算出来的值', tip: '写公式如 {{price}} * {{qty}}，打印时按每行数据自动计算。双击也能在画布上改公式。' },
      { type: 'serial', label: '流水号', icon: '#', desc: '递增编号', tip: '打印时按份数递增，可设前缀、起始号和位数，如 GRN00001、GRN00002。' },
      { type: 'datetime', label: '日期', icon: '📅', desc: '当天日期/时间', tip: '打印时自动取当前时间，可选日期格式和前后偏移天数。' },
      { type: 'sysvar', label: '系统变量', icon: '{}', desc: '页码/打印人等', tip: '内置 8 个变量：打印日期、时间、页码、总页数、打印机名、租户名、打印人、UUID，打印时自动填入。' },
      { type: 'dbField', label: 'DB字段', icon: '⛁', desc: '取表格里的列', tip: '先在「数据源管理」导入 Excel/CSV，打印时选该数据源，这里填列名即可自动取值。' },
    ],
  },
];

const baseFont = () => ({
  family: 'Arial', size: 9, color: '#000000', bold: false, italic: false,
  align: 'left' as const, vAlign: 'middle' as const, wrap: true,
});

/** 在页面范围内找一个不重叠的落点（h 保留在签名里，和原生版同一入参形状） */
function nextSpot(elements: ElementData[], w: number, _h: number) {
  const base = 3;
  let x = base;
  let y = base;
  for (let i = 0; i < 40; i++) {
    const hit = elements.some((e) => Math.abs(e.x - x) < 2 && Math.abs(e.y - y) < 2);
    if (!hit) break;
    x += 3;
    y += 3;
    if (x + w > 90) { x = base; y += 6; }
  }
  return { x: r2(x), y: r2(y) };
}

export function createElement(type: ElementType, template?: TemplateData): ElementData {
  const els = template?.elements ?? [];
  const zIndex = (els.reduce((m, e) => Math.max(m, e.zIndex ?? 0), 0) || 0) + 1;
  const id = uid();
  const common = (w: number, h: number) => {
    const p = nextSpot(els, w, h);
    return { id, x: p.x, y: p.y, w, h, rotation: 0, zIndex, locked: false, visible: true, opacity: 1 };
  };

  switch (type) {
    case 'text':
      return { ...common(30, 6), type: 'text', text: '文本内容', font: baseFont() };

    case 'richtext':
      return {
        ...common(36, 8), type: 'richtext',
        runs: [
          { text: '富', bold: true, color: '#c0392b' },
          { text: '文本', italic: true },
          { text: '示例', underline: true, size: 8 },
        ],
        font: baseFont(),
      };

    case 'dbField':
      return {
        ...common(30, 6), type: 'dbField',
        dbField: { field: '{{sku}}', format: '', fallback: '—' },
        font: baseFont(),
      };

    case 'line':
      return {
        ...common(30, 10), type: 'line', x2: 33, y2: 13,
        stroke: { width: 0.3, color: '#333333', style: 'solid' },
      };

    case 'rect':
      return {
        ...common(30, 15), type: 'rect', fill: '#ffffff', cornerRadius: 0,
        stroke: { width: 0.3, color: '#333333', style: 'solid' },
      };

    case 'ellipse':
      return {
        ...common(25, 15), type: 'ellipse', fill: '#ffffff',
        stroke: { width: 0.3, color: '#333333', style: 'solid' },
      };

    case 'table':
      return {
        ...common(45, 20), type: 'table', rows: 3, cols: 3,
        cells: ['列1', '列2', '列3', '{{sku}}', '{{productName}}', '', '', '', ''],
        showBorder: true, borderWidth: 0.2, borderColor: '#333333',
        headerRow: true, headerBg: '#f2f2f2',
        font: { family: 'Arial', size: 7, color: '#000000', align: 'center' },
      };

    case 'image':
      return { ...common(20, 20), type: 'image', src: '' };

    case 'barcode':
      return {
        ...common(42, 15), type: 'barcode',
        barcode: {
          sym: 'CODE128', content: '{{sku}}', moduleWidthMm: 0.25,
          wideRatio: 2.5, heightMm: 9, showText: true, textPosition: 'bottom', checksum: false,
          quietZoneMm: 2, textFont: { family: 'Arial', size: 2.4 },
        },
      };

    case 'qrcode':
      return {
        ...common(18, 18), type: 'qrcode',
        qrcode: {
          sym: 'QRCODE', content: '{{sku}}', ecc: 'M', moduleSizeMm: 0.4,
          quietZoneMm: 2, version: 0,
        },
      };

    case 'formula':
      return {
        ...common(30, 6), type: 'formula',
        formula: { expr: '{{price}}', defaultOnError: '' }, font: baseFont(),
      };

    case 'serial':
      return {
        ...common(30, 6), type: 'serial',
        serial: { sequenceRef: 'default', digits: 5, prefix: 'SN-', suffix: '' },
        font: baseFont(),
      };

    case 'datetime':
      return {
        ...common(34, 6), type: 'datetime',
        datetime: { pattern: 'YYYY-MM-DD', source: 'print' }, font: baseFont(),
      };

    case 'sysvar':
      return {
        ...common(28, 6), type: 'sysvar',
        sysvar: { key: 'printDate' }, font: baseFont(),
      };

    default:
      throw new Error('未知元素类型: ' + String(type));
  }
}

export function defaultTemplate(): TemplateData {
  return {
    schemaVersion: 1,
    page: {
      widthMm: 60, heightMm: 40, dpi: 203,
      orientation: 0, unit: 'mm',
      columns: 1, rows: 1, gapXMm: 2, gapYMm: 2, marginMm: 0,
      copies: 1, duplex: false,
      mediaType: 'gap', gapMm: 2, blackMarkMm: 3,
      offsetXMm: 0, offsetYMm: 0, calibrateXMm: 0, calibrateYMm: 0,
      guides: [],
    },
    // 新建模板不预置变量：变量由用户按需在「变量」面板添加或从产品字段导入。
    variables: [],
    elements: [],
  };
}

/** 首屏演示模板，避免空白画布（与原生版同一份内容） */
export function demoTemplate(): TemplateData {
  const t = defaultTemplate();
  const mk = (type: ElementType, patch: Partial<ElementData>) => {
    const e = createElement(type, t);
    Object.assign(e, patch);
    t.elements.push(e);
    return e;
  };
  mk('rect', { x: 2, y: 2, w: 56, h: 36, zIndex: 1, fill: '#ffffff' });
  mk('text', {
    x: 4, y: 4, w: 40, h: 5, zIndex: 3, text: '示例商品',
    font: { ...baseFont(), size: 11, bold: true, color: '#111111' },
  });
  mk('line', { x: 4, y: 10, x2: 56, y2: 10, w: 52, h: 0, zIndex: 2, stroke: { width: 0.25, color: '#999999', style: 'solid' } });
  mk('text', {
    x: 4, y: 11.5, w: 26, h: 5, zIndex: 3, text: 'SKU: SKU-0001',
    font: { ...baseFont(), size: 8 },
  });
  mk('qrcode', { x: 36, y: 12, w: 18, h: 18, zIndex: 4 });
  mk('barcode', { x: 4, y: 21.5, w: 30, h: 11, zIndex: 4, barcode: { ...createElement('barcode', t).barcode } });
  mk('text', {
    x: 4, y: 34, w: 30, h: 4, zIndex: 3, text: '¥ 19.9',
    font: { ...baseFont(), size: 9, bold: true, color: '#c0392b' },
  });
  return t;
}

/** 新元素落在可见区域中央（app.js#addElement 的语义） */
export function centerOnPage(el: ElementData, widthMm: number, heightMm: number) {
  el.x = r2(clamp(widthMm / 2 - el.w / 2, 0, Math.max(0, widthMm - el.w)));
  el.y = r2(clamp(heightMm / 2 - el.h / 2, 0, Math.max(0, heightMm - el.h)));
}
