// =============================================================================
// designer/store.ts —— Zustand 状态管理
// 关键能力：元素 CRUD / 选区 / 缩放 / 撤销重做 / 页面设置 / 变量 / 层级
// =============================================================================

import { create } from 'zustand';
import type {
  AnyElement, DesignerTemplate, PageSettings, TemplateVariable, DesignerAction
} from './types';

const HISTORY_LIMIT = 50;

interface DesignerState {
  template: DesignerTemplate;
  selectedIds: string[];
  scale: number;
  history: DesignerAction[][];
  future: DesignerAction[][];

  // —— 基础 CRUD ——
  setTemplate: (t: DesignerTemplate) => void;
  addElement: (e: AnyElement) => void;
  addElements: (es: AnyElement[]) => void;
  updateElement: (id: string, patch: Partial<AnyElement>) => void;
  updateElements: (ids: string[], patch: Partial<AnyElement>) => void;
  removeElements: (ids: string[]) => void;
  duplicateSelected: () => void;

  // —— 选区 ——
  select: (ids: string[]) => void;
  addToSelection: (id: string) => void;

  // —— 缩放 ——
  setScale: (s: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
  zoomOne: () => void;

  // —— 层级 ——
  bringForward: (ids?: string[]) => void;
  sendBackward: (ids?: string[]) => void;
  bringToFront: (ids?: string[]) => void;
  sendToBack: (ids?: string[]) => void;

  // —— 页面 & 变量 ——
  setPage: (patch: Partial<PageSettings>) => void;
  addVariable: (v: TemplateVariable) => void;
  updateVariable: (name: string, patch: Partial<TemplateVariable>) => void;
  removeVariable: (name: string) => void;

  // —— 撤销重做 ——
  undo: () => void;
  redo: () => void;

  // —— 序列化 ——
  toJSON: () => DesignerTemplate;
  fromJSON: (t: DesignerTemplate) => void;
}

// ---------------------------- 纯函数 ----------------------------
function applyAction(elements: AnyElement[], a: DesignerAction): AnyElement[] {
  switch ((a as any).type) {
    case 'add': return [...elements, (a as any).element];
    case 'remove': return elements.filter((e) => e.id !== (a as any).id);
    case 'update': return elements.map((e) => (e.id === (a as any).id ? { ...e, ...(a as any).patch } : e));
    case 'reorder': return elements.map((e) => (e.id === (a as any).id ? { ...e, zIndex: (a as any).zIndex } : e));
    case 'batch': return (a as any).actions.reduce(applyAction, elements);
    default: return elements;
  }
}

function invertActionForUndo(elements: AnyElement[], a: DesignerAction): DesignerAction {
  if (a.type === 'add') return { type: 'remove', id: a.element.id };
  if (a.type === 'remove') {
    const e = elements.find((x) => x.id === a.id);
    return e ? { type: 'add', element: e } : { type: 'remove', id: a.id };
  }
  if (a.type === 'update') {
    const e = elements.find((x) => x.id === a.id);
    const prev: any = {};
    if (e) for (const k of Object.keys(a.patch)) prev[k] = (e as any)[k];
    return { type: 'update', id: a.id, patch: prev };
  }
  if (a.type === 'reorder') {
    const e = elements.find((x) => x.id === a.id);
    return { type: 'reorder', id: a.id, zIndex: e?.zIndex ?? 0 };
  }
  return a;
}

function commit(
  set: (fn: (s: DesignerState) => Partial<DesignerState>) => void,
  get: () => DesignerState,
  action: DesignerAction,
) {
  set((s) => {
    const next = applyAction(s.template.elements, action);
    const hist = [...s.history, [action]].slice(-HISTORY_LIMIT);
    return { template: { ...s.template, elements: next }, history: hist, future: [] };
  });
}

function commitMulti(
  set: (fn: (s: DesignerState) => Partial<DesignerState>) => void,
  get: () => DesignerState,
  actions: DesignerAction[],
) {
  set((s) => {
    const next = actions.reduce(applyAction, s.template.elements);
    const hist = [...s.history, [actions[0]]].slice(-HISTORY_LIMIT);
    return { template: { ...s.template, elements: next }, history: hist, future: [] };
  });
}

// ---------------------------- Store ----------------------------
export const useDesignerStore = create<DesignerState>((set, get) => ({
  template: emptyTemplate(),
  selectedIds: [],
  scale: 1,
  history: [],
  future: [],

  setTemplate: (t) => set({ template: t, history: [], future: [], selectedIds: [] }),

  addElement: (e) => commit(set, get, { type: 'add', element: e }),
  addElements: (es) => es.forEach((e) => commit(set, get, { type: 'add', element: e })),

  updateElement: (id, patch) => {
    // 连续更新不入历史；拖拽/调参多次调用，松手时单独 commit
    set((s) => ({
      template: { ...s.template, elements: applyAction(s.template.elements, { type: 'update', id, patch }) }
    }));
  },

  updateElements: (ids, patch) => {
    set((s) => ({
      template: {
        ...s.template,
        elements: s.template.elements.map((e) => (ids.includes(e.id) ? ({ ...e, ...patch } as AnyElement) : e)),
      }
    }));
  },

  removeElements: (ids) => {
    const actions = ids.map((id) => ({ type: 'remove' as const, id }));
    commitMulti(set, get, actions);
    set((s) => ({ selectedIds: s.selectedIds.filter((id) => !ids.includes(id)) }));
  },

  duplicateSelected: () => {
    const ids = get().selectedIds;
    if (ids.length === 0) return;
    const maxZ = Math.max(0, ...get().template.elements.map((e) => e.zIndex));
    const copies: AnyElement[] = ids
      .map((id) => get().template.elements.find((e) => e.id === id))
      .filter(Boolean)
      .map((e, i) => ({
        ...(e as AnyElement),
        id: `el_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${i}`,
        x: (e!.x + 2),
        y: (e!.y + 2),
        zIndex: maxZ + i + 1,
      }));
    copies.forEach((c) => commit(set, get, { type: 'add', element: c }));
    set({ selectedIds: copies.map((c) => c.id) });
  },

  select: (ids) => set({ selectedIds: ids }),
  addToSelection: (id) => {
    set((s) => ({ selectedIds: s.selectedIds.includes(id) ? s.selectedIds : [...s.selectedIds, id] }));
  },

  setScale: (s) => set({ scale: Math.min(8, Math.max(0.1, s)) }),
  zoomIn: () => set((s) => ({ scale: Math.min(8, +(s.scale * 1.25).toFixed(2)) })),
  zoomOut: () => set((s) => ({ scale: Math.max(0.1, +(s.scale / 1.25).toFixed(2)) })),
  zoomFit: () => {
    const { widthMm, heightMm } = get().template.page;
    const vw = 520, vh = 400;  // 画布容器估算
    const pxPerMm = 5;          // BASE_PX_PER_MM
    const scale = Math.min(vw / (widthMm * pxPerMm), vh / (heightMm * pxPerMm), 1.5);
    set({ scale: +scale.toFixed(2) });
  },
  zoomOne: () => set({ scale: 1 }),

  // —— 层级 ——
  bringForward: (ids) => {
    const list = ids ?? get().selectedIds;
    if (list.length === 0) return;
    const sorted = get().template.elements.slice().sort((a, b) => a.zIndex - b.zIndex);
    const maxZ = sorted[sorted.length - 1].zIndex;
    set((s) => ({
      template: {
        ...s.template,
        elements: s.template.elements.map((e) =>
          list.includes(e.id) ? { ...e, zIndex: Math.min(maxZ, e.zIndex + 1) } : e
        ),
      }
    }));
  },
  sendBackward: (ids) => {
    const list = ids ?? get().selectedIds;
    if (list.length === 0) return;
    set((s) => ({
      template: {
        ...s.template,
        elements: s.template.elements.map((e) =>
          list.includes(e.id) ? { ...e, zIndex: Math.max(0, e.zIndex - 1) } : e
        ),
      }
    }));
  },
  bringToFront: (ids) => {
    const list = ids ?? get().selectedIds;
    if (list.length === 0) return;
    const maxZ = Math.max(0, ...get().template.elements.map((e) => e.zIndex));
    let next = maxZ + 1;
    set((s) => ({
      template: {
        ...s.template,
        elements: s.template.elements.map((e) =>
          list.includes(e.id) ? { ...e, zIndex: next++ } : e
        ),
      }
    }));
  },
  sendToBack: (ids) => {
    const list = ids ?? get().selectedIds;
    if (list.length === 0) return;
    let next = 0;
    set((s) => ({
      template: {
        ...s.template,
        elements: s.template.elements.map((e) =>
          list.includes(e.id) ? { ...e, zIndex: next++ } : e
        ),
      }
    }));
  },

  // —— 页面 & 变量 ——
  setPage: (patch) => {
    set((s) => ({ template: { ...s.template, page: { ...s.template.page, ...patch } } }));
  },
  addVariable: (v) => {
    set((s) => ({ template: { ...s.template, variables: [...s.template.variables, v] } }));
  },
  updateVariable: (name, patch) => {
    set((s) => ({
      template: {
        ...s.template,
        variables: s.template.variables.map((v) => v.name === name ? { ...v, ...patch } : v),
      }
    }));
  },
  removeVariable: (name) => {
    set((s) => ({ template: { ...s.template, variables: s.template.variables.filter((v) => v.name !== name) } }));
  },

  // —— 撤销重做 ——
  undo: () => set((s) => {
    if (s.history.length === 0) return s;
    const actions = s.history[s.history.length - 1];
    // 反向应用每个 action 到 elements（page/var 暂不回滚）
    const inverted = actions.map((a) => invertActionForUndo(s.template.elements, a));
    const newElements = inverted.reduce(applyAction, s.template.elements);
    return {
      template: { ...s.template, elements: newElements },
      history: s.history.slice(0, -1),
      future: [...s.future, actions],
    };
  }),
  redo: () => set((s) => {
    if (s.future.length === 0) return s;
    const actions = s.future[s.future.length - 1];
    const newElements = actions.reduce(applyAction, s.template.elements);
    return {
      template: { ...s.template, elements: newElements },
      future: s.future.slice(0, -1),
      history: [...s.history, actions],
    };
  }),

  toJSON: () => get().template,
  fromJSON: (t) => set({ template: t, history: [], future: [], selectedIds: [] }),
}));

function emptyTemplate(): DesignerTemplate {
  return {
    schemaVersion: 1,
    page: { widthMm: 60, heightMm: 40, dpi: 203, orientation: 0, unit: 'mm' },
    variables: [
      { name: 'sku', type: 'text', label: 'SKU', defaultValue: '' },
      { name: 'productName', type: 'text', label: '产品名', defaultValue: '' },
      { name: 'price', type: 'number', label: '单价', defaultValue: 0 },
    ],
    elements: [],
  };
}

// 默认字体
export const DEFAULT_FONT = {
  family: 'Arial',
  size: 10,
  color: '#000',
  bold: false,
  italic: false,
  align: 'left' as const,
};

/** 生成唯一元素 ID */
let _seq = 1;
export function newElementId() {
  return `el_${Date.now()}_${_seq++}`;
}

/** 预设条码 symbology 列表 */
export const BARCODE_SYMS = [
  'CODE128', 'CODE128A', 'CODE128B', 'CODE128C',
  'CODE39', 'CODE93', 'EAN13', 'EAN8', 'UPCA', 'UPCE',
  'ITF14', 'CODABAR', 'GS1-128', 'MSI',
];
export const QRCODE_SYMS = ['QRCODE', 'MICROQRCODE', 'DATAMATRIX', 'PDF417', 'AZTEC'];
