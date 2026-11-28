// =============================================================================
// dot-fit.ts —— 「设计按毫米、打印机按点」的一致性检查（P0-3）
//
// 【解决什么】设计器里填 0.30mm 模块宽，203dpi 热敏/热转印机上一个点只有
//   25.4/203 = 0.1251mm。0.30mm 要 2.4 点，机器只能给 2 点 → 实打 0.25mm，
//   码整体缩水 16.7%，静区、条高、窄条都跟着缩。密度越接近物理下限，扫不出
//   的概率越高；而现场看到的现象是「按模板打的码扫不出」，查不到根因。
//   所以设计阶段就要把「设计 mm → 整点 → 实际 mm」摆出来，偏差超阈值就提示。
//
// 【口径】纯函数，不连库、不依赖框架；后端接口与打印任务共用，避免前后端两套算法。
// =============================================================================

/** 一个点对应多少毫米（dpi = 每英寸点数） */
export function dotMm(dpi: number): number {
  return 25.4 / (dpi > 0 ? dpi : 203);
}

export interface DotFit {
  /** 设计值（mm） */
  designedMm: number;
  /** 打印机能给的点数（四舍五入到整点，0 表示小到画不出来） */
  dots: number;
  /** 实际打出来的尺寸（mm） */
  actualMm: number;
  /** 实际 - 设计（mm，正=变粗，负=变细） */
  deltaMm: number;
  /** 相对偏差（-0.167 表示比设计细 16.7%） */
  deltaPct: number;
  /** 刚好落在整点上，无偏差 */
  exact: boolean;
}

export function dotFit(designedMm: number, dpi: number): DotFit {
  const step = dotMm(dpi);
  const mm = Number(designedMm) || 0;
  const raw = mm / step;
  const dots = Math.round(raw);
  const actualMm = dots * step;
  const deltaMm = actualMm - mm;
  const deltaPct = mm > 0 ? deltaMm / mm : 0;
  return {
    designedMm: mm,
    dots,
    actualMm: Math.round(actualMm * 1000) / 1000,
    deltaMm: Math.round(deltaMm * 1000) / 1000,
    deltaPct: Math.round(deltaPct * 10000) / 10000,
    // 0.25mm@203dpi 实为 2 点 = 0.25025mm，这种 0.1% 级差异不算偏差（浮点噪声也不该报）
    exact: Math.abs(deltaMm) < 0.002,
  };
}

/** 建议值：离设计值最近的「整点毫米」，按该 dpi 算出来不缩水 */
export function snapToDot(designedMm: number, dpi: number): number {
  const step = dotMm(dpi);
  const dots = Math.max(1, Math.round((Number(designedMm) || 0) / step));
  return Math.round(dots * step * 1000) / 1000;
}

export type DotFitLevel = 'warn' | 'info';

export interface DotFitIssue {
  /** 元素 id（无 id 时为空串） */
  elementId: string;
  elementType: string;
  /** 字段名，如 moduleWidthMm / heightMm / quietZoneMm / moduleSizeMm / strokeWidthMm */
  field: string;
  /** 人话字段名，用于提示文案 */
  label: string;
  designedMm: number;
  dots: number;
  actualMm: number;
  deltaPct: number;
  level: DotFitLevel;
  message: string;
}

/** 超过该相对偏差按「警告」处理（1 个点以内的取整在细线/小模块上已经很明显） */
export const DOT_FIT_WARN_PCT = 0.05;
/** 保证不因浮点噪声误报 */
export const DOT_FIT_EPS_MM = 0.005;

function pctText(p: number): string {
  const v = Math.round(p * 1000) / 10;
  return `${v > 0 ? '+' : ''}${v}%`;
}

function buildIssue(params: {
  elementId: string; elementType: string; field: string; label: string;
  designedMm: number; dpi: number; unitWord?: string;
}): DotFitIssue | null {
  const { elementId, elementType, field, label, designedMm, dpi } = params;
  if (!(designedMm > 0)) return null;
  const fit = dotFit(designedMm, dpi);
  if (fit.exact) return null;
  // 「物理下限」类问题优先：不到 1 个点等于画不出来
  if (fit.dots < 1) {
    return {
      elementId, elementType, field, label,
      designedMm, dots: 0, actualMm: 0, deltaPct: -1,
      level: 'warn',
      message: `${label} ${designedMm}mm 小于当前 ${dpi}dpi 的 1 个点（${Math.round(dotMm(dpi) * 1000) / 1000}mm），打印机画不出来；建议改为 ≥${Math.round(dotMm(dpi) * 1000) / 1000}mm`,
    };
  }
  if (Math.abs(fit.deltaMm) < DOT_FIT_EPS_MM) return null;
  const level: DotFitLevel = Math.abs(fit.deltaPct) >= DOT_FIT_WARN_PCT ? 'warn' : 'info';
  const sug = snapToDot(designedMm, dpi);
  const dir = fit.deltaMm < 0 ? '细' : '粗';
  const pct = pctText(-Math.abs(fit.deltaPct));
  return {
    elementId, elementType, field, label,
    designedMm, dots: fit.dots, actualMm: fit.actualMm, deltaPct: fit.deltaPct,
    level,
    message: `${label} 设计 ${designedMm}mm，${dpi}dpi 下只能给 ${fit.dots} 点 = 实打 ${fit.actualMm}mm（比设计${dir} ${pct.replace('-', '')}）；建议改成 ${sug}mm（${fit.dots} 点整）或换更高 dpi 的机器`,
  };
}

interface ElementLike {
  id?: string;
  type?: string;
  barcode?: { moduleWidthMm?: number; heightMm?: number; quietZoneMm?: number };
  qrcode?: { moduleSizeMm?: number; quietZoneMm?: number };
  stroke?: { width?: number };
}

/**
 * 检查模板元素在当前 dpi 下的取整偏差。
 * 只看会被打印机量化成点的量：模块宽/模块尺寸（X 维）、条高、静区、线宽。
 * 文字字号不在此列——字体渲染由机器固件处理，不按点严格量化。
 */
export function analyzeDotFit(elements: any[], dpi: number): DotFitIssue[] {
  const out: DotFitIssue[] = [];
  const list = Array.isArray(elements) ? elements : [];
  for (const el of list as ElementLike[]) {
    const id = String(el?.id ?? '');
    if (el?.type === 'barcode' && el.barcode) {
      const b = el.barcode;
      const push = (field: string, label: string, mm: any) => {
        const i = buildIssue({ elementId: id, elementType: 'barcode', field, label, designedMm: Number(mm), dpi });
        if (i) out.push(i);
      };
      push('moduleWidthMm', '模块宽', b.moduleWidthMm ?? 0.25);
      push('heightMm', '条高', b.heightMm ?? 9);
      push('quietZoneMm', '静区', b.quietZoneMm ?? 2);
    } else if (el?.type === 'qrcode' && el.qrcode) {
      const q = el.qrcode;
      const push = (field: string, label: string, mm: any) => {
        const i = buildIssue({ elementId: id, elementType: 'qrcode', field, label, designedMm: Number(mm), dpi });
        if (i) out.push(i);
      };
      push('moduleSizeMm', '模块尺寸', q.moduleSizeMm ?? 0.3);
      push('quietZoneMm', '静区', q.quietZoneMm ?? 1);
    } else if (el?.type === 'line' || el?.type === 'rect' || el?.type === 'ellipse') {
      const w = Number(el?.stroke?.width ?? 0);
      const i = buildIssue({ elementId: id, elementType: String(el?.type), field: 'strokeWidthMm', label: '线宽', designedMm: w, dpi });
      if (i) out.push(i);
    }
  }
  return out;
}

export interface DotFitSummary {
  dpi: number;
  dotMm: number;
  total: number;
  warns: number;
  infos: number;
  issues: DotFitIssue[];
  /** 一句话结论，直接给 UI 展示；无问题时为空串 */
  text: string;
}

export function summarizeDotFit(issues: DotFitIssue[], dpi: number): DotFitSummary {
  const warns = issues.filter((i) => i.level === 'warn');
  const infos = issues.filter((i) => i.level === 'info');
  const step = Math.round(dotMm(dpi) * 1000) / 1000;
  let text = '';
  if (warns.length) {
    text = `${warns.length} 处尺寸在当前 ${dpi}dpi（每点 ${step}mm）下取整后偏差较大：${warns
      .slice(0, 3)
      .map((i) => i.message)
      .join('；')}${warns.length > 3 ? `；等 ${warns.length} 处` : ''}`;
  } else if (infos.length) {
    text = `${infos.length} 处尺寸会被取整（偏差 <5%，可忽略）：${infos
      .slice(0, 2)
      .map((i) => `${i.label} ${i.designedMm}→${i.actualMm}mm`)
      .join('；')}`;
  }
  return {
    dpi,
    dotMm: step,
    total: issues.length,
    warns: warns.length,
    infos: infos.length,
    issues,
    text,
  };
}
