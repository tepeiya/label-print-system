// =============================================================================
// element-variable.ts —— 「一键把元素设为变量」纯逻辑（无 Vue 依赖，可单测）
//   当前内容 → 变量示例值；元素内容 → {{变量名}}
//   每个元素只绑定一个内容位置：text/rich 首片段/barcode/qrcode/image src/表格首个正文格
// =============================================================================

import { TYPE_LABELS } from '../model';
import type { ElementData } from '../types';
import { buildTableLayout } from './table-layout';
import { normalizeRuns } from './rich-text';

/** 与 VariablesPanel 同口径：无空白/花括号，不以数字或 @ 开头 */
export const VAR_NAME_RE = /^[^\s{}@0-9][^\s{}]*$/;

export function isValidVariableName(name: string): boolean {
  return VAR_NAME_RE.test(String(name ?? '').trim());
}

export interface ElementVariablePlan {
  ok: true;
  name: string;
  /** 变量示例值（图片为地址） */
  sample: string;
  /** 绑定位置说明，如「表格 R2C1」 */
  slot?: string;
  apply: (el: ElementData) => void;
}

export interface ElementVariableError {
  ok: false;
  reason: string;
}

export type ElementVariableResult = ElementVariablePlan | ElementVariableError;

const PLACEHOLDER_ONLY = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;
const PLACEHOLDER_ANY = /\{\{[^{}]*\}\}/g;

const UNSUPPORTED: Partial<Record<ElementData['type'], string>> = {
  rect: '矩形没有可绑定的内容',
  ellipse: '椭圆没有可绑定的内容',
  line: '直线没有可绑定的内容',
  serial: '流水号由系统按序生成，可在文本里用 {{@serial}} 引用',
  datetime: '日期按打印时刻生成，数据里的日期请用文本或 DB 字段',
  sysvar: '系统变量来自打印上下文，不需要设为变量',
  formula: '公式结果由表达式算出，不需要设为变量',
  dbField: 'DB 字段已按列名取值，改字段名即可',
};

export function canBindElement(el: ElementData | undefined | null): boolean {
  return !!el && !UNSUPPORTED[el.type];
}

export function unsupportedReason(el: ElementData): string {
  return UNSUPPORTED[el.type] ?? '';
}

interface CellPick {
  idx: number;
  row: number;
  col: number;
  text: string;
}

/** 首个正文格：优先有内容的，跳过被合并覆盖的格子 */
function pickTableCell(el: ElementData): CellPick {
  const rows = Math.max(1, el.rows || 1);
  const cols = Math.max(1, el.cols || 1);
  const layout = buildTableLayout(rows, cols, el.mergedCells);
  const startRow = el.headerRow && layout.rows > 1 ? 1 : 0;
  let firstEmpty: CellPick | null = null;

  for (let r = startRow; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      if (layout.skipped.includes(`${r},${c}`)) continue;
      const idx = r * cols + c;
      const text = String(el.cells?.[idx] ?? '');
      if (text.trim()) return { idx, row: r, col: c, text };
      if (!firstEmpty) firstEmpty = { idx, row: r, col: c, text };
    }
  }
  return firstEmpty ?? { idx: 0, row: 0, col: 0, text: String(el.cells?.[0] ?? '') };
}

function richTextOf(el: ElementData): string {
  return normalizeRuns(el.runs, el.text).map((r) => r.text).join('');
}

function contentOf(el: ElementData, cell?: CellPick): string {
  switch (el.type) {
    case 'text': return String(el.text ?? '');
    case 'richtext': return richTextOf(el);
    case 'barcode': return String(el.barcode?.content ?? '');
    case 'qrcode': return String(el.qrcode?.content ?? '');
    case 'image': return String(el.src ?? '');
    case 'table': return cell?.text ?? '';
    default: return '';
  }
}

/** "产品名称：示例" → 产品名称 / "SKU: SKU-001" → SKU */
function nameFromContent(raw: string): string {
  let s = String(raw ?? '').replace(PLACEHOLDER_ANY, '');
  s = s.split(/[：:，,、=＝|｜\r\n]/)[0] ?? '';
  s = s
    .replace(/[《》<>「」『』“”"'‘’【】[\]（）()。.；;!！?？/\\￥¥$€]/g, '')
    .replace(/[\s{}@]/g, '')
    .trim();
  if (!s) return '';
  if (/^[0-9]/.test(s)) s = `字段${s}`;
  return s.slice(0, 20);
}

function fallbackName(el: ElementData, existing: readonly string[]): string {
  const base = TYPE_LABELS[el.type] || '变量';
  let i = 1;
  while (existing.includes(`${base}${i}`)) i++;
  return `${base}${i}`;
}

function decideName(el: ElementData, content: string, existing: readonly string[]): string {
  const layer = String(el.name ?? '').trim();
  if (layer && isValidVariableName(layer)) return layer.slice(0, 20);
  // 图片地址是「值」不是字段名，别拿 data:image/... 当变量名
  if (el.type !== 'image') {
    const fromContent = nameFromContent(content);
    if (fromContent && isValidVariableName(fromContent)) return fromContent;
  }
  return fallbackName(el, existing);
}

function placeholderGuard(content: string): ElementVariableError | null {
  const only = PLACEHOLDER_ONLY.exec(content.trim());
  if (only) return { ok: false, reason: `已绑定变量「${only[1].trim()}」，无需重复生成` };
  if (/\{\{[^}]+\}\}/.test(content)) {
    return { ok: false, reason: '内容里已有 {{占位符}}，请直接编辑原内容，避免覆盖静态文字' };
  }
  return null;
}

/** 规划一次「元素 → 变量」绑定；apply 由 store 在历史快照内执行 */
export function planElementVariable(
  el: ElementData,
  existingNames: readonly string[] = [],
): ElementVariableResult {
  if (!canBindElement(el)) return { ok: false, reason: `${unsupportedReason(el)}，不能设为变量` };

  const cell = el.type === 'table' ? pickTableCell(el) : undefined;
  const content = contentOf(el, cell);
  const guard = placeholderGuard(content);
  if (guard) return guard;

  const name = decideName(el, content, existingNames);
  const ph = `{{${name}}}`;
  const sample = content;

  switch (el.type) {
    case 'text':
      return { ok: true, name, sample, apply: (e) => { e.text = ph; } };

    case 'richtext':
      return {
        ok: true,
        name,
        sample,
        slot: '富文本首个片段',
        apply: (e) => {
          const runs = normalizeRuns(e.runs, e.text);
          const first = runs[0];
          e.text = ph;
          e.runs = first ? [{ ...first, text: ph }] : [{ text: ph }];
        },
      };

    case 'barcode':
      return {
        ok: true,
        name,
        sample,
        apply: (e) => { e.barcode = { ...(e.barcode ?? {}), content: ph }; },
      };

    case 'qrcode':
      return {
        ok: true,
        name,
        sample,
        apply: (e) => { e.qrcode = { ...(e.qrcode ?? {}), content: ph }; },
      };

    case 'image':
      return {
        ok: true,
        name,
        sample,
        slot: '图片地址',
        apply: (e) => { e.src = ph; },
      };

    case 'table': {
      const target = cell!;
      const idx = target.idx;
      return {
        ok: true,
        name,
        sample,
        slot: `表格 R${target.row + 1}C${target.col + 1}`,
        apply: (e) => {
          const cells = Array.isArray(e.cells) ? [...e.cells] : [];
          while (cells.length <= idx) cells.push('');
          cells[idx] = ph;
          e.cells = cells;
        },
      };
    }

    default:
      return { ok: false, reason: '该元素没有可绑定的内容' };
  }
}

/** 变量改名后同步元素里的 {{旧名}} 占位（含图层名） */
export function renamePlaceholdersInElement(el: ElementData, from: string, to: string): boolean {
  if (!from || !to || from === to) return false;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, 'g');
  let changed = false;

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (!value.includes('{{')) return value;
      const next = value.replace(re, `{{${to}}}`);
      if (next !== value) changed = true;
      return next;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        (value as Record<string, unknown>)[key] = walk((value as Record<string, unknown>)[key]);
      }
    }
    return value;
  };

  walk(el);
  if (el.name === from) {
    el.name = to;
    changed = true;
  }
  return changed;
}
