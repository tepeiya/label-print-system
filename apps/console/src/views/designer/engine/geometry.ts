// =============================================================================
// geometry.ts —— 纯几何：包围盒、并集、智能吸附、mm/px 换算
//   全部不依赖 DOM，方便单测与后续复用到打印/服务端排版。
// =============================================================================

import type { ElementData, Guide, PageSpec } from '../types';
import { MM2PX } from './util';

export const SNAP_THRESHOLD_MM = 0.8;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 元素在页面坐标系（mm）上的包围盒：直线取两端点，90°/270° 旋转交换宽高 */
export function elementBBox(el: ElementData): Box {
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

export function unionBBox(els: ElementData[]): Box | null {
  if (!els.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const el of els) {
    const b = elementBBox(el);
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export interface SnapResult {
  dx: number;
  dy: number;
  vLines: number[];
  hLines: number[];
}

function r2(v: number) {
  return Math.round(v * 100) / 100;
}

/**
 * 拖动/缩放时的吸附位移。
 * @param box 当前（已含位移）包围盒 mm
 * @param elements 页面全部元素
 * @param page 页面设置（取尺寸与参考线）
 * @param excludeIds 参与拖动的元素，不作为吸附目标
 */
export function snapPosition(box: Box, elements: ElementData[], page: PageSpec, excludeIds: string[] = []): SnapResult {
  const guides: Guide[] = Array.isArray(page.guides) ? page.guides : [];
  const vCandidates = [0, page.widthMm / 2, page.widthMm, ...guides.filter((g) => g.axis === 'x').map((g) => g.pos)];
  const hCandidates = [0, page.heightMm / 2, page.heightMm, ...guides.filter((g) => g.axis === 'y').map((g) => g.pos)];

  for (const el of elements) {
    if (excludeIds.includes(el.id) || el.visible === false) continue;
    const b = elementBBox(el);
    vCandidates.push(b.x, b.x + b.w / 2, b.x + b.w);
    hCandidates.push(b.y, b.y + b.h / 2, b.y + b.h);
  }

  let bestX: { d: number; line: number } | null = null;
  let bestY: { d: number; line: number } | null = null;
  const edgesX = [box.x, box.x + box.w / 2, box.x + box.w];
  const edgesY = [box.y, box.y + box.h / 2, box.y + box.h];

  for (const c of vCandidates) {
    for (const e of edgesX) {
      const d = c - e;
      if (Math.abs(d) <= SNAP_THRESHOLD_MM && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, line: c };
    }
  }
  for (const c of hCandidates) {
    for (const e of edgesY) {
      const d = c - e;
      if (Math.abs(d) <= SNAP_THRESHOLD_MM && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, line: c };
    }
  }

  return {
    dx: bestX ? r2(bestX.d) : 0,
    dy: bestY ? r2(bestY.d) : 0,
    vLines: bestX ? [bestX.line] : [],
    hLines: bestY ? [bestY.line] : [],
  };
}

/** mm → 设计态 CSS px */
export const mmToPx = (mm: number, zoom: number) => mm * MM2PX * zoom;
