// LLM 输出校验与规范化：防止模型幻觉破坏模板结构
import { toBarcodeSym } from './barcode-reader';

const ELEMENT_TYPES = new Set([
  'text', 'richtext', 'image', 'line', 'rect', 'ellipse', 'table',
  'barcode', 'qrcode', 'formula', 'serial', 'datetime', 'sysvar',
]);

const BARCODE_SYMS = new Set([
  'CODE128', 'CODE39', 'CODE93', 'EAN13', 'EAN8', 'UPC_A', 'ITF14',
  'GS1_128', 'CODABAR', 'MSI', 'CODE11',
]);

const QR_SYMS = new Set(['QRCODE', 'MICRO_QR', 'DATAMICRO_QR', 'DATAMATRIX', 'PDF417', 'AZTEC']);

const ECC = new Set(['L', 'M', 'Q', 'H']);

export interface ValidateResult {
  template: any;
  warnings: string[];
  /** 被丢弃/修正的元素数 */
  droppedCount: number;
  fixedCount: number;
}

/**
 * 校验并修正 LLM 返回的模板。
 * @param raw        模型返回对象（应含 template 字段，也兼容直接返回 template）
 * @param expected   用户指定的页面尺寸，用于强制覆写
 * @param confidence 启发式阶段的置信度，用于兜底
 */
export function validateAiTemplate(raw: any, expected: { widthMm: number; heightMm: number; dpi: number }): ValidateResult {
  const warnings: string[] = [];
  let droppedCount = 0;
  let fixedCount = 0;

  const src = raw?.template ?? raw;
  if (!src || typeof src !== 'object') {
    throw new Error('LLM 输出缺少 template 对象');
  }

  const page = {
    widthMm: expected.widthMm,
    heightMm: expected.heightMm,
    dpi: expected.dpi,
    orientation: 0,
    unit: 'mm',
    columns: 1, rows: 1, gapXMm: 2, gapYMm: 2, marginMm: 0,
    copies: 1, duplex: false,
    mediaType: 'gap', gapMm: 2, blackMarkMm: 3,
    offsetXMm: 0, offsetYMm: 0, calibrateXMm: 0, calibrateYMm: 0,
    guides: [],
  };
  if (src.page && (src.page.widthMm !== expected.widthMm || src.page.heightMm !== expected.heightMm)) {
    warnings.push('模型给出的页面尺寸与用户输入不一致，已强制覆写为用户输入值');
    fixedCount++;
  }

  // ---- 变量 ----
  const variables: any[] = [];
  const varNames = new Set<string>();
  let vi = 0;
  for (const v of Array.isArray(src.variables) ? src.variables : []) {
    let name = String(v?.name ?? '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      name = `var${++vi}`;
      fixedCount++;
    }
    if (varNames.has(name)) {
      let n = 2;
      while (varNames.has(`${name}${n}`)) n++;
      name = `${name}${n}`;
      fixedCount++;
    }
    varNames.add(name);
    const type = ['text', 'number', 'date', 'boolean', 'image'].includes(v?.type) ? v.type : 'text';
    variables.push({
      name,
      type,
      label: String(v?.label ?? name),
      defaultValue: v?.defaultValue ?? '',
      required: !!v?.required,
      unique: !!v?.unique,
    });
  }

  // ---- 元素 ----
  const elements: any[] = [];
  const usedIds = new Set<string>();
  let idx = 0;
  const rawEls = Array.isArray(src.elements) ? src.elements : [];

  for (const el of rawEls) {
    const type = String(el?.type ?? '');
    if (!ELEMENT_TYPES.has(type)) { droppedCount++; continue; }
    const num = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
    let x = num(el.x), y = num(el.y), w = num(el.w), h = num(el.h);
    if (w <= 0 || h <= 0) {
      if (type !== 'line') { droppedCount++; continue; }
      w = Math.max(w, 0.1); h = Math.max(h, 0.1);
    }

    // 坐标越界 clamp（允许 5% 容差）
    const maxX = expected.widthMm * 1.05;
    const maxY = expected.heightMm * 1.05;
    if (x < -expected.widthMm * 0.05 || y < -expected.heightMm * 0.05) { droppedCount++; continue; }
    if (x > maxX || y > maxY) { droppedCount++; continue; }
    if (x + w > maxX) { w = Math.max(1, maxX - x); fixedCount++; }
    if (y + h > maxY) { h = Math.max(1, maxY - y); fixedCount++; }

    let id = String(el.id ?? '');
    if (!id || usedIds.has(id)) { id = `e${++idx}`; fixedCount++; }
    usedIds.add(id);

    const base: any = {
      id, type,
      x: round2(x), y: round2(y), w: round2(w), h: round2(h),
      rotation: [0, 90, 180, 270].includes(Number(el.rotation)) ? Number(el.rotation) : 0,
      zIndex: Number.isFinite(Number(el.zIndex)) ? Number(el.zIndex) : elements.length + 1,
      locked: !!el.locked, visible: el.visible !== false,
      opacity: Number.isFinite(Number(el.opacity)) ? Math.max(0, Math.min(1, Number(el.opacity))) : 1,
    };

    switch (type) {
      case 'text':
      case 'formula':
      case 'serial':
      case 'datetime':
      case 'sysvar': {
        let text = String(el.text ?? '');
        const font = normalizeFont(el.font);
        if (type === 'text') base.text = text;
        if (type === 'formula') base.formula = { expr: String(el.formula?.expr ?? text ?? ''), defaultOnError: '' };
        if (type === 'serial') base.serial = {
          sequenceRef: String(el.serial?.sequenceRef ?? 'default'),
          digits: Math.max(1, Math.min(12, Number(el.serial?.digits ?? 5))),
          prefix: String(el.serial?.prefix ?? ''),
          suffix: String(el.serial?.suffix ?? ''),
        };
        if (type === 'datetime') base.datetime = { pattern: String(el.datetime?.pattern ?? 'YYYY-MM-DD'), source: 'print' };
        if (type === 'sysvar') base.sysvar = { key: String(el.sysvar?.key ?? 'printDate') };
        base.font = font;
        break;
      }
      case 'barcode': {
        const b = el.barcode ?? {};
        let sym = String(b.sym ?? 'CODE128').toUpperCase().replace('-', '_');
        if (!BARCODE_SYMS.has(sym)) {
          sym = toBarcodeSym(sym);
          if (!BARCODE_SYMS.has(sym)) { sym = 'CODE128'; fixedCount++; }
        }
        base.barcode = {
          sym,
          content: String(b.content ?? ''),
          moduleWidthMm: clampNum(b.moduleWidthMm, 0.12, 0.6, 0.25),
          wideRatio: clampNum(b.wideRatio, 2, 3, 2.5),
          heightMm: clampNum(b.heightMm, 2, h, Math.max(2, h * 0.78)),
          showText: b.showText !== false,
          textPosition: b.textPosition === 'top' ? 'top' : 'bottom',
          checksum: !!b.checksum,
          quietZoneMm: clampNum(b.quietZoneMm, 0, 10, 2),
          textFont: normalizeFont(b.textFont, 2.4),
        };
        break;
      }
      case 'qrcode': {
        const q = el.qrcode ?? {};
        let sym = String(q.sym ?? 'QRCODE').toUpperCase();
        if (sym === 'QR') sym = 'QRCODE';
        if (!QR_SYMS.has(sym)) { sym = 'QRCODE'; fixedCount++; }
        base.qrcode = {
          sym,
          content: String(q.content ?? ''),
          ecc: ECC.has(String(q.ecc ?? '').toUpperCase()) ? String(q.ecc).toUpperCase() : 'M',
          moduleSizeMm: clampNum(q.moduleSizeMm, 0.15, 1.5, 0.4),
          quietZoneMm: clampNum(q.quietZoneMm, 0, 10, 2),
          version: Number.isFinite(Number(q.version)) ? Number(q.version) : 0,
        };
        break;
      }
      case 'line': {
        base.x2 = round2(num(el.x2, x + w));
        base.y2 = round2(num(el.y2, y));
        base.w = round2(Math.abs(base.x2 - x));
        base.h = round2(Math.abs(base.y2 - y));
        base.stroke = normalizeStroke(el.stroke);
        break;
      }
      case 'rect':
      case 'ellipse': {
        base.fill = String(el.fill ?? '#ffffff');
        base.stroke = normalizeStroke(el.stroke);
        if (type === 'rect') base.cornerRadius = clampNum(el.cornerRadius, 0, 50, 0);
        break;
      }
      case 'image': {
        base.src = String(el.src ?? el.image?.src ?? '');
        break;
      }
      case 'table': {
        const rows = Math.max(1, Math.min(50, Number(el.rows ?? 1)));
        const cols = Math.max(1, Math.min(20, Number(el.cols ?? 1)));
        const cells = Array.isArray(el.cells) ? el.cells.slice(0, rows * cols).map((c: any) => String(c ?? '')) : [];
        while (cells.length < rows * cols) cells.push('');
        base.rows = rows; base.cols = cols; base.cells = cells;
        base.showBorder = el.showBorder !== false;
        base.borderWidth = clampNum(el.borderWidth, 0.05, 2, 0.2);
        base.borderColor = String(el.borderColor ?? '#333333');
        base.headerRow = !!el.headerRow;
        base.headerBg = String(el.headerBg ?? '#f2f2f2');
        base.font = normalizeFont(el.font, 7);
        // 合并单元格：[{ row, col, rowSpan, colSpan }]
        if (Array.isArray(el.mergedCells)) {
          const merged: any[] = [];
          for (const mc of el.mergedCells) {
            if (!mc || typeof mc !== 'object') continue;
            const row = Math.max(0, Math.min(rows - 1, Number(mc.row ?? mc.r)));
            const col = Math.max(0, Math.min(cols - 1, Number(mc.col ?? mc.c)));
            const rowSpan = Math.max(1, Math.min(rows - row, Number(mc.rowSpan ?? mc.rs ?? 1)));
            const colSpan = Math.max(1, Math.min(cols - col, Number(mc.colSpan ?? mc.cs ?? 1)));
            if (rowSpan === 1 && colSpan === 1) continue;
            merged.push({ row, col, rowSpan, colSpan });
          }
          if (merged.length) base.mergedCells = merged;
        }
        break;
      }
      default:
        break;
    }
    elements.push(base);
  }

  if (!elements.length) {
    warnings.push('模型未产出任何合法元素，已回退到启发式结果');
  }

  // ---- 补全 {{var}} 声明 ----
  const missing = new Set<string>();
  const scanText = (s: string) => {
    const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) if (!varNames.has(m[1])) missing.add(m[1]);
  };
  for (const el of elements) {
    if (el.text) scanText(el.text);
    if (el.barcode?.content) scanText(el.barcode.content);
    if (el.qrcode?.content) scanText(el.qrcode.content);
    if (el.formula?.expr) scanText(el.formula.expr);
    for (const c of el.cells ?? []) scanText(String(c));
  }
  for (const name of missing) {
    variables.push({ name, type: 'text', label: name, defaultValue: '', required: false, unique: false });
    fixedCount++;
  }
  if (missing.size) warnings.push(`自动补全了 ${missing.size} 个未声明的变量：${[...missing].join(', ')}`);

  // ---- 层级排序 ----
  elements.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  elements.forEach((e, i) => { if (!Number.isFinite(Number(e.zIndex))) e.zIndex = i + 1; });

  return {
    template: { schemaVersion: 1, page, variables, elements },
    warnings,
    droppedCount,
    fixedCount,
  };
}

function round2(v: number) { return Math.round(v * 100) / 100; }

function clampNum(v: any, min: number, max: number, dft: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.round(Math.max(min, Math.min(max, n)) * 1000) / 1000;
}

function normalizeFont(f: any, defaultSize = 9) {
  return {
    family: String(f?.family ?? 'Arial'),
    size: clampNum(f?.size, 4, 72, defaultSize),
    color: String(f?.color ?? '#000000'),
    bold: !!f?.bold,
    italic: !!f?.italic,
    align: ['left', 'center', 'right'].includes(f?.align) ? f.align : 'left',
    vAlign: ['top', 'middle', 'bottom'].includes(f?.vAlign) ? f.vAlign : 'middle',
    wrap: f?.wrap !== false,
  };
}

function normalizeStroke(s: any) {
  return {
    width: clampNum(s?.width, 0.05, 5, 0.3),
    color: String(s?.color ?? '#333333'),
    style: ['solid', 'dashed', 'dotted'].includes(s?.style) ? s.style : 'solid',
  };
}
