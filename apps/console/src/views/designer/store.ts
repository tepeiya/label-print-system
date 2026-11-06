// =============================================================================
// store.ts —— 设计器状态（web/js/store.js 的 Pinia 版）
//   语义保持不变：所有变更走 store 方法，快照式撤销/重做，历史上限 80 条。
//   Vue 化后不再需要 suspend/emit（响应式自己会重绘），但「手势开始前留一份快照、
//   手势结束才入栈」的提交口径原样保留，否则拖动一次会产生几十条 undo。
// =============================================================================

import { defineStore } from 'pinia';
import { clamp, deepClone, r2, uid } from './engine/util';
import { defaultTemplate, demoTemplate } from './model';
import { unionBBox, type Box } from './engine/geometry';
import type {
  ElementData, Guide, PageSpec, TemplateData, VariableSpec,
} from './types';

const HISTORY_LIMIT = 80;
export const AUTOSAVE_KEY = 'labelflow.autosave.v1';
export const RULER_PREF_KEY = 'labelflow.rulers';

function readAutosave(): TemplateData | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as TemplateData;
    return t?.page && Array.isArray(t.elements) ? t : null;
  } catch {
    return null;
  }
}

function rulersVisibleDefault(): boolean {
  try { return localStorage.getItem(RULER_PREF_KEY) !== '0'; } catch { return true; }
}

function normalizePage(page: Partial<PageSpec> | undefined): PageSpec {
  return { ...defaultTemplate().page, ...(page ?? {}) } as PageSpec;
}

export const useDesignerStore = defineStore('designer', {
  state: () => ({
    template: readAutosave() ?? demoTemplate(),
    selectedIds: [] as string[],
    zoom: 1,
    clipboard: [] as ElementData[],
    serialStart: 1,
    /** 0 = 未保存 */
    dirty: false,
    /** 当前打开的服务器模板（null 表示草稿，保存时走新建） */
    templateId: null as number | null,
    /** 服务器上的当前版本号，保存 / 回滚后由调用方回填 */
    templateVersion: null as number | null,
    templateName: '未命名标签',
    templateCategory: '默认',
    rulersVisible: rulersVisibleDefault(),
    /** 拖动时命中的吸附线（mm），只影响覆盖层显示 */
    snapLines: { v: [] as number[], h: [] as number[] },
    /** 框选矩形（mm） */
    marquee: null as Box | null,
    /** 就地文本编辑中的元素 id */
    editingId: null as string | null,
    past: [] as TemplateData[],
    future: [] as TemplateData[],
  }),

  getters: {
    page: (s): PageSpec => s.template.page,
    elements: (s): ElementData[] => s.template.elements,
    variables: (s): VariableSpec[] => s.template.variables ?? [],
    hasSelection: (s) => s.selectedIds.length > 0,
    canUndo: (s) => s.past.length > 0,
    canRedo: (s) => s.future.length > 0,
    selectedElements(s): ElementData[] {
      return s.template.elements.filter((e) => s.selectedIds.includes(e.id));
    },
    /** 按 zIndex 升序，画布与打印共用 */
    sortedElements(s): ElementData[] {
      return [...s.template.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
    },
    /** 图层面板用：zIndex 倒序 */
    layerElements(s): ElementData[] {
      return [...s.template.elements].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0));
    },
    /** 选中外框：多选时取并集（getter 之间互相引用要用 this，s 只是 state） */
    selectionBox(): Box | null {
      return unionBBox(this.selectedElements);
    },
    elementById: (s) => (id: string) => s.template.elements.find((e) => e.id === id),
  },

  actions: {
    // ----------------------------- 快照 / 历史 -----------------------------
    snapshot(): TemplateData {
      return deepClone(this.template);
    },

    pushHistory() {
      this.past.push(deepClone(this.template));
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future.length = 0;
      this.markDirty();
    },

    /** 手势 / 表单编辑结束时提交：把手势开始前的快照压入历史 */
    commitSnapshot(before: TemplateData) {
      this.past.push(before);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future.length = 0;
      this.markDirty();
    },

    markDirty() {
      this.dirty = true;
    },

    markSaved() {
      this.dirty = false;
    },

    undo() {
      if (!this.past.length) return false;
      this.future.push(deepClone(this.template));
      this.template = this.past.pop() as TemplateData;
      this.pruneSelection();
      this.markDirty();
      return true;
    },

    redo() {
      if (!this.future.length) return false;
      this.past.push(deepClone(this.template));
      this.template = this.future.pop() as TemplateData;
      this.pruneSelection();
      this.markDirty();
      return true;
    },

    pruneSelection() {
      this.selectedIds = this.selectedIds.filter((id) =>
        this.template.elements.some((e) => e.id === id));
    },

    /** 事务：pushHistory + 执行 */
    tx(fn: (t: TemplateData) => void) {
      this.pushHistory();
      fn(this.template);
    },

    // ----------------------------- 元素 -----------------------------
    addElement(el: ElementData, { select = true } = {}) {
      // 原生版走 store.tx：新增本身是一步历史，Ctrl+Z 能直接撤掉刚加的元素
      this.tx((t) => { t.elements.push(el); });
      if (select) this.select([el.id]);
    },

    updateElement(id: string, patch: Partial<ElementData>, { history = false } = {}) {
      const el = this.template.elements.find((e) => e.id === id);
      if (!el) return;
      if (history) this.pushHistory();
      else this.markDirty();
      Object.assign(el, patch);
    },

    updateSelected(patch: Partial<ElementData>, { history = true } = {}) {
      if (history) this.pushHistory();
      else this.markDirty();
      for (const el of this.selectedElements) Object.assign(el, patch);
    },

    removeElements(ids?: string[]) {
      const list = ids ?? this.selectedIds;
      if (!list.length) return;
      this.tx((t) => {
        t.elements = t.elements.filter((e) => !list.includes(e.id));
      });
      this.selectedIds = this.selectedIds.filter((id) => !list.includes(id));
    },

    duplicateSelected() {
      const sel = this.selectedElements;
      if (!sel.length) return;
      const maxZ = this.maxZ();
      const copies = sel.map((e, i) => ({
        ...deepClone(e),
        id: uid(),
        x: r2(e.x + 2),
        y: r2(e.y + 2),
        zIndex: maxZ + i + 1,
      }));
      this.tx((t) => { t.elements.push(...copies); });
      this.selectedIds = copies.map((c) => c.id);
    },

    copySelection() {
      this.clipboard = deepClone(this.selectedElements);
    },

    pasteClipboard() {
      const clip = this.clipboard;
      if (!clip?.length) return;
      const maxZ = this.maxZ();
      const copies = clip.map((e, i) => ({
        ...deepClone(e), id: uid(), x: r2(e.x + 3), y: r2(e.y + 3), zIndex: maxZ + i + 1,
      }));
      this.tx((t) => { t.elements.push(...copies); });
      this.select(copies.map((c) => c.id));
    },

    cutSelection() {
      this.copySelection();
      this.removeElements();
    },

    maxZ(): number {
      return this.template.elements.reduce((m, e) => Math.max(m, e.zIndex ?? 0), 0);
    },

    /** 选中单元素时自动扩展到整个组合 */
    expandGroups(ids: string[]): string[] {
      const out = new Set<string>();
      for (const id of ids) {
        const el = this.template.elements.find((e) => e.id === id);
        if (el?.groupId) {
          this.template.elements.forEach((e) => { if (e.groupId === el.groupId) out.add(e.id); });
        } else {
          out.add(id);
        }
      }
      return [...out];
    },

    select(ids: string[]) {
      this.selectedIds = this.expandGroups(ids);
    },

    toggleSelect(id: string) {
      const group = this.expandGroups([id]);
      if (group.every((gid) => this.selectedIds.includes(gid))) {
        this.selectedIds = this.selectedIds.filter((x) => !group.includes(x));
      } else {
        this.selectedIds = [...new Set([...this.selectedIds, ...group])];
      }
    },

    clearSelection() {
      this.selectedIds = [];
    },

    selectAll() {
      this.selectedIds = this.template.elements.map((e) => e.id);
    },

    groupSelected() {
      const sel = this.selectedElements;
      if (sel.length < 2) return;
      const gid = 'g_' + uid('grp');
      this.tx(() => { for (const e of sel) e.groupId = gid; });
    },

    ungroupSelected() {
      const sel = this.selectedElements;
      if (!sel.length) return;
      this.tx(() => { for (const e of sel) delete e.groupId; });
    },

    // ----------------------------- 层级 -----------------------------
    bringForward() {
      const sel = this.selectedElements;
      if (!sel.length) return;
      this.tx(() => {
        for (const e of sel) e.zIndex = (e.zIndex ?? 0) + 1.5;
        this.normalizeZ();
      });
    },

    sendBackward() {
      const sel = this.selectedElements;
      if (!sel.length) return;
      this.tx(() => {
        for (const e of sel) e.zIndex = (e.zIndex ?? 0) - 1.5;
        this.normalizeZ();
      });
    },

    bringToFront() {
      const sel = this.selectedElements;
      if (!sel.length) return;
      let z = this.maxZ() + 1;
      this.tx(() => { for (const e of sel) e.zIndex = z++; });
    },

    sendToBack() {
      const sel = this.selectedElements;
      if (!sel.length) return;
      this.tx(() => {
        const min = Math.min(...this.template.elements.map((e) => e.zIndex ?? 0));
        let z = min - sel.length;
        for (const e of sel) e.zIndex = z++;
        this.normalizeZ();
      });
    },

    normalizeZ() {
      const sorted = [...this.template.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
      sorted.forEach((e, i) => { e.zIndex = i + 1; });
    },

    clearCanvas() {
      this.tx((t) => { t.elements = []; });
      this.selectedIds = [];
    },

    // ----------------------------- 对齐 / 分布 / 等尺寸 -----------------------------
    alignSelected(mode: 'left' | 'hcenter' | 'top' | 'vcenter') {
      const sel = this.selectedElements;
      if (sel.length < 2) return;
      this.tx(() => {
        const minX = Math.min(...sel.map((e) => e.x));
        const maxR = Math.max(...sel.map((e) => e.x + e.w));
        const minY = Math.min(...sel.map((e) => e.y));
        const maxB = Math.max(...sel.map((e) => e.y + e.h));
        for (const e of sel) {
          if (mode === 'left') e.x = minX;
          if (mode === 'hcenter') e.x = r2((minX + maxR) / 2 - e.w / 2);
          if (mode === 'top') e.y = minY;
          if (mode === 'vcenter') e.y = r2((minY + maxB) / 2 - e.h / 2);
        }
      });
    },

    distributeSelected(axis: 'h' | 'v') {
      const sel = this.selectedElements;
      if (sel.length < 3) return;
      this.tx(() => {
        const sorted = [...sel].sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const total = axis === 'h' ? last.x - first.x : last.y - first.y;
        const step = total / (sorted.length - 1);
        sorted.forEach((e, i) => {
          if (axis === 'h') e.x = r2(first.x + step * i);
          else e.y = r2(first.y + step * i);
        });
      });
    },

    matchSizeSelected(axis: 'w' | 'h') {
      const sel = this.selectedElements;
      if (sel.length < 2) return;
      this.tx(() => {
        const ref = sel[0];
        for (const e of sel.slice(1)) {
          if (axis === 'w') e.w = ref.w;
          else e.h = ref.h;
        }
      });
    },

    // ----------------------------- 页面 / 变量 / 参考线 -----------------------------
    setPage(patch: Partial<PageSpec>) {
      this.tx((t) => { t.page = { ...t.page, ...patch }; });
      this.clampElementsToPage();
    },

    /** 直接改页面属性但不入历史（连续输入时用 commitSnapshot 收口） */
    setPageSilent(patch: Partial<PageSpec>) {
      this.template.page = { ...this.template.page, ...patch };
      this.markDirty();
    },

    clampElementsToPage() {
      const { widthMm, heightMm } = this.template.page;
      for (const e of this.template.elements) {
        e.w = Math.min(e.w, widthMm);
        e.h = Math.min(e.h, heightMm);
        e.x = clamp(e.x, 0, Math.max(0, widthMm - e.w));
        e.y = clamp(e.y, 0, Math.max(0, heightMm - e.h));
      }
    },

    addVariable(v: VariableSpec) {
      this.tx((t) => { (t.variables ?? []).push(v); });
    },

    updateVariable(name: string, patch: Partial<VariableSpec>) {
      this.tx((t) => {
        const v = (t.variables ?? []).find((x) => x.name === name);
        if (v) Object.assign(v, patch);
      });
    },

    removeVariable(name: string) {
      this.tx((t) => { t.variables = (t.variables ?? []).filter((v) => v.name !== name); });
    },

    guides(): Guide[] {
      if (!Array.isArray(this.template.page.guides)) this.template.page.guides = [];
      return this.template.page.guides;
    },

    addGuide(axis: 'x' | 'y', posMm: number) {
      const page = this.template.page;
      const max = axis === 'x' ? page.widthMm : page.heightMm;
      const before = this.snapshot();
      this.guides().push({
        id: 'g_' + uid('guide'),
        axis,
        pos: r2(clamp(Number(posMm) || 0, 0, max)),
      });
      this.commitSnapshot(before);
    },

    /**
     * 从标尺拖出新参考线：静默插入并返回 id。
     * 松手时由调用方 commitSnapshot(before)，这样「新增 + 定位」在历史里是一步。
     */
    addGuideSilent(axis: 'x' | 'y', posMm: number): string {
      const page = this.template.page;
      const max = axis === 'x' ? page.widthMm : page.heightMm;
      const id = 'g_' + uid('guide');
      this.guides().push({ id, axis, pos: r2(clamp(Number(posMm) || 0, 0, max)) });
      this.markDirty();
      return id;
    },

    removeGuide(id: string) {
      const before = this.snapshot();
      this.template.page.guides = this.guides().filter((g) => g.id !== id);
      this.commitSnapshot(before);
    },

    clearGuides() {
      if (!this.guides().length) return;
      const before = this.snapshot();
      this.template.page.guides = [];
      this.commitSnapshot(before);
    },

    /** 拖动参考线时用：不入历史，松手再 commitSnapshot */
    moveGuide(id: string, posMm: number) {
      const page = this.template.page;
      const max = (this.guides().find((g) => g.id === id)?.axis === 'x') ? page.widthMm : page.heightMm;
      const g = this.guides().find((x) => x.id === id);
      if (g) g.pos = r2(clamp(posMm, 0, max));
    },

    // ----------------------------- 缩放 / 吸附线 -----------------------------
    setZoom(z: number) {
      this.zoom = clamp(r2(z), 0.2, 4);
    },

    setSnapLines(vLines: number[], hLines: number[]) {
      this.snapLines = { v: vLines, h: hLines };
    },

    clearSnapLines() {
      this.snapLines = { v: [], h: [] };
    },

    setMarquee(box: Box | null) {
      this.marquee = box;
    },

    /** 就地编辑：写入文本/公式并留一条历史 */
    commitTextEdit(id: string, value: string, commit: boolean) {
      const el = this.template.elements.find((e) => e.id === id);
      this.editingId = null;
      if (!el) return;
      if (!commit) return;
      const before = this.snapshot();
      if (el.type === 'text') el.text = value;
      else if (el.formula) el.formula.expr = value;
      this.commitSnapshot(before);
    },

    startTextEdit(id: string) {
      this.editingId = id;
    },

    // ----------------------------- 模板装载 -----------------------------
    loadTemplate(
      tpl: TemplateData,
      meta: { id?: number | null; name?: string; category?: string; version?: number | null } = {},
    ) {
      const t = deepClone(tpl);
      t.page = normalizePage(t.page);
      t.variables = t.variables ?? [];
      t.elements = (t.elements ?? []).map((e, i) => ({ ...e, zIndex: e.zIndex ?? i + 1 }));
      this.template = t;
      this.selectedIds = [];
      this.past = [];
      this.future = [];
      this.templateId = meta.id ?? null;
      this.templateVersion = meta.version ?? null;
      if (meta.name) this.templateName = meta.name;
      if (meta.category) this.templateCategory = meta.category;
      this.dirty = false;
    },

    newTemplate() {
      this.template = defaultTemplate();
      this.selectedIds = [];
      this.past = [];
      this.future = [];
      this.templateId = null;
      this.templateVersion = null;
      this.templateName = '未命名标签';
      this.templateCategory = '默认';
      this.serialStart = 1;
      this.dirty = false;
    },

    setRulersVisible(v: boolean) {
      this.rulersVisible = v;
      try { localStorage.setItem(RULER_PREF_KEY, v ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
    },
  },
});
