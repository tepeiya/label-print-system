// =============================================================================
// store.js —— 应用状态（订阅 + 快照式撤销/重做）
// 设计原则：所有变更走 store 方法，自动通知订阅者；手势期间可临时挂起通知
// =============================================================================

import { deepClone, uid, r2, clamp } from './util.js';
import { defaultTemplate, demoTemplate } from './model.js';

const HISTORY_LIMIT = 80;

const state = {
  template: demoTemplate(),
  selectedIds: [],
  zoom: 1,
  activeTab: 'design',
  clipboard: [],
  serialStart: 1,
  /** 手势期间挂起重绘 */
  suspended: false,
  /** 打印/预览用数据行 */
  rows: [{}],
};

const listeners = new Set();
const past = [];
const future = [];

export const store = {
  state,

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  emit() {
    if (state.suspended) return;
    for (const fn of listeners) fn();
  },

  /** 强制通知（手势结束时用） */
  flush() {
    for (const fn of listeners) fn();
  },

  suspend(v) {
    state.suspended = v;
  },

  // ----------------------------- 快照 -----------------------------
  snapshot() {
    return deepClone(state.template);
  },

  pushHistory() {
    past.push(deepClone(state.template));
    if (past.length > HISTORY_LIMIT) past.shift();
    future.length = 0;
  },

  /** 手势结束时提交：把手势开始前的快照压入历史 */
  commitSnapshot(snap) {
    past.push(snap);
    if (past.length > HISTORY_LIMIT) past.shift();
    future.length = 0;
    store.emit();
  },

  canUndo: () => past.length > 0,
  canRedo: () => future.length > 0,

  undo() {
    if (!past.length) return false;
    future.push(deepClone(state.template));
    state.template = past.pop();
    state.selectedIds = state.selectedIds.filter((id) =>
      state.template.elements.some((e) => e.id === id));
    store.emit();
    return true;
  },

  redo() {
    if (!future.length) return false;
    past.push(deepClone(state.template));
    state.template = future.pop();
    state.selectedIds = state.selectedIds.filter((id) =>
      state.template.elements.some((e) => e.id === id));
    store.emit();
    return true;
  },

  /** 事务：pushHistory + 执行 + 通知 */
  tx(fn) {
    store.pushHistory();
    fn(state.template);
    store.emit();
  },

  // ----------------------------- 元素 -----------------------------
  get elements() {
    return state.template.elements;
  },

  elementById(id) {
    return state.template.elements.find((e) => e.id === id);
  },

  selectedElements() {
    return state.template.elements.filter((e) => state.selectedIds.includes(e.id));
  },

  addElement(el, { select: doSelect = true } = {}) {
    store.tx((t) => {
      t.elements.push(el);
    });
    if (doSelect) store.select([el.id]);
    else store.emit();
  },

  updateElement(id, patch, { history = false } = {}) {
    const el = store.elementById(id);
    if (!el) return;
    if (history) store.pushHistory();
    Object.assign(el, patch);
    store.emit();
  },

  updateSelected(patch, { history = true } = {}) {
    if (history) store.pushHistory();
    for (const el of store.selectedElements()) Object.assign(el, patch);
    store.emit();
  },

  removeElements(ids) {
    const list = ids ?? state.selectedIds;
    if (!list.length) return;
    store.tx((t) => {
      t.elements = t.elements.filter((e) => !list.includes(e.id));
    });
    state.selectedIds = state.selectedIds.filter((id) => !list.includes(id));
    store.emit();
  },

  duplicateSelected() {
    const sel = store.selectedElements();
    if (!sel.length) return;
    const maxZ = tMaxZ();
    const copies = sel.map((e, i) => ({
      ...deepClone(e),
      id: uid(),
      x: r2(e.x + 2),
      y: r2(e.y + 2),
      zIndex: maxZ + i + 1,
    }));
    store.tx((t) => {
      t.elements.push(...copies);
    });
    state.selectedIds = copies.map((c) => c.id);
    store.emit();
  },

  select(ids) {
    state.selectedIds = expandGroups(ids);
    store.emit();
  },

  toggleSelect(id) {
    const group = expandGroups([id]);
    if (group.every((gid) => state.selectedIds.includes(gid))) {
      state.selectedIds = state.selectedIds.filter((x) => !group.includes(x));
    } else {
      state.selectedIds = [...new Set([...state.selectedIds, ...group])];
    }
    store.emit();
  },

  /** 组合：给选中元素分配同一 groupId */
  groupSelected() {
    const sel = store.selectedElements();
    if (sel.length < 2) return;
    const gid = 'g_' + uid();
    store.tx(() => {
      for (const e of sel) e.groupId = gid;
    });
    store.emit();
  },

  /** 取消组合（支持选中多个组中的任意成员） */
  ungroupSelected() {
    const sel = store.selectedElements();
    if (!sel.length) return;
    store.tx(() => {
      for (const e of sel) delete e.groupId;
    });
    store.emit();
  },

  groupMembers(groupId) {
    return state.template.elements.filter((e) => e.groupId === groupId);
  },

  clearSelection() {
    if (!state.selectedIds.length) return;
    state.selectedIds = [];
    store.emit();
  },

  selectAll() {
    state.selectedIds = state.template.elements.map((e) => e.id);
    store.emit();
  },

  // ----------------------------- 层级 -----------------------------
  bringForward() {
    const sel = store.selectedElements();
    if (!sel.length) return;
    store.tx(() => {
      for (const e of sel) e.zIndex = (e.zIndex ?? 0) + 1.5;
      normalizeZ();
    });
  },

  sendBackward() {
    const sel = store.selectedElements();
    if (!sel.length) return;
    store.tx(() => {
      for (const e of sel) e.zIndex = (e.zIndex ?? 0) - 1.5;
      normalizeZ();
    });
  },

  bringToFront() {
    const sel = store.selectedElements();
    if (!sel.length) return;
    let z = tMaxZ() + 1;
    store.tx(() => {
      for (const e of sel) e.zIndex = z++;
    });
  },

  sendToBack() {
    const sel = store.selectedElements();
    if (!sel.length) return;
    store.tx(() => {
      const min = Math.min(...state.template.elements.map((e) => e.zIndex ?? 0));
      let z = min - sel.length;
      for (const e of sel) e.zIndex = z++;
      normalizeZ();
    });
  },

  // ----------------------------- 页面/变量 -----------------------------
  setPage(patch) {
    store.tx((t) => {
      t.page = { ...t.page, ...patch };
    });
    clampElementsToPage();
  },

  addVariable(v) {
    store.tx((t) => {
      t.variables.push(v);
    });
  },

  updateVariable(name, patch) {
    store.tx((t) => {
      const v = t.variables.find((x) => x.name === name);
      if (v) Object.assign(v, patch);
    });
  },

  removeVariable(name) {
    store.tx((t) => {
      t.variables = t.variables.filter((v) => v.name !== name);
    });
  },

  // ----------------------------- 缩放 -----------------------------
  setZoom(z) {
    state.zoom = clamp(r2(z), 0.2, 4);
    store.emit();
  },

  // ----------------------------- 模板整载 -----------------------------
  loadTemplate(tpl) {
    const t = deepClone(tpl);
    t.page = { ...defaultTemplate().page, ...t.page };
    t.variables = t.variables ?? [];
    t.elements = (t.elements ?? []).map((e, i) => ({ ...e, zIndex: e.zIndex ?? i + 1 }));
    state.template = t;
    state.selectedIds = [];
    past.length = 0;
    future.length = 0;
    store.emit();
  },

  newTemplate() {
    state.template = defaultTemplate();
    state.selectedIds = [];
    past.length = 0;
    future.length = 0;
    store.emit();
  },
};

function tMaxZ() {
  return state.template.elements.reduce((m, e) => Math.max(m, e.zIndex ?? 0), 0);
}

/** 选中单元素时自动扩展到整个组合 */
function expandGroups(ids) {
  const out = new Set();
  for (const id of ids) {
    const el = state.template.elements.find((e) => e.id === id);
    if (el?.groupId) {
      state.template.elements.forEach((e) => { if (e.groupId === el.groupId) out.add(e.id); });
    } else {
      out.add(id);
    }
  }
  return [...out];
}

function normalizeZ() {
  const sorted = [...state.template.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  sorted.forEach((e, i) => { e.zIndex = i + 1; });
}

function clampElementsToPage() {
  const { widthMm, heightMm } = state.template.page;
  for (const e of state.template.elements) {
    e.w = Math.min(e.w, widthMm);
    e.h = Math.min(e.h, heightMm);
    e.x = clamp(e.x, 0, Math.max(0, widthMm - e.w));
    e.y = clamp(e.y, 0, Math.max(0, heightMm - e.h));
  }
}
