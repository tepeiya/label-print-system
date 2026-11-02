// =============================================================================
// interactions.js —— 画布交互（全部基于原生 DOM Pointer Events）
//   选中 / 多选 / 拖动 / 八向缩放 / 旋转 / 框选 / 平移 / 双击编辑文本
//   坐标一律换算到 mm 后写回 store，屏幕只做展示
// =============================================================================

import { store } from './store.js';
import { updateNodeBox } from './render.js';
import { setInspectorTab, getInspectorTab } from './inspector.js';
import { MM2PX, clamp, r2, screenToLocal } from './util.js';
import { drawGuides, snapPosition, drawSnapLines, clearSnapLines } from './guides.js';

const PXMM = MM2PX;
const SNAP_MM = 0.5;
const MIN_MM = 1;

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

let ctx = null;          // { viewport, page, overlay, onChange }
let gesture = null;      // 当前手势
let spaceDown = false;

export function initInteractions(context) {
  ctx = context;
  const { viewport, page } = ctx;

  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onHover);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  viewport.addEventListener('dblclick', onDblClick);
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTyping(e.target)) {
      spaceDown = true;
      viewport.classList.add('panning');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      viewport.classList.remove('panning');
    }
  });

  // Enter 也可进入文本就地编辑（双击之外的键盘入口）
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || isTyping(e.target) || isEditing() || spaceDown) return;
    const sel = store.selectedElements();
    if (sel.length === 1 && !sel[0].locked
      && ['text', 'formula'].includes(sel[0].type)) {
      e.preventDefault();
      startTextEdit(sel[0]);
    }
  });

  page.addEventListener('dragstart', (e) => e.preventDefault());
}

function isTyping(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

/** 在画布上选中元素后，属性面板自动切到「属性」页签 */
function ensurePropertiesTab() {
  if (getInspectorTab() !== 'properties') setInspectorTab('properties');
}

// ---------------------------------------------------------------------------
// 几何工具
// ---------------------------------------------------------------------------
const zoom = () => store.state.zoom;

/** 屏幕 px（相对 page 左上角）→ mm */
function pxToMm(px) {
  return px / (PXMM * zoom());
}

function pointerPagePx(e) {
  const rect = ctx.page.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function pointerMm(e) {
  const p = pointerPagePx(e);
  return { x: pxToMm(p.x), y: pxToMm(p.y) };
}

/** 元素旋转后的屏幕 bbox（mm，相对页面左上角） */
export function elementBBox(el) {
  if (el.type === 'line') {
    const x1 = Math.min(el.x, el.x2 ?? el.x);
    const y1 = Math.min(el.y, el.y2 ?? el.y);
    const x2 = Math.max(el.x, el.x2 ?? el.x);
    const y2 = Math.max(el.y, el.y2 ?? el.y);
    return { x: x1, y: y1, w: Math.max(0.3, x2 - x1), h: Math.max(0.3, y2 - y1) };
  }
  if (el.rotation === 90 || el.rotation === 270) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    return { x: cx - el.h / 2, y: cy - el.w / 2, w: el.h, h: el.w };
  }
  return { x: el.x, y: el.y, w: el.w, h: el.h };
}

function unionBBox(els) {
  if (!els.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const el of els) {
    const b = elementBBox(el);
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ---------------------------------------------------------------------------
// 指针按下
// ---------------------------------------------------------------------------
function onPointerDown(e) {
  if (e.button === 1) {
    // 中键 → 平移
    startPan(e);
    return;
  }
  if (e.button !== 0) return;

  const handleEl = e.target.closest?.('[data-handle]');
  if (handleEl) {
    e.preventDefault();
    e.stopPropagation();
    const handle = handleEl.dataset.handle;
    if (handle === 'rotate') startRotate(e);
    else startResize(e, handle);
    return;
  }

  const elNode = e.target.closest?.('.el');
  const onPage = e.target.closest?.('.page');

  if (elNode && onPage) {
    const id = elNode.dataset.id;
    const el = store.elementById(id);
    if (!el) return;

    // 编辑态：交给 textarea
    if (e.target.tagName === 'TEXTAREA') return;

    ensurePropertiesTab();
    if (e.shiftKey) {
      store.toggleSelect(id);
    } else if (!store.state.selectedIds.includes(id)) {
      store.select([id]);
    }
    if (!store.state.selectedIds.includes(id)) return; // shift 取消选中后不拖
    startDrag(e);
    return;
  }

  if (onPage) {
    if (!e.shiftKey) store.clearSelection();
    startMarquee(e);
    return;
  }

  // 页面外 → 平移
  if (spaceDown || true) startPan(e);
}

// ---------------------------------------------------------------------------
// 拖动
// ---------------------------------------------------------------------------
function startDrag(e) {
  const start = pointerMm(e);
  const before = store.snapshot();
  const items = store.selectedElements()
    .filter((el) => !el.locked)
    .map((el) => ({ el, x: el.x, y: el.y }));
  if (!items.length) return;

  gesture = { type: 'drag', start, items, before, moved: false };
  store.suspend(true);
  e.preventDefault();
}

function updateDrag(e) {
  const p = pointerMm(e);
  let dx = p.x - gesture.start.x;
  let dy = p.y - gesture.start.y;
  if (Math.abs(dx) + Math.abs(dy) > 0.2) gesture.moved = true;

  const page = store.state.template.page;
  let snappedX = false;
  let snappedY = false;

  // 智能吸附：参考线 / 页面中心 / 其它元素边缘与中线
  if (!e.altKey && gesture.items.length) {
    let bbox = null;
    for (const it of gesture.items) {
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
      const s = snapPosition(bbox, gesture.items.map((it) => it.el.id));
      if (s.dx) { dx += s.dx; snappedX = true; }
      if (s.dy) { dy += s.dy; snappedY = true; }
      drawSnapLines(s.vLines, s.hLines);
    }
  } else {
    clearSnapLines();
  }

  const snap = e.altKey ? 0 : SNAP_MM;
  for (const it of gesture.items) {
    let nx = it.x + dx;
    let ny = it.y + dy;
    if (snap && !snappedX) nx = Math.round(nx / snap) * snap;
    if (snap && !snappedY) ny = Math.round(ny / snap) * snap;
    it.el.x = r2(clamp(nx, 0, Math.max(0, page.widthMm - it.el.w)));
    it.el.y = r2(clamp(ny, 0, Math.max(0, page.heightMm - it.el.h)));
    const node = ctx.page.querySelector(`.el[data-id="${it.el.id}"]`);
    if (node) updateNodeBox(node, it.el, zoom());
  }
  drawOverlay();
  ctx.onChange?.();
}

// ---------------------------------------------------------------------------
// 缩放（八向手柄，支持任意 90° 倍数旋转）
// ---------------------------------------------------------------------------
function startResize(e, handle) {
  const el = store.selectedElements()[0];
  if (!el || store.state.selectedIds.length !== 1) return;
  const b = elementBBox(el);
  const center = { x: el.x + el.w / 2, y: el.y + el.h / 2 };

  // 锚点：手柄的对角/对边中点（屏幕 mm 坐标）
  const signX = handle.includes('e') ? -1 : handle.includes('w') ? 1 : 0;
  const signY = handle.includes('s') ? -1 : handle.includes('n') ? 1 : 0;
  const anchorLocal = {
    x: signX === 1 ? el.w / 2 : signX === -1 ? -el.w / 2 : 0,
    y: signY === 1 ? el.h / 2 : signY === -1 ? -el.h / 2 : 0,
  };
  // 局部 → 屏幕（绕中心旋转）
  const rot = el.rotation ?? 0;
  const a = (rot * Math.PI) / 180;
  const anchor = {
    x: center.x + anchorLocal.x * Math.cos(a) - anchorLocal.y * Math.sin(a),
    y: center.y + anchorLocal.x * Math.sin(a) + anchorLocal.y * Math.cos(a),
  };

  gesture = {
    type: 'resize', handle, el, anchor, anchorLocal, center,
    w0: el.w, h0: el.h, before: store.snapshot(), moved: false,
    affectsX: handle.includes('e') || handle.includes('w') || handle.length === 2,
    affectsY: handle.includes('n') || handle.includes('s') || handle.length === 2,
  };
  store.suspend(true);
  e.preventDefault();
  ctx.page.style.cursor = '';
  void b;
}

function updateResize(e) {
  const g = gesture;
  const p = pointerMm(e);
  const rot = g.el.rotation ?? 0;

  // 相对锚点的屏幕向量 → 元素局部坐标
  const v = { x: p.x - g.anchor.x, y: p.y - g.anchor.y };
  const loc = screenToLocal(v.x, v.y, rot);

  const pages = store.state.template.page;
  let nw = g.affectsX ? Math.max(MIN_MM, Math.abs(loc.x)) : g.w0;
  let nh = g.affectsY ? Math.max(MIN_MM, Math.abs(loc.y)) : g.h0;

  if (e.shiftKey) {
    const ratio = g.w0 / g.h0;
    if (g.affectsX && g.affectsY) {
      if (nw / nh > ratio) nh = nw / ratio;
      else nw = nh * ratio;
    } else if (g.affectsX) {
      nh = nw / ratio;
    } else {
      nw = nh * ratio;
    }
  }

  // 中心 = 锚点 + 局部半尺寸（屏幕）
  const halfLocal = {
    x: (g.affectsX ? Math.sign(loc.x || 1) * nw / 2 : g.anchorLocal.x),
    y: (g.affectsY ? Math.sign(loc.y || 1) * nh / 2 : g.anchorLocal.y),
  };

  // 锚点保持不动的前提下，尺寸不能超出页面边界（旋转 90° 倍数的元素暂不做此约束）
  const rot90 = ((rot % 360) + 360) % 360;
  if (rot90 === 0 || rot90 === 180) {
    if (g.handle.includes('e')) nw = Math.min(nw, pages.widthMm - g.anchor.x);
    if (g.handle.includes('w')) nw = Math.min(nw, g.anchor.x);
    if (g.handle.includes('s')) nh = Math.min(nh, pages.heightMm - g.anchor.y);
    if (g.handle.includes('n')) nh = Math.min(nh, g.anchor.y);
    nw = Math.max(MIN_MM, nw);
    nh = Math.max(MIN_MM, nh);
  }

  const snap = e.altKey ? 0 : 0.1;
  nw = snap ? Math.round(nw / snap) * snap : nw;
  nh = snap ? Math.round(nh / snap) * snap : nh;
  nw = r2(Math.min(nw, pages.widthMm));
  nh = r2(Math.min(nh, pages.heightMm));
  halfLocal.x = g.affectsX ? Math.sign(loc.x || 1) * nw / 2 : g.anchorLocal.x;
  halfLocal.y = g.affectsY ? Math.sign(loc.y || 1) * nh / 2 : g.anchorLocal.y;
  const aa = (rot * Math.PI) / 180;
  const centerScreen = {
    x: g.anchor.x + halfLocal.x * Math.cos(aa) - halfLocal.y * Math.sin(aa),
    y: g.anchor.y + halfLocal.x * Math.sin(aa) + halfLocal.y * Math.cos(aa),
  };

  const el = g.el;
  el.w = nw;
  el.h = nh;
  el.x = r2(clamp(centerScreen.x - nw / 2, 0, Math.max(0, pages.widthMm - nw)));
  el.y = r2(clamp(centerScreen.y - nh / 2, 0, Math.max(0, pages.heightMm - nh)));
  if (el.type === 'line') {
    // 直线保持端点相对关系
    el.x2 = r2(el.x + (el.x2 - el.x) * (nw / (g.w0 || nw)));
    el.y2 = r2(el.y + (el.y2 - el.y) * (nh / (g.h0 || nh)));
  }

  g.moved = true;
  const node = ctx.page.querySelector(`.el[data-id="${el.id}"]`);
  if (node) updateNodeBox(node, el, zoom());
  drawOverlay();
  ctx.onChange?.();
}

// ---------------------------------------------------------------------------
// 旋转（吸附到 90° 倍数）
// ---------------------------------------------------------------------------
function startRotate(e) {
  const el = store.selectedElements()[0];
  if (!el) return;
  gesture = { type: 'rotate', el, before: store.snapshot(), moved: false, rot0: el.rotation ?? 0 };
  store.suspend(true);
  e.preventDefault();
}

function updateRotate(e) {
  const el = gesture.el;
  const center = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  const p = pointerMm(e);
  const angle = (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI + 90;
  const snapped = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  el.rotation = snapped;
  gesture.moved = snapped !== gesture.rot0;
  const node = ctx.page.querySelector(`.el[data-id="${el.id}"]`);
  if (node) updateNodeBox(node, el, zoom());
  drawOverlay();
  ctx.onChange?.();
}

// ---------------------------------------------------------------------------
// 框选
// ---------------------------------------------------------------------------
function startMarquee(e) {
  const start = pointerMm(e);
  gesture = { type: 'marquee', start, moved: false, additive: e.shiftKey, base: store.state.selectedIds.slice() };
  store.suspend(true);
  e.preventDefault();
}

function updateMarquee(e) {
  const p = pointerMm(e);
  const x1 = Math.min(gesture.start.x, p.x);
  const y1 = Math.min(gesture.start.y, p.y);
  const x2 = Math.max(gesture.start.x, p.x);
  const y2 = Math.max(gesture.start.y, p.y);
  gesture.rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  gesture.moved = gesture.rect.w > 0.5 && gesture.rect.h > 0.5;

  const hit = store.state.template.elements
    .filter((el) => {
      const b = elementBBox(el);
      return !(b.x > x2 || b.x + b.w < x1 || b.y > y2 || b.y + b.h < y1);
    })
    .map((el) => el.id);

  const ids = gesture.additive ? Array.from(new Set([...gesture.base, ...hit])) : hit;
  store.state.selectedIds = ids;   // 直接改，不触发重绘（由 drawOverlay 负责）
  drawOverlay();
  ctx.onChange?.();
}

// ---------------------------------------------------------------------------
// 平移
// ---------------------------------------------------------------------------
function startPan(e) {
  const vp = ctx.viewport;
  gesture = {
    type: 'pan',
    startX: e.clientX, startY: e.clientY,
    left: vp.scrollLeft, top: vp.scrollTop,
    moved: false,
  };
  vp.classList.add('grabbing');
  e.preventDefault();
}

function updatePan(e) {
  const vp = ctx.viewport;
  vp.scrollLeft = gesture.left - (e.clientX - gesture.startX);
  vp.scrollTop = gesture.top - (e.clientY - gesture.startY);
  gesture.moved = true;
}

// ---------------------------------------------------------------------------
// 指针移动 / 抬起
// ---------------------------------------------------------------------------
function onPointerMove(e) {
  if (!gesture) return;
  switch (gesture.type) {
    case 'drag': updateDrag(e); break;
    case 'resize': updateResize(e); break;
    case 'rotate': updateRotate(e); break;
    case 'marquee': updateMarquee(e); break;
    case 'pan': updatePan(e); break;
  }
}

function onHover(e) {
  if (gesture) return;
  const p = pointerMm(e);
  ctx.onPointerMm?.({ x: r2(p.x), y: r2(p.y) });
  const handleEl = e.target.closest?.('[data-handle]');
  if (handleEl) {
    const h = handleEl.dataset.handle;
    ctx.viewport.style.cursor = h === 'rotate' ? 'crosshair' : `${h}-resize`;
  } else if (e.target.closest?.('.el')) {
    ctx.viewport.style.cursor = 'move';
  } else {
    ctx.viewport.style.cursor = '';
  }
}

function onPointerUp() {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  ctx.viewport.classList.remove('grabbing');
  store.suspend(false);
  clearSnapLines();

  if (g.type === 'pan') { ctx.onChange?.(); return; }

  const changed = g.moved;
  if (changed) store.commitSnapshot(g.before);
  else {
    if (g.type === 'marquee') {
      store.emit();
      if (store.state.selectedIds.length) ensurePropertiesTab();
    } else store.flush();
  }
  ctx.onChange?.();
}

// ---------------------------------------------------------------------------
// 滚轮缩放
// ---------------------------------------------------------------------------
function onWheel(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const dir = e.deltaY > 0 ? -1 : 1;
  const next = clamp(zoom() + dir * 0.1, 0.2, 4);
  ctx.onZoom?.(next, e);
}

// ---------------------------------------------------------------------------
// 双击：编辑文本
// ---------------------------------------------------------------------------
function onDblClick(e) {
  const elNode = e.target.closest?.('.el');
  if (!elNode) return;
  const el = store.elementById(elNode.dataset.id);
  if (!el || el.locked) return;
  if (!['text', 'formula'].includes(el.type)) return;
  startTextEdit(el);
}

export function startTextEdit(el) {
  const node = ctx.page.querySelector(`.el[data-id="${el.id}"]`);
  if (!node) return;
  const z = zoom();
  const f = el.font || {};
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = el.type === 'text' ? (el.text ?? '') : (el.formula?.expr ?? '');
  Object.assign(ta.style, {
    position: 'absolute',
    left: `${el.x * PXMM * z}px`,
    top: `${el.y * PXMM * z}px`,
    width: `${Math.max(el.w, 20) * PXMM * z}px`,
    height: `${el.h * PXMM * z}px`,
    fontFamily: f.family || 'Arial',
    fontSize: `${(f.size ?? 9) * (96 / 72) * z}px`,
    fontWeight: f.bold ? '700' : '400',
    color: f.color || '#000',
    lineHeight: '1.15',
    textAlign: f.align || 'left',
  });
  node.style.visibility = 'hidden';
  ctx.overlay.appendChild(ta);
  ta.focus();
  ta.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const val = ta.value;
    if (ctx.overlay.contains(ta)) ta.remove();
    node.style.visibility = '';
    if (commit) {
      const before = store.snapshot();
      if (el.type === 'text') el.text = val;
      else el.formula.expr = val;
      store.commitSnapshot(before);
    } else {
      store.emit();
    }
  };

  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Enter' && !ev.shiftKey && el.type === 'formula') { ev.preventDefault(); finish(true); }
    ev.stopPropagation();
  });
  ta.addEventListener('blur', () => finish(true));
}

// ---------------------------------------------------------------------------
// 选区覆盖层（选中框 + 八个手柄 + 旋转手柄 + 框选矩形）
// ---------------------------------------------------------------------------
export function drawOverlay() {
  const ov = ctx.overlay;
  if (!ov) return;
  const z = zoom();
  const keep = ov.querySelectorAll('.text-editor, .marquee');
  // 清掉旧的手柄/选中框，但保留正在编辑的 textarea
  ov.querySelectorAll('.sel-box, .handle, .rot-handle').forEach((n) => n.remove());

  const els = store.selectedElements();
  if (els.length) {
    const b = unionBBox(els);
    if (b) {
      const box = document.createElement('div');
      box.className = 'sel-box';
      Object.assign(box.style, {
        left: `${b.x * PXMM * z}px`, top: `${b.y * PXMM * z}px`,
        width: `${b.w * PXMM * z}px`, height: `${b.h * PXMM * z}px`,
      });
      if (els.length > 1) {
        box.classList.add('multi');
        els.forEach((el) => {
          const bb = elementBBox(el);
          const sub = document.createElement('div');
          sub.className = 'sel-sub';
          Object.assign(sub.style, {
            left: `${bb.x * PXMM * z}px`, top: `${bb.y * PXMM * z}px`,
            width: `${bb.w * PXMM * z}px`, height: `${bb.h * PXMM * z}px`,
          });
          ov.appendChild(sub);
        });
      }
      ov.appendChild(box);

      if (els.length === 1 && !els[0].locked) {
        for (const h of HANDLES) {
          const d = document.createElement('div');
          d.className = 'handle';
          d.dataset.handle = h;
          const px = b.x * PXMM * z;
          const py = b.y * PXMM * z;
          const pw = b.w * PXMM * z;
          const ph = b.h * PXMM * z;
          const cx = px + pw / 2;
          const cy = py + ph / 2;
          const pos = {
            nw: [px, py], n: [cx, py], ne: [px + pw, py],
            e: [px + pw, cy], se: [px + pw, py + ph], s: [cx, py + ph],
            sw: [px, py + ph], w: [px, cy],
          }[h];
          Object.assign(d.style, {
            left: `${pos[0]}px`, top: `${pos[1]}px`,
            cursor: `${h}-resize`,
          });
          ov.appendChild(d);
        }
        const rot = document.createElement('div');
        rot.className = 'rot-handle';
        rot.dataset.handle = 'rotate';
        Object.assign(rot.style, {
          left: `${b.x * PXMM * z + (b.w * PXMM * z) / 2}px`,
          top: `${b.y * PXMM * z - 22}px`,
        });
        ov.appendChild(rot);
      }
    }
  }

  // 框选矩形
  ov.querySelectorAll('.marquee').forEach((n) => n.remove());
  if (gesture?.type === 'marquee' && gesture.rect) {
    const r = gesture.rect;
    const m = document.createElement('div');
    m.className = 'marquee';
    Object.assign(m.style, {
      left: `${r.x * PXMM * z}px`, top: `${r.y * PXMM * z}px`,
      width: `${r.w * PXMM * z}px`, height: `${r.h * PXMM * z}px`,
    });
    ov.appendChild(m);
  }
  drawGuides();
  void keep;
}

export function isEditing() {
  return !!ctx?.overlay?.querySelector('.text-editor');
}
