// =============================================================================
// guides.js —— 标尺 / 参考线 / 智能吸附参考线
//   · 顶部/左侧标尺随缩放与滚动实时刷新
//   · 点击标尺创建参考线，拖拽移动，双击删除
//   · 拖动元素时自动吸附到参考线、页面中心与其它元素边缘/中线
// =============================================================================

import { store } from './store.js';
import { MM2PX, uid, r2 } from './util.js';

const PXMM = MM2PX;
const SNAP_THRESHOLD_MM = 0.8;

let ctx = null;
let rulerH = null;
let rulerV = null;
let raf = 0;
let guideDrag = null;

export function initGuides(context) {
  ctx = context;
  const { canvasArea } = ctx;

  rulerH = document.createElement('div');
  rulerH.className = 'ruler ruler-h';
  rulerH.title = '点击标尺添加水平参考线';
  rulerV = document.createElement('div');
  rulerV.className = 'ruler ruler-v';
  rulerV.title = '点击标尺添加垂直参考线';
  canvasArea.appendChild(rulerH);
  canvasArea.appendChild(rulerV);

  rulerH.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startRulerGuide(e, 'y');
  });
  rulerV.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startRulerGuide(e, 'x');
  });

  ctx.viewport.addEventListener('scroll', scheduleRulers, { passive: true });
  window.addEventListener('resize', scheduleRulers);

  ctx.overlay.addEventListener('pointerdown', onGuideDown);
  ctx.overlay.addEventListener('dblclick', onGuideDblClick);
  window.addEventListener('pointermove', onGuideMove);
  window.addEventListener('pointerup', onGuideUp);

  applyRulerVisibility();
  drawRulers();
}

// ---------------------------------------------------------------------------
// 标尺
// ---------------------------------------------------------------------------
function scheduleRulers() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; drawRulers(); });
}

/** 供外部在缩放/切换页签后强制刷新标尺 */
export function refreshRulers() {
  scheduleRulers();
}

function drawRulers() {
  if (!rulerH || !rulerV || !ctx) return;
  const geo = pageGeo();
  if (!geo) return;
  const z = store.state.zoom;
  const page = store.state.template.page;
  const unitPx = PXMM * z;

  // 根据缩放自适应刻度间隔，避免标签过密
  const major = z < 0.45 ? 20 : z < 0.8 ? 10 : 5;
  const minor = z < 0.45 ? 10 : z < 0.8 ? 5 : 1;

  const build = (horizontal) => {
    const lenMm = horizontal ? page.widthMm : page.heightMm;
    // 垂直标尺从 18px 处开始（避让左上角），故减去偏移
    const startPx = horizontal ? geo.left : geo.top - 18;
    const sizePx = horizontal ? geo.width : geo.height;
    const frag = document.createDocumentFragment();
    const max = Math.floor(lenMm);
    for (let mm = 0; mm <= max; mm += minor) {
      if (mm % major !== 0 && mm % 5 !== 0 && minor > 1) continue;
      const isMajor = mm % major === 0;
      const tick = document.createElement('i');
      tick.className = isMajor ? 'tick major' : 'tick';
      const p = startPx + mm * unitPx;
      if (horizontal) { tick.style.left = `${p}px`; tick.style.height = isMajor ? '9px' : '5px'; }
      else { tick.style.top = `${p}px`; tick.style.width = isMajor ? '9px' : '5px'; }
      frag.appendChild(tick);
      if (isMajor) {
        const label = document.createElement('span');
        label.className = 'ruler-num';
        label.textContent = String(mm);
        if (horizontal) label.style.left = `${p + 2}px`;
        else { label.style.top = `${p + 1}px`; label.style.transform = 'rotate(-90deg)'; label.style.transformOrigin = 'left top'; }
        frag.appendChild(label);
      }
    }
    // 页面边界标记
    const end = document.createElement('i');
    end.className = 'tick page-end';
    if (horizontal) { end.style.left = `${startPx + sizePx}px`; end.style.height = '11px'; }
    else { end.style.top = `${startPx + sizePx}px`; end.style.width = '11px'; }
    frag.appendChild(end);

    const host = horizontal ? rulerH : rulerV;
    host.innerHTML = '';
    host.appendChild(frag);
  };

  build(true);
  build(false);
}

/** 页面在画布可视区中的位置（px） */
function pageGeo() {
  if (!ctx?.page || !ctx?.canvasArea) return null;
  const pr = ctx.page.getBoundingClientRect();
  const ar = ctx.canvasArea.getBoundingClientRect();
  return {
    left: pr.left - ar.left,
    top: pr.top - ar.top,
    width: pr.width,
    height: pr.height,
  };
}

// ---------------------------------------------------------------------------
// 参考线
// ---------------------------------------------------------------------------
function guides() {
  const page = store.state.template.page;
  if (!Array.isArray(page.guides)) page.guides = [];
  return page.guides;
}

/** 从标尺按下开始拖出一根新参考线（松手落位） */
function startRulerGuide(e, axis) {
  const snap = store.snapshot();
  const g = { id: 'g_' + uid(), axis, pos: 0 };
  guides().push(g);
  store.suspend(true);
  drawGuides();
  const node = ctx.overlay.querySelector(`.guide[data-id="${g.id}"]`);
  if (!node) { store.suspend(false); return; }
  node.classList.add('dragging');
  guideDrag = { g, node, before: snap, moved: false };
  onGuideMove(e);
}

function removeGuide(id) {
  const page = store.state.template.page;
  const snap = store.snapshot();
  page.guides = guides().filter((g) => g.id !== id);
  store.commitSnapshot(snap);
  drawGuides();
  drawRulers();
}

function onGuideDown(e) {
  const node = e.target.closest?.('.guide');
  if (!node) return;
  e.preventDefault();
  e.stopPropagation();
  const g = guides().find((x) => x.id === node.dataset.id);
  if (!g) return;
  guideDrag = { g, node, before: store.snapshot(), moved: false };
  store.suspend(true);
  node.classList.add('dragging');
}

function onGuideMove(e) {
  if (!guideDrag) return;
  const geo = pageGeo();
  if (!geo) return;
  const ar = ctx.canvasArea.getBoundingClientRect();
  const z = store.state.zoom;
  const page = store.state.template.page;
  const raw = guideDrag.g.axis === 'x'
    ? (e.clientX - ar.left - geo.left) / (PXMM * z)
    : (e.clientY - ar.top - geo.top) / (PXMM * z);
  const max = guideDrag.g.axis === 'x' ? page.widthMm : page.heightMm;
  const pos = r2(Math.min(max, Math.max(0, raw)));
  if (Math.abs(pos - guideDrag.g.pos) > 0.01) guideDrag.moved = true;
  guideDrag.g.pos = pos;
  applyGuideBox(guideDrag.node, guideDrag.g);
  ctx.onChange?.();
}

function onGuideUp() {
  if (!guideDrag) return;
  const g = guideDrag;
  guideDrag = null;
  g.node.classList.remove('dragging');
  store.suspend(false);
  if (g.moved) store.commitSnapshot(g.before);
  else store.emit();
  drawRulers();
}

function onGuideDblClick(e) {
  const node = e.target.closest?.('.guide');
  if (!node) return;
  e.preventDefault();
  removeGuide(node.dataset.id);
}

export function drawGuides() {
  const ov = ctx?.overlay;
  if (!ov) return;
  ov.querySelectorAll('.guide').forEach((n) => n.remove());
  if (guideDrag) return; // 拖拽中由 applyGuideBox 实时更新
  const page = store.state.template.page;
  for (const g of guides()) {
    const n = document.createElement('div');
    n.className = `guide guide-${g.axis}`;
    n.dataset.id = g.id;
    n.title = `${g.pos} mm（双击删除）`;
    applyGuideBox(n, g, page);
    ov.appendChild(n);
  }
}

function applyGuideBox(node, g, page = store.state.template.page) {
  const z = store.state.zoom;
  const px = g.pos * PXMM * z;
  if (g.axis === 'x') {
    node.style.left = `${px}px`;
    node.style.top = '0';
    node.style.height = `${page.heightMm * PXMM * z}px`;
  } else {
    node.style.top = `${px}px`;
    node.style.left = '0';
    node.style.width = `${page.widthMm * PXMM * z}px`;
  }
  node.title = `${g.pos} mm（双击删除）`;
}

/** 参考线位置（mm） */
export function guidePositions(axis) {
  return guides().filter((g) => g.axis === axis).map((g) => g.pos);
}

// ---------------------------------------------------------------------------
// 智能吸附
// ---------------------------------------------------------------------------
/**
 * 计算框选/拖动时的吸附位移。
 * @param {{x,y,w,h}} box 当前屏幕 mm 包围盒
 * @param {string[]} excludeIds 不需要参考的元素
 * @returns {{dx,dy,vLines,hLines}}
 */
export function snapPosition(box, excludeIds = []) {
  const page = store.state.template.page;
  const threshold = SNAP_THRESHOLD_MM;
  const vCandidates = [0, page.widthMm / 2, page.widthMm, ...guidePositions('x')];
  const hCandidates = [0, page.heightMm / 2, page.heightMm, ...guidePositions('y')];

  for (const el of store.state.template.elements) {
    if (excludeIds.includes(el.id) || el.visible === false) continue;
    const b = el.type === 'line'
      ? { x: Math.min(el.x, el.x2 ?? el.x), y: Math.min(el.y, el.y2 ?? el.y),
          w: Math.abs((el.x2 ?? el.x) - el.x), h: Math.abs((el.y2 ?? el.y) - el.y) }
      : { x: el.x, y: el.y, w: el.w, h: el.h };
    vCandidates.push(b.x, b.x + b.w / 2, b.x + b.w);
    hCandidates.push(b.y, b.y + b.h / 2, b.y + b.h);
  }

  let bestX = null;
  let bestY = null;
  const edgesX = [box.x, box.x + box.w / 2, box.x + box.w];
  const edgesY = [box.y, box.y + box.h / 2, box.y + box.h];

  for (const c of vCandidates) {
    for (const e of edgesX) {
      const d = c - e;
      if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, line: c };
    }
  }
  for (const c of hCandidates) {
    for (const e of edgesY) {
      const d = c - e;
      if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, line: c };
    }
  }

  return {
    dx: bestX ? r2(bestX.d) : 0,
    dy: bestY ? r2(bestY.d) : 0,
    vLines: bestX ? [bestX.line] : [],
    hLines: bestY ? [bestY.line] : [],
  };
}

export function drawSnapLines(vLines = [], hLines = []) {
  const ov = ctx?.overlay;
  if (!ov) return;
  ov.querySelectorAll('.snap-line').forEach((n) => n.remove());
  const z = store.state.zoom;
  const page = store.state.template.page;
  for (const x of vLines) {
    const n = document.createElement('div');
    n.className = 'snap-line snap-v';
    n.style.left = `${x * PXMM * z}px`;
    n.style.height = `${page.heightMm * PXMM * z}px`;
    ov.appendChild(n);
  }
  for (const y of hLines) {
    const n = document.createElement('div');
    n.className = 'snap-line snap-h';
    n.style.top = `${y * PXMM * z}px`;
    n.style.width = `${page.widthMm * PXMM * z}px`;
    ov.appendChild(n);
  }
}

export function clearSnapLines() {
  ctx?.overlay?.querySelectorAll('.snap-line').forEach((n) => n.remove());
}

/** 复制参考线到新模板（局部坐标直接复用） */
export function clearGuides() {
  const page = store.state.template.page;
  if (!page.guides?.length) return;
  const snap = store.snapshot();
  page.guides = [];
  store.commitSnapshot(snap);
  drawGuides();
}

/** 参考线列表（只读快照，供检查器展示） */
export function guideList() {
  return guides().map((g) => ({ id: g.id, axis: g.axis, pos: g.pos }));
}

/** 在指定 mm 位置新增参考线（检查器/工具栏调用） */
export function addGuide(axis, posMm) {
  const page = store.state.template.page;
  const max = axis === 'x' ? page.widthMm : page.heightMm;
  const snap = store.snapshot();
  guides().push({
    id: 'g_' + uid(),
    axis,
    pos: r2(Math.min(max, Math.max(0, Number(posMm) || 0))),
  });
  store.commitSnapshot(snap);
  drawGuides();
  drawRulers();
}

/** 删除单根参考线 */
export function removeGuideById(id) {
  removeGuide(id);
}

// ---------------------------------------------------------------------------
// 标尺显示开关（持久化到 localStorage）
// ---------------------------------------------------------------------------
const RULER_PREF_KEY = 'labelflow.rulers';

/** 是否显示标尺（默认显示） */
export function rulersVisible() {
  try { return localStorage.getItem(RULER_PREF_KEY) !== '0'; } catch { return true; }
}

/** 显示/隐藏标尺 */
export function setRulersVisible(visible) {
  try { localStorage.setItem(RULER_PREF_KEY, visible ? '1' : '0'); } catch { /* 忽略隐私模式异常 */ }
  applyRulerVisibility();
  scheduleRulers();
}

function applyRulerVisibility() {
  ctx?.canvasArea?.classList.toggle('rulers-hidden', !rulersVisible());
}
