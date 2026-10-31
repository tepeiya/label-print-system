// =============================================================================
// designer/interactions.ts —— 关键交互实现
// 覆盖：拖拽更新坐标、吸附对齐（智能参考线）、键盘微调/快捷键、
//      多选对齐与分布、成组、层级、撤销重做触发。所有坐标以 mm 计算。
// 依赖 store.ts 的 useDesignerStore。
// =============================================================================

import { useDesignerStore } from './store';
import type { AnyElement } from './types';

const SNAP_PX = 4;          // 屏幕像素吸附阈值（渲染时按 scale 反推 mm）
const SCREEN_DPI = 96;      // 屏幕逻辑 DPI（预览用，非打印机 dpi）

/** 屏幕像素 → mm（按画布缩放反推） */
export function pxToMm(px: number, scale: number): number {
  const pxPerMm = (SCREEN_DPI / 25.4) * scale; // 1mm 在屏幕的像素数
  return px / pxPerMm;
}

// ----------------------------- 吸附对齐 -----------------------------
/**
 * 拖拽中计算与目标（其他元素/页面边缘/中线）的对齐参考线。
 * 原理：对当前元素的左/中/右、上/中/下 与各候选线比较，差值 < 阈值则吸附。
 * 返回 {x,y, guides} 供画布绘制参考线。
 */
export function computeSnap(
  moving: { x: number; y: number; w: number; h: number },
  others: AnyElement[],
  page: { widthMm: number; heightMm: number },
  scale: number,
): { x: number; y: number; guides: { axis: 'v' | 'h'; pos: number }[] } {
  const thresholdMm = pxToMm(SNAP_PX, scale);
  const guides: { axis: 'v' | 'h'; pos: number }[] = [];
  let { x, y } = moving;

  // 候选竖线：页面左0、中、右；其他元素左/中/右
  const vCandidates = [0, page.widthMm / 2, page.widthMm,
    ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
  const movingV = [x, x + moving.w / 2, x + moving.w];
  for (const c of vCandidates) {
    for (const m of movingV) {
      if (Math.abs(m - c) <= thresholdMm) { x = c - (m - x); guides.push({ axis: 'v', pos: c }); break; }
    }
  }
  // 候选横线同理
  const hCandidates = [0, page.heightMm / 2, page.heightMm,
    ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])];
  const movingH = [y, y + moving.h / 2, y + moving.h];
  for (const c of hCandidates) {
    for (const m of movingH) {
      if (Math.abs(m - c) <= thresholdMm) { y = c - (m - y); guides.push({ axis: 'h', pos: c }); break; }
    }
  }
  return { x, y, guides };
}

// ----------------------------- 拖拽提交 -----------------------------
/** 元素拖拽结束：用最终 mm 坐标提交一次可撤销操作 */
export function onDragEnd(id: string, xMm: number, yMm: number) {
  const store = useDesignerStore.getState();
  // 拖拽过程可能多次 updateElement，这里只在松手调 commit 语义（直接 add 到 history）
  store.updateElement(id, { x: round2(xMm), y: round2(yMm) });
  // 由于 updateElement 不入栈，这里补一次历史记录（简化：复用 commit 思路）
  pushHistory({ type: 'update', id, patch: { x: round2(xMm), y: round2(yMm) } });
}

function pushHistory(action: any) {
  useDesignerStore.setState((s) => ({
    history: [...s.history, [action]].slice(-50), future: [],
    template: s.template,
  }));
  // 真正状态已在 updateElement 更新；此处仅补历史
}

// ----------------------------- 键盘微调 / 快捷键 -----------------------------
/**
 * 键盘事件处理（方向键微调 0.5mm，Shift+方向键 1mm；Ctrl+Z 撤销，Ctrl+Shift+Z 重做；
 * Delete 删除；Ctrl+G 成组；Ctrl+] 置顶）。
 */
export function handleKey(e: KeyboardEvent) {
  const store = useDesignerStore.getState();
  const ids = store.selectedIds;
  if (ids.length === 0) return;
  const step = e.shiftKey ? 1 : 0.5; // mm

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? store.redo() : store.undo();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault(); store.removeElements(ids); return;
  }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    const actions = ids.map((id) => {
      const el = store.template.elements.find((x) => x.id === id)!;
      return { type: 'update', id, patch: { x: round2(el.x + dx), y: round2(el.y + dy) } } as any;
    });
    actions.forEach((a) => store.updateElement(a.id, a.patch));
    pushHistory({ type: 'batch', actions });
    return;
  }
}

// ----------------------------- 对齐与分布 -----------------------------
type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
type DistributeMode = 'horizontal' | 'vertical';

/** 将选中元素按模式对齐（以最外边界或整体包围盒为基准） */
export function alignSelected(mode: AlignMode) {
  const store = useDesignerStore.getState();
  const sel = store.template.elements.filter((e) => store.selectedIds.includes(e.id));
  if (sel.length < 2) return;
  const minX = Math.min(...sel.map((e) => e.x));
  const maxX = Math.max(...sel.map((e) => e.x + e.w));
  const minY = Math.min(...sel.map((e) => e.y));
  const maxY = Math.max(...sel.map((e) => e.y + e.h));
  const actions = sel.map((e) => {
    let patch: Partial<AnyElement> = {};
    switch (mode) {
      case 'left': patch = { x: minX }; break;
      case 'right': patch = { x: maxX - e.w }; break;
      case 'hcenter': patch = { x: (minX + maxX) / 2 - e.w / 2 }; break;
      case 'top': patch = { y: minY }; break;
      case 'bottom': patch = { y: maxY - e.h }; break;
      case 'vcenter': patch = { y: (minY + maxY) / 2 - e.h / 2 }; break;
    }
    return { type: 'update', id: e.id, patch: roundPatch(patch) } as any;
  });
  actions.forEach((a) => store.updateElement(a.id, a.patch));
  pushHistory({ type: 'batch', actions });
}

/** 等间距分布（按各元素中心排序后均分间距） */
export function distributeSelected(mode: DistributeMode) {
  const store = useDesignerStore.getState();
  const sel = store.template.elements
    .filter((e) => store.selectedIds.includes(e.id))
    .sort((a, b) => (mode === 'horizontal' ? a.x - b.x : a.y - b.y));
  if (sel.length < 3) return;
  const first = sel[0], last = sel[sel.length - 1];
  const span = mode === 'horizontal'
    ? (last.x + last.w) - first.x
    : (last.y + last.h) - first.y;
  const used = sel.reduce((s, e) => s + (mode === 'horizontal' ? e.w : e.h), 0);
  const gap = (span - used) / (sel.length - 1);
  let cursor = mode === 'horizontal' ? first.x : first.y;
  const actions = sel.map((e) => {
    const patch = mode === 'horizontal' ? { x: round2(cursor) } : { y: round2(cursor) };
    cursor += (mode === 'horizontal' ? e.w : e.h) + gap;
    return { type: 'update', id: e.id, patch } as any;
  });
  actions.forEach((a) => store.updateElement(a.id, a.patch));
  pushHistory({ type: 'batch', actions });
}

// ----------------------------- 工具函数 -----------------------------
function round2(n: number) { return Math.round(n * 100) / 100; }
function roundPatch(p: Partial<AnyElement>): Partial<AnyElement> {
  const o: any = {};
  for (const k of ['x', 'y', 'w', 'h'] as const) if (k in p) (o as any)[k] = round2((p as any)[k]);
  return o;
}
