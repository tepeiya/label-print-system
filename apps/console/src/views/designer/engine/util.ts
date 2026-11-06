// =============================================================================
// 设计器类型与纯工具（Vue 化第一步：把 web/js/util.js 里与 DOM 无关的部分搬进来）
//   · 坐标与尺寸对外一律 mm，渲染时按 96dpi 基准换算成 CSS px
//   · 这里只放纯函数，任何文件都不许 import Vue / Element Plus，方便单测
// =============================================================================

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
export const r2 = (v: number) => Math.round(v * 100) / 100;

/** mm → 屏幕 CSS px（96dpi 基准） */
export const MM2PX = 96 / 25.4;

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let _seq = 0;
export function uid(prefix = 'el'): string {
  return `${prefix}_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
}

export function deepClone<T>(v: T): T {
  // TemplateData / ElementData 按定义就是纯 JSON，所以这里用 JSON 往返而不是 structuredClone：
  // Console 侧的数据都在 Pinia 的 reactive Proxy 里，structuredClone 遇到 Proxy 会抛 DataCloneError。
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 角度转弧度 */
export const rad = (deg: number) => (deg * Math.PI) / 180;

/** 屏幕向量 → 元素局部向量（抵消旋转） */
export function screenToLocal(vx: number, vy: number, rotationDeg: number) {
  const a = rad(rotationDeg);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: vx * c + vy * s, y: -vx * s + vy * c };
}

/** 元素局部向量 → 屏幕向量 */
export function localToScreen(lx: number, ly: number, rotationDeg: number) {
  const a = rad(rotationDeg);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: lx * c - ly * s, y: lx * s + ly * c };
}

export function downloadFile(name: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
