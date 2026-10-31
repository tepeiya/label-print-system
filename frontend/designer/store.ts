// =============================================================================
// designer/store.ts —— 设计器状态管理（Zustand）
// 关键能力：
//   * 单一模板状态（elements / page / variables）
//   * 选区（多选/成组）、缩放、对齐参考线
//   * 撤销/重做：历史栈（上限 50），每次「提交型」操作入栈
//   * 设计器状态 ⇄ 模板 JSON 双向序列化
// =============================================================================

import { create } from 'zustand';
import type { AnyElement, DesignerTemplate, PageSettings, TemplateVariable, DesignerAction } from './types';

const HISTORY_LIMIT = 50;

interface DesignerState {
  template: DesignerTemplate;
  selectedIds: string[];          // 当前选区
  scale: number;                  // 画布缩放 0.25~8
  snap: boolean;                  // 是否吸附
  history: DesignerAction[][];    // 撤销栈（每项为一次操作）
  future: DesignerAction[][];     // 重做栈
  // —— actions ——
  setTemplate: (t: DesignerTemplate) => void;
  addElement: (e: AnyElement) => void;
  updateElement: (id: string, patch: Partial<AnyElement>) => void;
  removeElements: (ids: string[]) => void;
  select: (ids: string[]) => void;
  setScale: (s: number) => void;
  undo: () => void;
  redo: () => void;
  toJSON: () => DesignerTemplate;  // 序列化（供保存/导出）
  fromJSON: (t: DesignerTemplate) => void;
}

/** 应用一次操作到 elements（纯函数，便于撤销重做复用） */
function applyAction(elements: AnyElement[], a: DesignerAction): AnyElement[] {
  switch (a.type) {
    case 'add': return [...elements, a.element];
    case 'remove': return elements.filter((e) => e.id !== a.id);
    case 'update': return elements.map((e) => (e.id === a.id ? { ...e, ...a.patch } : e));
    case 'reorder': return elements.map((e) => (e.id === a.id ? { ...e, zIndex: a.zIndex } : e));
    case 'batch': return a.actions.reduce(applyAction, elements);
  }
}

/** 反向操作（用于 undo）—— 仅对常见操作做反转 */
function invertAction(elements: AnyElement[], a: DesignerAction): DesignerAction {
  switch (a.type) {
    case 'add': return { type: 'remove', id: a.element.id };
    case 'remove': {
      const e = elements.find((x) => x.id === a.id);
      return e ? { type: 'add', element: e } : { type: 'remove', id: a.id };
    }
    case 'update': {
      const e = elements.find((x) => x.id === a.id);
      const prev = e ? pickChanged(e, a.patch) : {};
      return { type: 'update', id: a.id, patch: prev };
    }
    case 'reorder': {
      const e = elements.find((x) => x.id === a.id);
      return { type: 'reorder', id: a.id, zIndex: e?.zIndex ?? 0 };
    }
    case 'batch': return { type: 'batch', actions: a.actions.map((x) => invertAction(elements, x)).reverse() };
  }
}
function pickChanged(orig: AnyElement, patch: Partial<AnyElement>): Partial<AnyElement> {
  const prev: any = {};
  for (const k of Object.keys(patch)) (prev as any)[k] = (orig as any)[k];
  return prev;
}

export const useDesignerStore = create<DesignerState>((set, get) => ({
  template: emptyTemplate(),
  selectedIds: [],
  scale: 1,
  snap: true,
  history: [],
  future: [],

  setTemplate: (t) => set({ template: t, history: [], future: [] }),

  addElement: (e) => commit(set, get, { type: 'add', element: e }),

  updateElement: (id, patch) => {
    // 拖拽/调参的连续更新不每次入栈（由调用方在「提交」时调用 commit）
    set((s) => ({ template: { ...s.template, elements: applyAction(s.template.elements, { type: 'update', id, patch }) } }));
  },

  removeElements: (ids) =>
    commit(set, get, { type: 'batch', actions: ids.map((id) => ({ type: 'remove', id } as DesignerAction)) }),

  select: (ids) => set({ selectedIds: ids }),
  setScale: (s) => set({ scale: Math.min(8, Math.max(0.25, s)) }),

  // 撤销：弹出 history 末项，逆操作应用，压入 future
  undo: () => set((s) => {
    if (s.history.length === 0) return s;
    const last = s.history[s.history.length - 1];
    const elements = applyAction(s.template.elements, invertAction(s.template.elements, last[0] ?? last as any));
    // 注：history 项为「一次操作数组」，这里简化为单操作
    const reversed = invertAction(s.template.elements, (last as any).length ? last[0] : last);
    const newElements = applyAction(s.template.elements, reversed);
    return {
      template: { ...s.template, elements: newElements },
      history: s.history.slice(0, -1),
      future: [...s.future, last],
    };
  }),

  redo: () => set((s) => {
    if (s.future.length === 0) return s;
    const last = s.future[s.future.length - 1];
    const newElements = applyAction(s.template.elements, (last as any).length ? last[0] : last);
    return { template: { ...s.template, elements: newElements }, history: [...s.history, last], future: s.future.slice(0, -1) };
  }),

  toJSON: () => get().template,
  fromJSON: (t) => set({ template: t, history: [], future: [] }),
}));

/**
 * 提交型操作：更新状态 + 入历史栈（限制 50 步）+ 清空重做栈。
 * 拖拽过程用 updateElement 暂存，松手时调用 commit 记录一次可撤销操作。
 */
function commit(
  set: (fn: (s: DesignerState) => Partial<DesignerState>) => void,
  get: () => DesignerState,
  action: DesignerAction,
) {
  set((s) => {
    const elements = applyAction(s.template.elements, action);
    const hist = [...s.history, [action] as DesignerAction[]].slice(-HISTORY_LIMIT);
    return { template: { ...s.template, elements }, history: hist, future: [] };
  });
}

function emptyTemplate(): DesignerTemplate {
  return {
    schemaVersion: 1,
    page: { widthMm: 60, heightMm: 40, dpi: 300, orientation: 0, unit: 'mm', columns: 1, rows: 1, marginMm: 1 },
    variables: [],
    elements: [],
  };
}

// —— Konva 画布从 store.elements 渲染（示意，真实项目在 React 组件订阅 store）——
export function elementToKonva(e: AnyElement, scale: number) {
  return {
    id: e.id,
    x: e.x * scale, y: e.y * scale,
    width: e.w * scale, height: e.h * scale,
    rotation: e.rotation,
    draggable: !e.locked,
    opacity: e.opacity ?? 1,
    listening: e.visible !== false,
  };
}
