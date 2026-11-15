// =============================================================================
// epl-generator.ts —— EPL2 指令生成器（旧 Zebra / Eltron 兼容机型，P7.7）
//
// 为什么单独一通道：ZPL 是新一代 Zebra 语言，但存量有大量只认 EPL2 的
// LP2844 / TLP2844 / GK420d(兼容模式) 等机型。三个通道（ZPL/TSPL/EPL）
// 覆盖 ~90% 工业标签机市场（docs/10 §10.7.3 B5）。
//
// EPL2 语法要点（与 ZPL 差异明显，不能混用）：
//   N                     清 image buffer
//   q WIDTH              标签宽（dots）
//   Q HEIGHT,GAP         标签高 + 间隙（dots）
//   A x,y,rot,font,xm,ym,inv,"text"    文本（font 1..5；xm/ym 放大；inv=N正常/B反白）
//   B x,y,rot,type,narrow,wide,height,human,"data"   一维码
//   b x,y,QR,mode,cell,"data"          二维码（仅 QR，EPL2 无 DM/PDF417/Aztec）
//   GW x,y,w_bytes,h,<hex>             位图
//   P count[,interval]                打印
//
// 【设计约束】与 zpl/tspl 生成器一致：
//   1. 能力判定/降级/warnings 一律委托 symbology.capabilities.ts（单一真源）；
//   2. 本文件只保留 EPL2「指令语法」与「标准码制 → EPL type code」映射；
//   3. 不支持的码制**绝不静默降级**为别的码制；跳过并给可执行建议。
//   4. 坐标换算：dots = mm * dpi / 25.4（EPL 只认 dots，无 mm）。
// =============================================================================

import type { BarcodeSpec, QrcodeSpec } from './types';
import {
  canonSym, describeUnsupported, resolveBarcodeGeometry,
} from './symbology.capabilities';

/** mm → dots（按 dpi）。EPL 与 ZPL/TSPL 口径完全一致，保证跨通道位置一致 */
export function mmToDots(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / 25.4);
}

export interface EplElement {
  type: 'text' | 'barcode' | 'qrcode' | 'image' | 'box' | 'line';
  xMm: number; yMm: number;
  rotation?: 0 | 90 | 180 | 270;
  // text
  text?: string; fontHeightMm?: number; fontWidthMm?: number; bold?: boolean; colorInvert?: boolean;
  // barcode / qrcode
  barcode?: BarcodeSpec;
  qrcode?: QrcodeSpec;
  // image
  imageData?: string; imgWmm?: number; imgHmm?: number;
  // 图形
  wMm?: number; hMm?: number; x2Mm?: number; y2Mm?: number; strokeMm?: number;
}

/** EPL2 旋转参数是 0/1/2/3（0°/90°/180°/270°），不是角度 */
function eplRot(rot: number): number {
  return ({ 0: 0, 90: 1, 180: 2, 270: 3 } as Record<number, number>)[rot] ?? 0;
}

/**
 * 标准码制 → EPL2 `B` 命令的 type code。
 * 依据 EPL2 Programming Guide：
 *   3=Code128(自动 A/B/C 与 UCC)、1=Code39(Mod43)、2=Interleaved 2 of 5、
 *   4=Codabar、E30=EAN-13、E80=EAN-8、UA0=UPC-A、UE0=UPC-E。
 * 与能力真源里声明 epl.native 的码制严格一一对应；新增码制必须同时改两处。
 */
const EPL_BARCODE_TYPE: Record<string, string> = {
  CODE128: '3', CODE39: '1', ITF: '2', CODABAR: '4',
  EAN13: 'E30', EAN8: 'E80', UPC: 'UA0', UPC_E: 'UE0',
};

/** EPL 里双引号内容转义（EPL 用 \" 或把 " 去掉；这里保守去掉双引号与换行） */
function esc(s: string): string {
  return String(s ?? '').replace(/"/g, '').replace(/[\r\n]+/g, ' ');
}

/**
 * 生成单张标签的 EPL2 指令（不含页头/打印命令，由 buildJob 封装）。
 * @returns { text, warnings } —— 与 ZPL/TSPL 生成器签名一致，便于 Provider 统一处理。
 */
export function generateEpl(els: EplElement[], dpi: number): { text: string; warnings: string[] } {
  const L: string[] = [];
  const warnings: string[] = [];

  for (const e of els) {
    const x = mmToDots(e.xMm, dpi);
    const y = mmToDots(e.yMm, dpi);
    const rot = eplRot(e.rotation ?? 0);

    switch (e.type) {
      case 'text': {
        const text = String(e.text ?? '');
        if (!text) break;
        // EPL2 内置字体 1..5，字号靠 xm/ym 放大倍数（1..8），不是 mm。
        // 用 fontHeightMm / (203dpi 下 12dot 基准) 估一个放大倍数，最少 1。
        const hDots = Math.max(1, mmToDots(e.fontHeightMm ?? 3, dpi));
        const xm = Math.max(1, Math.min(8, Math.round(hDots / 12)));
        const ym = xm;
        const font = e.bold ? '2' : '1';
        const inv = e.colorInvert ? 'B' : 'N';
        L.push(`A${x},${y},${rot},${font},${xm},${ym},${inv},"${esc(text)}"`);
        break;
      }
      case 'barcode': {
        const b = e.barcode!;
        const sym = canonSym(b.sym);
        // 能力判定统一走单一真源（不支持/暂未覆盖分别精确引导，不静默降级）
        const support = describeUnsupported('epl', sym);
        warnings.push(...support.warnings);
        if (support.skip) break;
        const type = EPL_BARCODE_TYPE[sym];
        if (!type) {
          warnings.push(`[EPL] ${sym} 声明为可打印但缺 EPL type code 映射（能力真源与语法表漂移），该元素已跳过`);
          break;
        }
        // P7.6 几何：模块宽 DPI 对齐 + 静区自动
        const geo = resolveBarcodeGeometry({
          sym, moduleWidthMm: b.moduleWidthMm, wideRatio: b.wideRatio, heightMm: b.heightMm,
          showText: b.showText, textPosition: b.textPosition, rotation: e.rotation,
        }, dpi);
        const qz = geo.quietZone;
        const bx = x + mmToDots(qz.left, dpi);
        const by = y + mmToDots(qz.top, dpi);
        const narrow = Math.max(1, geo.moduleDots);
        const wide = Math.max(narrow, Math.round(narrow * geo.wideRatio));
        const height = Math.max(1, mmToDots(b.heightMm, dpi));
        const human = b.showText ? 'B' : 'N';
        if (geo.heightTooSmall) {
          warnings.push(`[EPL] ${sym} 高度 ${b.heightMm}mm 偏小（建议 ≥ ${geo.suggestedHeightMm}mm），可能影响扫描`);
        }
        L.push(`B${bx},${by},${rot},${type},${narrow},${wide},${height},${human},"${esc(b.content)}"`);
        break;
      }
      case 'qrcode': {
        const q = e.qrcode!;
        const sym = canonSym(q.sym ?? 'QRCODE');
        // EPL2 只有 QR（b ... QR ...）；DM/PDF417/Aztec/MicroQR 手册无原生命令。
        const support = describeUnsupported('epl', sym);
        warnings.push(...support.warnings);
        if (support.skip) break;
        const qz = resolveBarcodeGeometry({
          sym: 'QRCODE', moduleWidthMm: q.moduleSizeMm ?? 0.5, heightMm: 15,
          showText: false, textPosition: 'bottom', rotation: e.rotation,
        }, dpi).quietZone;
        const qx = x + mmToDots(qz.left, dpi);
        const qy = y + mmToDots(qz.top, dpi);
        const cell = Math.min(10, Math.max(1, mmToDots(q.moduleSizeMm ?? 0.5, dpi)));
        // mode: A=自动 / M=手动；ecc 在 EPL2 由 cell 后可选参数表达，这里用标准简式
        L.push(`b${qx},${qy},QR,A,${cell},"${esc(q.content)}"`);
        break;
      }
      case 'box': {
        // EPL2 无 BOX，用 X 命令画反相矩形（x,y,thickness,width,height）
        const t = Math.max(1, mmToDots(e.strokeMm ?? 0.3, dpi));
        const w = Math.max(1, mmToDots(e.wMm ?? 0, dpi));
        const h = Math.max(1, mmToDots(e.hMm ?? 0, dpi));
        L.push(`X${x},${y},${t},${w},${h}`);
        break;
      }
      case 'line': {
        const x2 = mmToDots(e.x2Mm ?? e.xMm, dpi);
        const y2 = mmToDots(e.y2Mm ?? e.yMm, dpi);
        // LO = Line / original（黑白线），参数 x,y,width,height
        const w = Math.max(1, Math.abs(x2 - x));
        const h = Math.max(1, Math.abs(y2 - y));
        L.push(`LO${Math.min(x, x2)},${Math.min(y, y2)},${w},${h}`);
        break;
      }
      case 'image': {
        // EPL2 GW 需要 1-bit 行数据；本轮 P7.7 不接位图编码，精确引导图像通道
        warnings.push(`[EPL] 图片元素暂未接入 EPL GW 位图编码，该元素已跳过。建议改用 protocol=image（PNG/PDF 存档）或 ZPL ^GF 通道`);
        break;
      }
    }
  }
  return { text: L.join('\r\n'), warnings };
}

/** 完整作业：页头 + 元素 + 打印命令
 *  @returns { buffer, warnings } */
export function buildJob(
  els: EplElement[],
  dpi: number,
  page: { widthMm: number; heightMm: number; gapMm?: number; copies?: number },
): { buffer: Buffer; warnings: string[] } {
  const w = mmToDots(page.widthMm, dpi);
  const h = mmToDots(page.heightMm, dpi);
  const gap = mmToDots(page.gapMm ?? 2, dpi);
  const gen = generateEpl(els, dpi);
  const cmds = [
    'N',                          // 清缓冲
    `q${w}`,                      // 标签宽（dots）
    `Q${h},${gap}`,               // 标签高 + 间隙
    gen.text,
    `P${page.copies ?? 1}`,       // 打印份数
  ].filter(Boolean);
  return { buffer: Buffer.from(cmds.join('\r\n') + '\r\n', 'ascii'), warnings: gen.warnings };
}
