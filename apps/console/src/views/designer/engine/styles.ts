// =============================================================================
// styles.ts —— 设计态样式换算（render.js 里那套 imperative style 的声明式版）
//   换算口径一条不改：pt 字号按 96/72 变 px、mm 线宽下限 0.5px、直线 0.6px，
//   否则同一模板在 Vue 画布上会和原生画布 / 打印预览对不齐。
// =============================================================================

import type { CSSProperties } from 'vue';
import type { ElementData, FontSpec, StrokeSpec } from '../types';
import { MM2PX } from './util';

const PXMM = MM2PX;

export function alignToJustify(a?: string): string {
  return a === 'center' ? 'center' : a === 'right' ? 'flex-end' : 'flex-start';
}

export function valignToAlign(v?: string): string {
  return v === 'middle' ? 'center' : v === 'bottom' ? 'flex-end' : 'flex-start';
}

/** 元素盒子（位置/尺寸/旋转/层级），原生版由 applyBox 写 style，这里返回同一组值 */
export function boxStyle(el: ElementData, zoom: number): CSSProperties {
  const st: CSSProperties = {
    left: `${el.x * PXMM * zoom}px`,
    top: `${el.y * PXMM * zoom}px`,
    width: `${el.w * PXMM * zoom}px`,
    height: `${el.h * PXMM * zoom}px`,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : '',
    zIndex: Math.round(el.zIndex ?? 1),
    position: 'absolute',
    boxSizing: 'border-box',
  };
  if (el.opacity !== undefined) st.opacity = String(el.opacity);
  return st;
}

/** 直线单独算盒子：按两端点取 min/abs，且允许溢出（原生版 overflow:visible） */
export function lineBoxStyle(el: ElementData, zoom: number): CSSProperties {
  const dx = (el.x2 ?? el.x) - el.x;
  const dy = (el.y2 ?? el.y) - el.y;
  const w = Math.max(Math.abs(dx), 0.3) * PXMM * zoom;
  const h = Math.max(Math.abs(dy), 0.3) * PXMM * zoom;
  return {
    left: `${Math.min(el.x, el.x2 ?? el.x) * PXMM * zoom}px`,
    top: `${Math.min(el.y, el.y2 ?? el.y) * PXMM * zoom}px`,
    width: `${w}px`,
    height: `${h}px`,
    zIndex: Math.round(el.zIndex ?? 1),
    position: 'absolute',
    boxSizing: 'border-box',
    overflow: 'visible',
    transform: el.rotation ? `rotate(${el.rotation}deg)` : '',
    opacity: el.opacity === undefined ? '' : String(el.opacity),
  };
}

export function fontCss(font: FontSpec | undefined, zoom: number): CSSProperties {
  const f = font || {};
  return {
    fontFamily: f.family || 'Arial',
    fontWeight: f.bold ? '700' : '400',
    fontStyle: f.italic ? 'italic' : 'normal',
    textDecoration: f.underline ? 'underline' : 'none',
    color: f.color || '#000',
    // pt → CSS px（96dpi 基准），再乘缩放
    fontSize: `${(f.size ?? 9) * (96 / 72) * zoom}px`,
    lineHeight: String(f.lineHeight ?? 1.15),
    letterSpacing: `${(f.letterSpacing ?? 0) * zoom}px`,
  };
}

export function strokeCss(stroke: StrokeSpec | undefined, zoom: number): string {
  const s = stroke;
  if (!s || !(s.width && s.width > 0)) return 'none';
  const w = Math.max(0.5, s.width * PXMM * zoom);
  const style = s.style === 'dashed' ? 'dashed' : s.style === 'dotted' ? 'dotted' : 'solid';
  return `${w}px ${style} ${s.color || '#333'}`;
}

export function rectStyle(el: ElementData, zoom: number): CSSProperties {
  return {
    background: el.fill ?? '#fff',
    borderRadius: `${(el.cornerRadius ?? 0) * PXMM * zoom}px`,
    border: strokeCss(el.stroke, zoom),
  };
}

export function ellipseStyle(el: ElementData, zoom: number): CSSProperties {
  return {
    background: el.fill ?? '#fff',
    borderRadius: '50%',
    border: strokeCss(el.stroke, zoom),
  };
}

export function textStyle(el: ElementData): CSSProperties {
  return {
    display: 'flex',
    alignItems: valignToAlign(el.font?.vAlign),
    justifyContent: alignToJustify(el.font?.align),
    overflow: 'hidden',
  };
}

export function textStyleInner(el: ElementData, zoom: number): CSSProperties {
  const f = fontCss(el.font, zoom);
  return {
    ...f,
    width: '100%',
    whiteSpace: el.font?.wrap === false ? 'nowrap' : 'pre-wrap',
    textAlign: (el.font?.align as CSSProperties['textAlign']) || 'left',
    overflow: 'hidden',
  };
}

export function tableStyle(el: ElementData, zoom: number): CSSProperties {
  const rows = Math.max(1, el.rows || 1);
  const cols = Math.max(1, el.cols || 1);
  const bw = Math.max(0.5, (el.borderWidth ?? 0.2) * PXMM * zoom);
  return {
    display: 'grid',
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gridTemplateRows: `repeat(${rows}, 1fr)`,
    border: el.showBorder === false ? 'none' : `${bw}px solid ${el.borderColor || '#333'}`,
    overflow: 'hidden',
    background: '#fff',
  };
}

export function tableCellStyle(el: ElementData, r: number, c: number, rows: number, cols: number, zoom: number): CSSProperties {
  const bw = Math.max(0.5, (el.borderWidth ?? 0.2) * PXMM * zoom);
  const bc = el.borderColor || '#333';
  const isHeader = !!el.headerRow && r === 0;
  const f = fontCss(el.font, zoom);
  const borders: CSSProperties = el.showBorder === false
    ? {}
    : {
        borderRight: c < cols - 1 ? `${bw}px solid ${bc}` : 'none',
        borderBottom: r < rows - 1 ? `${bw}px solid ${bc}` : 'none',
      };
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: alignToJustify(el.font?.align),
    padding: '0 2px',
    overflow: 'hidden',
    background: isHeader ? el.headerBg || '#f2f2f2' : 'transparent',
    fontFamily: f.fontFamily,
    fontSize: f.fontSize,
    fontWeight: isHeader ? '700' : f.fontWeight,
    color: f.color,
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    ...borders,
  };
}

export function barcodeStyle(el: ElementData): CSSProperties {
  return {
    display: 'flex',
    flexDirection: String(el.barcode?.textPosition || 'bottom').toLowerCase() === 'top' ? 'column-reverse' : 'column',
    overflow: 'hidden',
  };
}

export function qrcodeStyle(el: ElementData, zoom: number): CSSProperties {
  const quiet = Math.max(0, el.qrcode?.quietZoneMm ?? 1) * PXMM * zoom;
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: quiet > 0 ? `${quiet}px` : undefined,
    boxSizing: 'border-box',
    width: '100%',
    height: '100%',
  };
}
