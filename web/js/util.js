// =============================================================================
// util.js —— 通用工具（无依赖）
// =============================================================================

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const r2 = (v) => Math.round(v * 100) / 100;

/** mm → 屏幕 CSS px（96dpi 基准） */
export const MM2PX = 96 / 25.4;

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let _seq = 0;
export function uid(prefix = 'el') {
  return `${prefix}_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
}

export function deepClone(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

export function debounce(fn, ms = 200) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** 极简 toast */
let toastEl = null;
let toastTimer = 0;
export function toast(msg, type = 'info') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.dataset.type = type;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

export function downloadFile(name, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** 角度转弧度 */
export const rad = (deg) => (deg * Math.PI) / 180;

/** 本地旋转：屏幕向量 → 元素局部向量 */
export function screenToLocal(vx, vy, rotationDeg) {
  const a = rad(rotationDeg);
  const c = Math.cos(a), s = Math.sin(a);
  return { x: vx * c + vy * s, y: -vx * s + vy * c };
}

/** 元素局部向量 → 屏幕向量 */
export function localToScreen(lx, ly, rotationDeg) {
  const a = rad(rotationDeg);
  const c = Math.cos(a), s = Math.sin(a);
  return { x: lx * c - ly * s, y: lx * s + ly * c };
}
