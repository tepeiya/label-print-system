// =============================================================================
// barcode-guard.ts —— 打印前条码自检（P0-2）
//
// 【解决什么】此前「码内容对」和「打印出来能扫」之间没有任何自动检查：
//   模板里一个密度过低 / 内容非法 / 静区被吃掉 / bwip 兜底成占位条纹的条码，
//   会一路下发到打印机，直到现场扫不出才发现，整批标签已作废。
//
// 【怎么判】按「标签实际要打的那份数据」逐个条码做两件事：
//   1. 密度闸门（纯函数、同步）：X-dim 与条高低于物理下限直接拦；
//   2. 真解码：用同一码制参数渲染 PNG → zxing 解码 → 与期望文本比对（复用 verify.calc）。
//
// 【边界（诚实）】
//   - 校验的是「服务端按名义密度渲染出的图」，不是打印机吐出的纸；真机仍需扫码枪验收；
//   - 解码器（zxing）不支持的码制（MaxiCode 部分模式 / 各 HIBC 变体）只记 warn 不阻断；
//   - 每单只校首张（同模板同数据，逐张校会把 zxing 开销乘上份数），内容变化由调用方重入。
// =============================================================================

import {
  renderBarcodeSvg, renderBarcodeToPng, renderQrcodeSvg, renderQrcodeToPng,
} from '../../core/barcode-renderer';
import { decodeBarcodeImage } from './verify.service';
import { verdictOf } from './verify.calc';

/** 物理下限：低于此值在实际产线/仓储几乎必然扫不出（GS1 通用下限 0.25mm，医疗 UDI 0.495mm） */
export const MIN_XDIM_1D_MM = 0.19;
export const MIN_XDIM_2D_MM = 0.3;
/** 一维码条高低于此值，手持扫描枪的容错窗口太小 */
export const MIN_HEIGHT_1D_MM = 6;

export type GuardIssueKind = 'density' | 'decode' | 'encode' | 'fit' | 'unsupported';

/** 元素框尺寸（mm），用于判断「内容变长后码放不进框」 */
export interface BoxSize { w: number; h: number }

export interface GuardIssue {
  elementId: string;
  sym: string;
  content: string;
  kind: GuardIssueKind;
  message: string;
  /** true = 阻断打印；false = 仅告警（能力边界内的降级） */
  blocking: boolean;
}

export interface GuardResult {
  ok: boolean;
  checked: number;
  issues: GuardIssue[];
}

export interface BarcodeTarget {
  elementId: string;
  sym: string;
  content: string;
  twoD: boolean;
  xdimMm: number;
  heightMm: number;
  spec: any;
}

/** 从 renderRow 的元素数组里收集待校验的条码（content 已求值） */
export function barcodeTargetsOf(rendered: any[]): BarcodeTarget[] {
  const out: BarcodeTarget[] = [];
  for (const e of Array.isArray(rendered) ? rendered : []) {
    if (e?.type === 'barcode' && e.barcode) {
      const b = e.barcode;
      out.push({
        elementId: String(e.id ?? b.id ?? ''),
        sym: String(b.sym ?? 'CODE128'),
        content: String(b.content ?? ''),
        twoD: false,
        xdimMm: Number(b.moduleWidthMm ?? 0.25),
        heightMm: Number(b.heightMm ?? 9),
        spec: b,
      });
    } else if (e?.type === 'qrcode' && e.qrcode) {
      const q = e.qrcode;
      out.push({
        elementId: String(e.id ?? q.id ?? ''),
        sym: String(q.sym ?? 'QRCODE'),
        content: String(q.content ?? ''),
        twoD: true,
        xdimMm: Number(q.moduleSizeMm ?? 0.4),
        heightMm: Number(e.hMm ?? q.quietZoneMm ?? 15),
        spec: q,
      });
    }
  }
  return out;
}

/**
 * 编码后的自然宽度（mm，含静区）。
 * bwip 的 SVG viewBox 单位 = 模块×scale（scale=3），二维每模块 2 个基础单位。
 * 内容变长 → 模块数增加 → 宽度变大（DataMatrix 会跨版本），这是「码溢出框」的根因。
 */
export function naturalWidthMm(t: Pick<BarcodeTarget, 'twoD' | 'sym' | 'xdimMm' | 'spec'>): number {
  let svg: string;
  try {
    svg = t.twoD ? renderQrcodeSvg(t.spec) : renderBarcodeSvg(t.spec);
  } catch {
    return 0;
  }
  const m = /viewBox="0 0 ([\d.]+)/.exec(svg);
  if (!m) return 0;
  const unitsPerModule = t.twoD ? 2 : 1;
  const modules = parseFloat(m[1]) / (3 * unitsPerModule);
  return modules * t.xdimMm;
}

/** 密度闸门（纯函数，单测覆盖） */
export function checkDensity(t: BarcodeTarget): GuardIssue | null {
  if (!t.content.trim()) {
    return {
      elementId: t.elementId, sym: t.sym, content: t.content, kind: 'encode',
      message: '条码内容为空（变量可能没取到值）', blocking: true,
    };
  }
  const min = t.twoD ? MIN_XDIM_2D_MM : MIN_XDIM_1D_MM;
  if (t.xdimMm < min) {
    return {
      elementId: t.elementId, sym: t.sym, content: t.content, kind: 'density',
      message: `${t.twoD ? '模块' : '窄条'}尺寸 ${t.xdimMm}mm 低于可扫下限 ${min}mm，打印后大概率扫不出`,
      blocking: true,
    };
  }
  if (!t.twoD && t.heightMm < MIN_HEIGHT_1D_MM) {
    return {
      elementId: t.elementId, sym: t.sym, content: t.content, kind: 'density',
      message: `条高 ${t.heightMm}mm 低于 ${MIN_HEIGHT_1D_MM}mm，扫描枪容错窗口不足`,
      blocking: true,
    };
  }
  return null;
}

/** 解码校验（异步；单条码 ~1ms，WASM 首次初始化除外） */
async function verifyOne(t: BarcodeTarget, dpi: number): Promise<GuardIssue | null> {
  let png: Buffer;
  try {
    png = t.twoD
      ? await renderQrcodeToPng(t.spec, dpi)
      : await renderBarcodeToPng(t.spec, dpi);
  } catch (e: any) {
    return {
      elementId: t.elementId, sym: t.sym, content: t.content, kind: 'encode',
      message: `编码失败：${e?.message || e}`, blocking: true,
    };
  }
  try {
    const candidates = await decodeBarcodeImage(png, t.sym);
    const v = verdictOf(candidates, t.content, t.sym);
    if (!v.match) {
      return {
        elementId: t.elementId, sym: t.sym, content: t.content, kind: 'decode',
        message: `渲染后解码结果与期望不一致：${v.reason}${v.decoded ? `（解出「${v.decoded}」）` : ''}`,
        blocking: true,
      };
    }
    return null;
  } catch (e: any) {
    // 解码器不支持该码制 / WASM 异常：属能力边界，降级为告警不拦打印
    return {
      elementId: t.elementId, sym: t.sym, content: t.content, kind: 'unsupported',
      message: `解码自检不可用（${e?.message || e}），已降级为不阻断`,
      blocking: false,
    };
  }
}

/**
 * 装框闸门：码比元素框还宽，打印/贴标时会被相邻元素或标签边切掉。
 * 这不是密度问题（密度可能完全达标），所以必须单独判。
 */
export function checkFit(t: BarcodeTarget, box?: BoxSize): GuardIssue | null {
  if (!box || box.w <= 0 || box.h <= 0) return null;
  const need = naturalWidthMm(t);
  if (need <= 0) return null;
  const avail = t.twoD ? Math.min(box.w, box.h) : box.w;
  if (need > avail + 0.5) {
    return {
      elementId: t.elementId, sym: t.sym, content: t.content, kind: 'fit',
      message: `编码后需 ${need.toFixed(1)}mm，元素框只有 ${avail.toFixed(1)}mm（内容变长会让码变宽），会溢出被切`,
      blocking: true,
    };
  }
  return null;
}

/**
 * 对一个标签行的全部条码做自检。
 * @param rendered renderRow 的输出（content 已解析）
 * @param dpi      打印机 dpi，决定位图渲染精度
 */
export async function guardRenderedBarcodes(
  rendered: any[], dpi = 300, boxes?: Record<string, BoxSize>,
): Promise<GuardResult> {
  const targets = barcodeTargetsOf(rendered);
  const issues: GuardIssue[] = [];
  let checked = 0;
  for (const t of targets) {
    // 装框先判：它和密度是两类失败，码可能密度达标但根本放不下
    const fit = checkFit(t, t.elementId && boxes ? boxes[t.elementId] : undefined);
    if (fit) { issues.push(fit); continue; }
    const dense = checkDensity(t);
    if (dense) { issues.push(dense); continue; }
    const bad = await verifyOne(t, dpi);
    if (bad) issues.push(bad);
    checked++;
  }
  return { ok: !issues.some((i) => i.blocking), checked, issues };
}

/**
 * 预热解码器：zxing-wasm 首次调用要初始化 WASM（实测 ~18s），
 * 不预热的话第一单打印会卡这么久。进程启动时后台跑一次，失败不影响启动。
 */
let warming: Promise<void> | null = null;
export function warmupBarcodeGuard(): Promise<void> {
  if (!warming) {
    warming = (async () => {
      try {
        const png = await renderBarcodeToPng(
          { sym: 'CODE128', content: 'WARMUP', moduleWidthMm: 0.3, heightMm: 10, showText: false } as any,
          300,
        );
        await decodeBarcodeImage(png, 'CODE128');
      } catch (e: any) {
        console.warn(`[barcode-guard] 预热失败（不影响打印，仅首次自检变慢）：${e?.message ?? e}`);
      }
    })();
  }
  return warming;
}

/** 给日志/任务失败原因用的单行摘要 */
export function summarizeGuard(r: GuardResult): string {
  const blocking = r.issues.filter((i) => i.blocking);
  if (!blocking.length) return '';
  const detail = blocking.slice(0, 3).map((i) => `[${i.sym}] ${i.message}`).join('；');
  return `条码自检未通过（${blocking.length} 项）：${detail}${blocking.length > 3 ? '…' : ''}`;
}
