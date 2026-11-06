// =============================================================================
// useGestures.ts —— 画布手势（web/js/interactions.js 的组合式版）
//   选中 / 多选 / 拖动 / 八向缩放 / 旋转 / 框选 / 平移 / 参考线拖拽 / 双击就地编辑
//   全部换算成 mm 写回 store；屏幕像素只在定位时参与。
//   与原生版一致的三处口径：手势期间只改状态不入历史、结束才 commitSnapshot；
//   0.5mm 位置栅格 + 0.1mm 尺寸栅格，按住 Alt 关闭吸附；旋转吸附到 90° 倍数。
// =============================================================================

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import { useDesignerStore } from './store';
import { clamp, r2, screenToLocal } from './engine/util';
import { elementBBox, mmToPx, snapPosition } from './engine/geometry';
import type { ElementData } from './types';

const SNAP_MM = 0.5;
const SIZE_SNAP_MM = 0.1;
const MIN_MM = 1;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

export type HandleName = typeof HANDLES[number];
export const HANDLE_NAMES: readonly HandleName[] = HANDLES;

type GestureType = 'drag' | 'resize' | 'rotate' | 'marquee' | 'pan' | 'guide';

interface GestureState {
  type: GestureType;
  before: ReturnType<typeof useDesignerStore>['template'];
  moved: boolean;
  start?: { x: number; y: number };
  items?: { el: ElementData; x: number; y: number }[];
  el?: ElementData;
  handle?: HandleName;
  anchor?: { x: number; y: number };
  anchorLocal?: { x: number; y: number };
  w0?: number;
  h0?: number;
  affectsX?: boolean;
  affectsY?: boolean;
  rot0?: number;
  guideId?: string;
  startX?: number;
  startY?: number;
  scrollLeft?: number;
  scrollTop?: number;
  additive?: boolean;
  base?: string[];
}

function isTyping(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

export interface GestureOptions {
  viewport: Ref<HTMLElement | null>;
  page: Ref<HTMLElement | null>;
}

export function useGestures(opts: GestureOptions) {
  const store = useDesignerStore();
  const cursorMm = ref<{ x: number; y: number } | null>(null);
  const cursorStyle = ref('');
  const panning = ref(false);
  let gesture: GestureState | null = null;
  let spaceDown = false;

  const vp = () => opts.viewport.value;
  const pg = () => opts.page.value;

  // --------------------------- 坐标换算 ---------------------------
  function pointerPagePx(e: PointerEvent | WheelEvent) {
    const rect = pg()!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function pointerMm(e: PointerEvent) {
    const p = pointerPagePx(e);
    const k = mmToPx(1, store.zoom);
    return { x: p.x / k, y: p.y / k };
  }

  // --------------------------- 按下 ---------------------------
  function onPointerDown(e: PointerEvent) {
    const viewport = vp();
    if (!viewport || !pg()) return;

    if (e.button === 1) { startPan(e); return; }
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;

    if (target.closest?.('[data-guide-id]')) {
      e.preventDefault();
      e.stopPropagation();
      startGuideDrag(e, target.closest('[data-guide-id]') as HTMLElement);
      return;
    }

    const handleEl = target.closest?.('[data-handle]') as HTMLElement | null;
    if (handleEl) {
      e.preventDefault();
      e.stopPropagation();
      const h = handleEl.dataset.handle;
      if (h === 'rotate') startRotate(e);
      else startResize(e, h as HandleName);
      return;
    }

    const elNode = target.closest?.('.lf-el') as HTMLElement | null;
    const onPage = !!target.closest?.('[data-page]');

    if (elNode && onPage) {
      const id = elNode.dataset.id!;
      const el = store.elementById(id);
      if (!el) return;
      if (target.tagName === 'TEXTAREA') return;
      if (e.shiftKey) store.toggleSelect(id);
      else if (!store.selectedIds.includes(id)) store.select([id]);
      if (!store.selectedIds.includes(id)) return; // shift 取消选中后不拖
      startDrag(e);
      return;
    }

    if (onPage) {
      if (!e.shiftKey) store.clearSelection();
      startMarquee(e);
      return;
    }

    // 页面外（或按住空格）→ 平移
    startPan(e);
  }

  // --------------------------- 拖动 ---------------------------
  function startDrag(e: PointerEvent) {
    const items = store.selectedElements
      .filter((el) => !el.locked)
      .map((el) => ({ el, x: el.x, y: el.y }));
    if (!items.length) return;
    gesture = { type: 'drag', start: pointerMm(e), items, before: store.snapshot(), moved: false };
    e.preventDefault();
  }

  function updateDrag(e: PointerEvent) {
    const g = gesture!;
    const p = pointerMm(e);
    let dx = p.x - g.start!.x;
    let dy = p.y - g.start!.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.2) g.moved = true;

    const page = store.page;
    let snappedX = false;
    let snappedY = false;

    if (!e.altKey && g.items!.length) {
      let bbox: { x: number; y: number; w: number; h: number } | null = null;
      for (const it of g.items!) {
        const b = elementBBox(it.el);
        const nb = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
        if (!bbox) bbox = nb;
        else {
          const x1 = Math.min(bbox.x, nb.x);
          const y1 = Math.min(bbox.y, nb.y);
          const x2 = Math.max(bbox.x + bbox.w, nb.x + nb.w);
          const y2 = Math.max(bbox.y + bbox.h, nb.y + nb.h);
          bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        }
      }
      if (bbox) {
        const s = snapPosition(bbox, store.elements, page, g.items!.map((it) => it.el.id));
        if (s.dx) { dx += s.dx; snappedX = true; }
        if (s.dy) { dy += s.dy; snappedY = true; }
        store.setSnapLines(s.vLines, s.hLines);
      }
    } else {
      store.clearSnapLines();
    }

    const snap = e.altKey ? 0 : SNAP_MM;
    for (const it of g.items!) {
      let nx = it.x + dx;
      let ny = it.y + dy;
      if (snap && !snappedX) nx = Math.round(nx / snap) * snap;
      if (snap && !snappedY) ny = Math.round(ny / snap) * snap;
      it.el.x = r2(clamp(nx, 0, Math.max(0, page.widthMm - it.el.w)));
      it.el.y = r2(clamp(ny, 0, Math.max(0, page.heightMm - it.el.h)));
    }
  }

  // --------------------------- 缩放 ---------------------------
  function startResize(e: PointerEvent, handle: HandleName) {
    const el = store.selectedElements[0];
    if (!el || store.selectedIds.length !== 1 || el.locked) return;
    const center = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
    const signX = handle.includes('e') ? -1 : handle.includes('w') ? 1 : 0;
    const signY = handle.includes('s') ? -1 : handle.includes('n') ? 1 : 0;
    const anchorLocal = {
      x: signX === 1 ? el.w / 2 : signX === -1 ? -el.w / 2 : 0,
      y: signY === 1 ? el.h / 2 : signY === -1 ? -el.h / 2 : 0,
    };
    const rot = el.rotation ?? 0;
    const a = (rot * Math.PI) / 180;
    const anchor = {
      x: center.x + anchorLocal.x * Math.cos(a) - anchorLocal.y * Math.sin(a),
      y: center.y + anchorLocal.x * Math.sin(a) + anchorLocal.y * Math.cos(a),
    };
    gesture = {
      type: 'resize', handle, el, anchor, anchorLocal,
      w0: el.w, h0: el.h, before: store.snapshot(), moved: false,
      affectsX: handle.includes('e') || handle.includes('w') || handle.length === 2,
      affectsY: handle.includes('n') || handle.includes('s') || handle.length === 2,
    };
    store.markDirty();
    e.preventDefault();
    cursorStyle.value = '';
  }

  function updateResize(e: PointerEvent) {
    const g = gesture!;
    const el = g.el!;
    const p = pointerMm(e);
    const rot = el.rotation ?? 0;
    const v = { x: p.x - g.anchor!.x, y: p.y - g.anchor!.y };
    const loc = screenToLocal(v.x, v.y, rot);
    const page = store.page;

    let nw = g.affectsX ? Math.max(MIN_MM, Math.abs(loc.x)) : g.w0!;
    let nh = g.affectsY ? Math.max(MIN_MM, Math.abs(loc.y)) : g.h0!;

    if (e.shiftKey) {
      const ratio = g.w0! / (g.h0 || MIN_MM);
      if (g.affectsX && g.affectsY) {
        if (nw / nh > ratio) nh = nw / ratio;
        else nw = nh * ratio;
      } else if (g.affectsX) {
        nh = nw / ratio;
      } else {
        nw = nh * ratio;
      }
    }

    const rot90 = ((rot % 360) + 360) % 360;
    if (rot90 === 0 || rot90 === 180) {
      if (g.handle!.includes('e')) nw = Math.min(nw, page.widthMm - g.anchor!.x);
      if (g.handle!.includes('w')) nw = Math.min(nw, g.anchor!.x);
      if (g.handle!.includes('s')) nh = Math.min(nh, page.heightMm - g.anchor!.y);
      if (g.handle!.includes('n')) nh = Math.min(nh, g.anchor!.y);
      nw = Math.max(MIN_MM, nw);
      nh = Math.max(MIN_MM, nh);
    }

    const snap = e.altKey ? 0 : SIZE_SNAP_MM;
    if (snap) {
      nw = Math.round(nw / snap) * snap;
      nh = Math.round(nh / snap) * snap;
    }
    nw = r2(Math.min(nw, page.widthMm));
    nh = r2(Math.min(nh, page.heightMm));

    const halfLocal = {
      x: g.affectsX ? Math.sign(loc.x || 1) * nw / 2 : g.anchorLocal!.x,
      y: g.affectsY ? Math.sign(loc.y || 1) * nh / 2 : g.anchorLocal!.y,
    };
    const aa = (rot * Math.PI) / 180;
    const centerScreen = {
      x: g.anchor!.x + halfLocal.x * Math.cos(aa) - halfLocal.y * Math.sin(aa),
      y: g.anchor!.y + halfLocal.x * Math.sin(aa) + halfLocal.y * Math.cos(aa),
    };

    el.w = nw;
    el.h = nh;
    el.x = r2(clamp(centerScreen.x - nw / 2, 0, Math.max(0, page.widthMm - nw)));
    el.y = r2(clamp(centerScreen.y - nh / 2, 0, Math.max(0, page.heightMm - nh)));
    if (el.type === 'line') {
      // 直线保持端点相对关系
      el.x2 = r2(el.x + ((el.x2 ?? el.x) - el.x) * (nw / (g.w0 || nw)));
      el.y2 = r2(el.y + ((el.y2 ?? el.y) - el.y) * (nh / (g.h0 || nh)));
    }
    g.moved = true;
  }

  // --------------------------- 旋转 ---------------------------
  function startRotate(e: PointerEvent) {
    const el = store.selectedElements[0];
    if (!el || el.locked) return;
    gesture = { type: 'rotate', el, before: store.snapshot(), moved: false, rot0: el.rotation ?? 0 };
    store.markDirty();
    e.preventDefault();
  }

  function updateRotate(e: PointerEvent) {
    const g = gesture!;
    const el = g.el!;
    const center = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
    const p = pointerMm(e);
    const angle = (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI + 90;
    const snapped = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
    el.rotation = snapped;
    g.moved = snapped !== g.rot0;
  }

  // --------------------------- 框选 ---------------------------
  function startMarquee(e: PointerEvent) {
    gesture = {
      type: 'marquee', start: pointerMm(e), moved: false, additive: e.shiftKey,
      base: store.selectedIds.slice(), before: store.snapshot(),
    };
    e.preventDefault();
  }

  function updateMarquee(e: PointerEvent) {
    const g = gesture!;
    const p = pointerMm(e);
    const x1 = Math.min(g.start!.x, p.x);
    const y1 = Math.min(g.start!.y, p.y);
    const x2 = Math.max(g.start!.x, p.x);
    const y2 = Math.max(g.start!.y, p.y);
    const rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    g.moved = rect.w > 0.5 && rect.h > 0.5;
    store.setMarquee(rect);

    const hit = store.elements.filter((el) => {
      const b = elementBBox(el);
      return !(b.x > x2 || b.x + b.w < x1 || b.y > y2 || b.y + b.h < y1);
    }).map((el) => el.id);

    store.selectedIds = g.additive ? Array.from(new Set([...g.base!, ...hit])) : hit;
  }

  // --------------------------- 参考线 ---------------------------
  function startGuideDrag(e: PointerEvent, node: HTMLElement) {
    const id = node.dataset.guideId!;
    const g = store.guides().find((x) => x.id === id);
    if (!g) return;
    gesture = { type: 'guide', guideId: id, before: store.snapshot(), moved: false };
    store.markDirty();
    e.preventDefault();
    updateGuideDrag(e);
  }

  function updateGuideDrag(e: PointerEvent) {
    const g = gesture!;
    const rect = pg()!.getBoundingClientRect();
    const guide = store.guides().find((x) => x.id === g.guideId);
    if (!guide) return;
    const k = mmToPx(1, store.zoom);
    const raw = guide.axis === 'x'
      ? (e.clientX - rect.left) / k
      : (e.clientY - rect.top) / k;
    const max = guide.axis === 'x' ? store.page.widthMm : store.page.heightMm;
    const pos = r2(clamp(raw, 0, max));
    if (Math.abs(pos - guide.pos) > 0.01) g.moved = true;
    store.moveGuide(guide.id, pos);
  }

  // --------------------------- 平移 ---------------------------
  function startPan(e: PointerEvent) {
    const viewport = vp();
    if (!viewport) return;
    gesture = {
      type: 'pan', before: store.snapshot(), moved: false,
      startX: e.clientX, startY: e.clientY,
      scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop,
    };
    panning.value = true;
    cursorStyle.value = 'grabbing';
    e.preventDefault();
  }

  function updatePan(e: PointerEvent) {
    const g = gesture!;
    const viewport = vp();
    if (!viewport) return;
    viewport.scrollLeft = g.scrollLeft! - (e.clientX - g.startX!);
    viewport.scrollTop = g.scrollTop! - (e.clientY - g.startY!);
    g.moved = true;
  }

  // --------------------------- 移动 / 抬起 ---------------------------
  function onPointerMove(e: PointerEvent) {
    if (!gesture) {
      if (pg()) {
        const p = pointerMm(e);
        cursorMm.value = { x: r2(p.x), y: r2(p.y) };
      }
      return;
    }
    switch (gesture.type) {
      case 'drag': updateDrag(e); break;
      case 'resize': updateResize(e); break;
      case 'rotate': updateRotate(e); break;
      case 'marquee': updateMarquee(e); break;
      case 'pan': updatePan(e); break;
      case 'guide': updateGuideDrag(e); break;
    }
  }

  function onPointerUp() {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    panning.value = false;
    cursorStyle.value = '';
    store.clearSnapLines();
    store.setMarquee(null);
    if (g.type === 'pan') return;
    if (g.moved) store.commitSnapshot(g.before);
  }

  function onHoverCursor(e: PointerEvent) {
    if (gesture) return;
    const target = e.target as HTMLElement;
    const handleEl = target.closest?.('[data-handle]') as HTMLElement | null;
    if (handleEl) {
      const h = handleEl.dataset.handle;
      cursorStyle.value = h === 'rotate' ? 'crosshair' : `${h}-resize`;
    } else if (target.closest?.('[data-guide-id]')) {
      cursorStyle.value = 'grab';
    } else if (target.closest?.('.lf-el')) {
      cursorStyle.value = 'move';
    } else {
      cursorStyle.value = spaceDown ? 'grab' : '';
    }
  }

  // --------------------------- 滚轮缩放 ---------------------------
  function onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const viewport = vp();
    const old = store.zoom;
    const dir = e.deltaY > 0 ? -1 : 1;
    const next = clamp(r2(old + dir * 0.1), 0.2, 4);
    if (Math.abs(next - old) < 0.001 || !viewport) return;
    store.setZoom(next);
    // 以鼠标为锚点保持视觉位置
    const rect = viewport.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    const ratio = store.zoom / old;
    viewport.scrollLeft = (viewport.scrollLeft + dx) * ratio - dx;
    viewport.scrollTop = (viewport.scrollTop + dy) * ratio - dy;
  }

  // --------------------------- 双击就地编辑 ---------------------------
  function onDblClick(e: MouseEvent) {
    const node = (e.target as HTMLElement).closest?.('.lf-el') as HTMLElement | null;
    if (!node) return;
    const el = store.elementById(node.dataset.id!);
    if (!el || el.locked) return;
    if (!['text', 'formula'].includes(el.type)) return;
    store.startTextEdit(el.id);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.code === 'Space' && !isTyping(e.target)) {
      spaceDown = true;
      cursorStyle.value = 'grab';
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space') {
      spaceDown = false;
      cursorStyle.value = '';
    }
  }

  function onDragStart(e: Event) {
    e.preventDefault();
  }

  onMounted(() => {
    const viewport = vp();
    const page = pg();
    if (!viewport || !page) throw new Error('useGestures 需要 viewport / page 两个模板 ref');
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onHoverCursor);
    viewport.addEventListener('dblclick', onDblClick);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('contextmenu', (e) => e.preventDefault());
    page.addEventListener('dragstart', onDragStart);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  });

  onBeforeUnmount(() => {
    const viewport = vp();
    const page = pg();
    viewport?.removeEventListener('pointerdown', onPointerDown);
    viewport?.removeEventListener('pointermove', onHoverCursor);
    viewport?.removeEventListener('dblclick', onDblClick);
    viewport?.removeEventListener('wheel', onWheel);
    page?.removeEventListener('dragstart', onDragStart);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  });

  /** 供「Enter 进入就地编辑」的快捷键调用（原生版同语义） */
  function startTextEditIfEditable() {
    const sel = store.selectedElements;
    if (sel.length === 1 && !sel[0].locked && ['text', 'formula'].includes(sel[0].type)) {
      store.startTextEdit(sel[0].id);
    }
  }

  function removeGuideById(id: string) {
    store.removeGuide(id);
  }

  return { cursorMm, cursorStyle, panning, startTextEditIfEditable, removeGuideById };
}
