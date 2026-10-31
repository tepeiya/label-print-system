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
  type: 'text' | 'barcode' | 'qrcode' | 'image';
  xMm: number; yMm: number;
  rotation?: 0 | 90 | 180 | 270;
  text?: string; fontHeightMm?: number; fontWidthMm?: number; bold?: boolean;
  barcode?: BarcodeSpec;
  qrcode?: QrcodeSpec;
  imageData?: Buffer; imgWmm?: number; imgHmm?: number;
}

/** 生成单张标签 TSPL（不含 SIZE/DIRECTION 等页头，由 buildJob 封装） */
export function generateTspl(els: TsplElement[], dpi: number): string {
  const L: string[] = [];
  for (const e of els) {
    const x = mmToDots(e.xMm, dpi);
    const y = mmToDots(e.yMm, dpi);
    const rot = e.rotation ?? 0;

    switch (e.type) {
      case 'text': {
        // TEXT x,y,"font",rotation,mx,my,text  (mx,my 为横向/纵向放大倍数)
        const h = Math.max(1, Math.round((e.fontHeightMm ?? 3) * 8)); // 近似字号
        L.push(`TEXT ${x},${y},"FONT001",${rot},1,1,"${esc(e.text ?? '')}"`);
        break;
      }
      case 'barcode': {
        const b = e.barcode!;
        // BARCODE x,y,"code",height,human,rotation,narrow,wide,alignment,content
        const h = mmToDots(b.heightMm, dpi);
        const narrow = Math.max(1, mmToDots(b.moduleWidthMm, dpi));
        const wide = Math.round(narrow * b.wideRatio);
        const human = b.showText ? '1' : '0';
        L.push(`BARCODE ${x},${y},"${tsplSym(b.sym)}",${h},${human},${rot},${narrow},${wide},"${esc(b.content)}"`);
        break;
      }
      case 'qrcode': {
        const q = e.qrcode!;
        // QRCODE x,y,ECC,module,rotation,model,mask,content
        const eccMap: Record<string, string> = { L: 'L', M: 'M', Q: 'Q', H: 'H' };
        const module = Math.max(2, Math.round(mmToDots(q.moduleSizeMm, dpi) / 4));
        L.push(`QRCODE ${x},${y},${eccMap[q.ecc]},${module},${rot},1,A,"${esc(q.content)}"`);
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
  return L.join('\r\n');
}

/** 封装整张作业页头 + 元素 + 打印命令 */
export function buildJob(
  els: TsplElement[],
  dpi: number,
  page: { widthMm: number; heightMm: number; gapMm?: number; copies?: number },
  orientation: 0 | 90 | 180 | 270 = 0,
): Buffer {
  const w = mmToDots(page.widthMm, dpi);
  const h = mmToDots(page.heightMm, dpi);
  const gap = mmToDots(page.gapMm ?? 2, dpi);
  const cmds: string[] = [
    'CLS',                                   // 清缓冲
    `SIZE ${w} ${h}`,                        // 标签尺寸（dots）
    `DIRECTION ${orientation === 0 ? 0 : 1}`,// 走纸方向
    `GAP ${gap} 0`,                          // 标签间距
    generateTspl(els, dpi),
    `PRINT ${page.copies ?? 1},1`,           // 打印份数
  ];
  return Buffer.from(cmds.join('\r\n') + '\r\n', 'ascii');
}

function tsplSym(sym: string): string {
  const map: Record<string, string> = {
    CODE128: '128', CODE39: '39', EAN13: 'EAN13', EAN8: 'EAN8',
    UPC_A: 'UPCA', ITF14: 'ITF', GS1_128: '128', CODABAR: 'CODABAR', MSI: 'MSI',
  };
  return map[sym] ?? '128';
}

function esc(s: string): string { return s.replace(/"/g, '""'); }
