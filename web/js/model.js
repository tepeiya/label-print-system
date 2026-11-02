// =============================================================================
// model.js —— 元素工厂 / 默认值 / 常量
// 坐标与尺寸对外一律 mm；渲染时按 96dpi 基准换算成 CSS px
// =============================================================================

import { uid, r2 } from './util.js';
export { uid } from './util.js';

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
];

export const QRCODE_SYMS = [
  'QRCODE', 'MICROQR', 'DATAMATRIX', 'DATAMATRIX_RECT', 'PDF417', 'AZTEC',
];

/** 打印介质类型（影响间隙/黑标定位） */
export const MEDIA_TYPES = [
  { value: 'gap', label: '间隙标签（GAP）' },
  { value: 'black', label: '黑标标签（BM）' },
  { value: 'continuous', label: '连续纸（CONTINUOUS）' },
];

/** 变量校验类型 */
export const VAR_VALIDATIONS = [
  { value: '', label: '不校验' },
  { value: 'nonempty', label: '必填' },
  { value: 'number', label: '数字' },
  { value: 'integer', label: '整数' },
  { value: 'unique', label: '唯一（重复码检测）' },
  { value: 'regex', label: '正则' },
];

export const SYSVAR_KEYS = [
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

/** 工具箱定义（图标用纯文本，避免外部图标依赖） */
export const TOOLS = [
  { group: '基本图形', items: [
    { type: 'text', label: '文本', icon: 'T' },
    { type: 'line', label: '直线', icon: '／' },
    { type: 'rect', label: '矩形', icon: '▭' },
    { type: 'ellipse', label: '椭圆', icon: '◯' },
    { type: 'table', label: '表格', icon: '▦' },
    { type: 'image', label: '图片', icon: '🖼' },
  ]},
  { group: '条码二维码', items: [
    { type: 'barcode', label: '一维码', icon: '▮▮' },
    { type: 'qrcode', label: '二维码', icon: '▩' },
  ]},
  { group: '动态字段', items: [
    { type: 'formula', label: '公式', icon: 'ƒ' },
    { type: 'serial', label: '流水号', icon: '#' },
    { type: 'datetime', label: '日期', icon: '📅' },
    { type: 'sysvar', label: '系统变量', icon: '{}' },
  ]},
];

const baseFont = () => ({
  family: 'Arial', size: 9, color: '#000000', bold: false, italic: false,
  align: 'left', vAlign: 'middle', wrap: true,
});

/** 在页面范围内找一个不重叠的落点 */
function nextSpot(elements, w, h) {
  const base = 3;
  let x = base, y = base;
  for (let i = 0; i < 40; i++) {
    const hit = elements.some((e) =>
      Math.abs(e.x - x) < 2 && Math.abs(e.y - y) < 2);
    if (!hit) break;
    x += 3; y += 3;
    if (x + w > 90) { x = base; y += 6; }
  }
  return { x: r2(x), y: r2(y) };
}

export function createElement(type, template) {
  const els = template?.elements ?? [];
  const zIndex = (els.reduce((m, e) => Math.max(m, e.zIndex ?? 0), 0) || 0) + 1;
  const id = uid();
  const common = (w, h) => {
    const p = nextSpot(els, w, h);
    return { id, x: p.x, y: p.y, w, h, rotation: 0, zIndex, locked: false, visible: true, opacity: 1 };
  };

  switch (type) {
    case 'text':
      return { ...common(30, 6), type: 'text', text: '文本内容', font: baseFont() };

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
      throw new Error('未知元素类型: ' + type);
  }
}

export function defaultTemplate() {
  return {
    schemaVersion: 1,
    page: {
      widthMm: 60, heightMm: 40, dpi: 203,
      orientation: 0, unit: 'mm',
      columns: 1, rows: 1, gapXMm: 2, gapYMm: 2, marginMm: 0,
      copies: 1, duplex: false,
      mediaType: 'gap', gapMm: 2, blackMarkMm: 3,
      offsetXMm: 0, offsetYMm: 0, calibrateXMm: 0, calibrateYMm: 0,
      /** 参考线：[{ id, axis: 'x'|'y', pos(mm) }] */
      guides: [],
    },
    variables: [
      { name: 'sku', type: 'text', label: 'SKU', defaultValue: 'SKU-0001', required: false, unique: false },
      { name: 'productName', type: 'text', label: '产品名', defaultValue: '示例商品', required: false, unique: false },
      { name: 'price', type: 'number', label: '单价', defaultValue: 19.9, required: false, unique: false },
      { name: 'qty', type: 'number', label: '数量', defaultValue: 12, required: false, unique: false },
    ],
    elements: [],
  };
}

/** 一个用于首屏的演示模板，避免空白画布 */
export function demoTemplate() {
  const t = defaultTemplate();
  const mk = (type, patch) => {
    const e = createElement(type, t);
    Object.assign(e, patch);
    t.elements.push(e);
    return e;
  };
  mk('rect', { x: 2, y: 2, w: 56, h: 36, zIndex: 1, fill: '#ffffff' });
  mk('text', {
    x: 4, y: 4, w: 40, h: 5, zIndex: 3, text: '{{productName}}',
    font: { ...baseFont(), size: 11, bold: true, color: '#111111' },
  });
  mk('line', { x: 4, y: 10, x2: 56, y2: 10, w: 52, h: 0, zIndex: 2, stroke: { width: 0.25, color: '#999999', style: 'solid' } });
  mk('text', {
    x: 4, y: 11.5, w: 26, h: 5, zIndex: 3, text: 'SKU: {{sku}}',
    font: { ...baseFont(), size: 8 },
  });
  mk('qrcode', { x: 36, y: 12, w: 18, h: 18, zIndex: 4 });
  mk('barcode', { x: 4, y: 21.5, w: 30, h: 11, zIndex: 4, barcode: { ...createElement('barcode', t).barcode } });
  mk('text', {
    x: 4, y: 34, w: 30, h: 4, zIndex: 3, text: '¥ {{price}}',
    font: { ...baseFont(), size: 9, bold: true, color: '#c0392b' },
  });
  return t;
}
