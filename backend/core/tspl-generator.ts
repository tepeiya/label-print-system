// =============================================================================
// tspl-generator.ts —— TSPL（TSC 指令，台半等打印机）指令生成
// 覆盖：SIZE/DIRECTION/GAP 页面头、文字 TEXT、条码 BARCODE、二维码 QRCODE、图片 BITMAP。
// 坐标换算：TSPL 默认 203dpi（1mm=8 dots），但新机型支持 DPI 设置；按 printer.dpi 换算。
//   dots = mm * dpi / 25.4。指令以 \r\n 结尾。
// =============================================================================

import type { BarcodeSpec, QrcodeSpec } from './types';

export function mmToDots(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / 25.4);
}

export interface TsplElement {
  type: 'text' | 'barcode' | 'qrcode' | 'image' | 'box' | 'line' | 'ellipse';
  xMm: number; yMm: number;
  rotation?: 0 | 90 | 180 | 270;
  text?: string; fontHeightMm?: number; fontWidthMm?: number; bold?: boolean;
  barcode?: BarcodeSpec;
  qrcode?: QrcodeSpec;
  imageData?: Buffer; imgWmm?: number; imgHmm?: number;
  wMm?: number; hMm?: number; x2Mm?: number; y2Mm?: number;
  borderMm?: number; strokeMm?: number;
}

// =============================================================================
// TSPL（TSC 指令）支持的码制集合。不在集合里的码制会出现在 warnings 里，
// 且不输出任何指令——**不再静默降级**（docs/05-api.md §8.3）。
// =============================================================================
const SUPPORTED_TSPL_BARCODES = new Set<string>([
  '128', 'GS1_128', 'GS1-128', 'CODE128',
  '39', 'CODE39',
  '93', 'CODE93',
  'EAN13', 'EAN8',
  'UPC', 'UPCA', 'UPC_A', 'UPC_E', 'UPCE',
  'ITF14', 'ITF', '2OF5', 'INTERLEAVED2OF5',
  'CODABAR',
  'MSI', 'MSI10', 'MSI11',
]);

const SUPPORTED_TSPL_QRCODES = new Set<string>(['QRCODE', 'MICROQR']);

/**
 * 生成单张标签 TSPL（不含 SIZE/DIRECTION 等页头，由 buildJob 封装）。
 * @returns { text: string; warnings: string[] }
 */
export function generateTspl(els: TsplElement[], dpi: number): { text: string; warnings: string[] } {
  const L: string[] = [];
  const warnings: string[] = [];
  for (const e of els) {
    const x = mmToDots(e.xMm, dpi);
    const y = mmToDots(e.yMm, dpi);
    const rot = e.rotation ?? 0;

    switch (e.type) {
      case 'text': {
        if (!String(e.text ?? '').trim()) break;
        // TEXT x,y,"font",rotation,mx,my,text —— FONT001 基准约 12 dots 高（203dpi）
        const baseDots = 12;
        const my = Math.max(1, Math.round(mmToDots(e.fontHeightMm ?? 3, dpi) / baseDots));
        const mx = Math.max(1, Math.round(mmToDots(e.fontWidthMm ?? (e.fontHeightMm ?? 3) * 0.6, dpi) / baseDots));
        L.push(`TEXT ${x},${y},"FONT001",${rot},${mx},${my},"${esc(e.text ?? '')}"`);
        break;
      }
      case 'barcode': {
        const b = e.barcode!;
        const mapped = tsplSym(b.sym);
        if (!mapped) {
          warnings.push(`TSPL 不支持一维码制 "${b.sym ?? ''}"，该元素已跳过输出；如需打印请改用 ZPL 协议或图像通道`);
          break;
        }
        // BARCODE x,y,"code",height,human,rotation,narrow,wide,alignment,content
        const h = Math.max(1, mmToDots(b.heightMm, dpi));
        const narrow = Math.max(1, mmToDots(b.moduleWidthMm, dpi));
        // 宽窄比缺省 2.5，避免 undefined 相乘产生 NaN
        const ratio = Number.isFinite(b.wideRatio) ? Number(b.wideRatio) : 2.5;
        const wide = Math.max(narrow, Math.round(narrow * ratio));
        const human = b.showText ? '1' : '0';
        L.push(`BARCODE ${x},${y},"${mapped}",${h},${human},${rot},${narrow},${wide},1,"${esc(b.content)}"`);
        break;
      }
      case 'qrcode': {
        const q = e.qrcode!;
        const sym = String(q.sym ?? 'QRCODE').toUpperCase();
        if (!SUPPORTED_TSPL_QRCODES.has(sym)) {
          warnings.push(`TSPL 不支持二维码制 "${q.sym ?? ''}"，该元素已跳过输出；如需打印请改用 ZPL 协议或图像通道`);
          break;
        }
        // QRCODE x,y,ECC,cell size,mode,rotation,[model],[mask],content
        const eccMap: Record<string, string> = { L: 'L', M: 'M', Q: 'Q', H: 'H' };
        const cell = Math.min(10, Math.max(1, mmToDots(q.moduleSizeMm ?? 0.5, dpi)));
        L.push(`QRCODE ${x},${y},${eccMap[q.ecc ?? 'M'] ?? 'M'},${cell},A,${rot},"${esc(q.content)}"`);
        break;
      }
      case 'box': {
        const w = Math.max(1, mmToDots(e.wMm ?? 0, dpi));
        const h = Math.max(1, mmToDots(e.hMm ?? 0, dpi));
        const t = Math.max(1, mmToDots(e.borderMm ?? 0.3, dpi));
        // BOX x_start,y_start,x_end,y_end,thickness
        L.push(`BOX ${x},${y},${x + w},${y + h},${t}`);
        break;
      }
      case 'ellipse': {
        const w = Math.max(1, mmToDots(e.wMm ?? 0, dpi));
        const h = Math.max(1, mmToDots(e.hMm ?? 0, dpi));
        const t = Math.max(1, mmToDots(e.borderMm ?? 0.3, dpi));
        L.push(`ELLIPSE ${x},${y},${x + w},${y + h},${t}`);
        break;
      }
      case 'line': {
        const x2 = mmToDots(e.x2Mm ?? e.xMm, dpi);
        const y2 = mmToDots(e.y2Mm ?? e.yMm, dpi);
        const t = Math.max(1, mmToDots(e.strokeMm ?? 0.3, dpi));
        // BAR x,y,width,height —— 水平线；垂直线用 BOX 退化表示
        if (Math.abs(y2 - y) <= t) L.push(`BAR ${Math.min(x, x2)},${y},${Math.abs(x2 - x)},${t}`);
        else if (Math.abs(x2 - x) <= t) L.push(`BAR ${x},${Math.min(y, y2)},${t},${Math.abs(y2 - y)}`);
        else L.push(`BOX ${Math.min(x, x2)},${Math.min(y, y2)},${Math.max(x, x2)},${Math.max(y, y2)},${t}`);
        break;
      }
      case 'image': {
        const w = mmToDots(e.imgWmm ?? 10, dpi);
        const h = mmToDots(e.imgHmm ?? 10, dpi);
        // BITMAP x,y,width_bytes,height,mode,data
        L.push(`BITMAP ${x},${y},${Math.ceil(w / 8)},${h},0`);
        // 实际需将 imageData 转 1-bit 行数据；此处略
        break;
      }
    }
  }
  return { text: L.join('\r\n'), warnings };
}

/** 封装整张作业页头 + 元素 + 打印命令
 *  @returns { buffer: Buffer; warnings: string[] } */
export function buildJob(
  els: TsplElement[],
  dpi: number,
  page: { widthMm: number; heightMm: number; gapMm?: number; copies?: number },
  orientation: 0 | 90 | 180 | 270 = 0,
): { buffer: Buffer; warnings: string[] } {
  const w = mmToDots(page.widthMm, dpi);
  const h = mmToDots(page.heightMm, dpi);
  const gap = mmToDots(page.gapMm ?? 2, dpi);
  const gen = generateTspl(els, dpi);
  const cmds: string[] = [
    'CLS',                                   // 清缓冲
    `SIZE ${w} ${h}`,                        // 标签尺寸（dots）
    `DIRECTION ${orientation === 0 ? 0 : 1}`,// 走纸方向
    `GAP ${gap} 0`,                          // 标签间距
    gen.text,
    `PRINT ${page.copies ?? 1},1`,           // 打印份数
  ];
  return { buffer: Buffer.from(cmds.join('\r\n') + '\r\n', 'utf8'), warnings: gen.warnings };
}

/**
 * 码制归一化 → TSPL 条码类型。
 * ⚠️ 不支持的码制**不再回落 '128'**（docs/05-api.md §8.3），改返回 undefined。
 * 调用方必须在返回 undefined 时出 warning，不能静默降级。
 */
function tsplSym(sym: string): string | undefined {
  const raw = String(sym ?? '');
  const upper = raw.toUpperCase().replace(/^CODE[-_]?/g, '');
  const map: Record<string, string> = {
    '128': '128', 'GS1_128': '128', 'GS1-128': '128', 'CODE128': '128',
    '39': '39', '93': '93', 'EAN13': 'EAN13', 'EAN8': 'EAN8',
    'UPC': 'UPCA', 'UPCA': 'UPCA', 'UPC_A': 'UPCA', 'UPC_E': 'UPCE', 'UPCE': 'UPCE',
    'ITF14': 'ITF14', 'ITF': 'ITF', '2OF5': 'ITF', 'INTERLEAVED2OF5': 'ITF',
    'CODABAR': 'CODABAR', 'MSI': 'MSI', 'MSI10': 'MSI10', 'MSI11': 'MSI11',
  };
  // 先查去前缀后的大写（'128'/'39'/'93'），再查原始大写（CODE128/GS1_128/...），最后查原始（万一有人传 'MSI11' 原样）
  return map[upper] ?? map[raw.toUpperCase()] ?? map[raw];
}

function esc(s: string): string { return s.replace(/"/g, '""'); }
