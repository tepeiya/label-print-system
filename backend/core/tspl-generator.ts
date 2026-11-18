// =============================================================================
// tspl-generator.ts —— TSPL（TSC 指令，台半等打印机）指令生成
// 覆盖：SIZE/DIRECTION/GAP 页面头、文字 TEXT、条码 BARCODE、二维码 QRCODE、图片 BITMAP。
// 坐标换算：TSPL 默认 203dpi（1mm=8 dots），但新机型支持 DPI 设置；按 printer.dpi 换算。
//   dots = mm * dpi / 25.4。指令以 \r\n 结尾。
// =============================================================================

import type { BarcodeSpec, QrcodeSpec } from './types';
// P7：能力判定/降级/warnings/几何约束一律委托单一真源，本文件只保留「TSPL 指令语法」。
import {
  canonSym, describeUnsupported, resolveBarcodeGeometry,
  encodeGs1, gs1ToProtocol,
} from './symbology.capabilities';

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
// P7 重构：原本这里维护 SUPPORTED_TSPL_BARCODES / TSPL_NO_NATIVE_QRCODES /
// TSPL_NO_NATIVE_BARCODES / SUPPORTED_TSPL_QRCODES 四个 Set，与 ZPL 生成器、
// 前端列表、buildWarnings 共四处漂移。现统一委托 symbology.capabilities.ts，
// 本文件只保留 TSPL 指令语法（BARCODE / QRCODE 参数）。
// =============================================================================

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
        const sym = canonSym(b.sym);
        // P7：能力判定/降级统一走单一真源
        const support = describeUnsupported('tspl', sym);
        warnings.push(...support.warnings);
        if (support.skip) break;
        const mapped = tsplSym(sym);
        if (!mapped) {
          warnings.push(`[TSPL] ${sym} 声明为可打印但缺 BARCODE 类型映射，该元素已跳过（能力真源与语法表漂移，请报障）`);
          break;
        }
        // P7.6 几何：模块宽 DPI 对齐 + 静区自动（避免条宽不均与静区被裁）
        const geo = resolveBarcodeGeometry({
          sym, moduleWidthMm: b.moduleWidthMm, wideRatio: b.wideRatio, heightMm: b.heightMm,
          showText: b.showText, textPosition: b.textPosition, rotation: rot,
        }, dpi);
        const qz = geo.quietZone;
        const bx = x + mmToDots(qz.left, dpi);
        const by = y + mmToDots(qz.top, dpi);
        // BARCODE x,y,"code",height,human,rotation,narrow,wide,alignment,content
        const h = Math.max(1, mmToDots(b.heightMm, dpi));
        const narrow = Math.max(1, geo.moduleDots);
        const wide = Math.max(narrow, Math.round(narrow * geo.wideRatio));
        const human = b.showText ? '1' : '0';
        // moduleWidth 对齐属静默规范化，不进 warnings（见 zpl-generator 同处说明）。
        // P7.4：GS1-128 加 FNC1 起始前缀与变长 AI 分隔符；普通码制原样输出。
        // TSPL BARCODE "128" 内容里 `!` 即 FNC1：打头 `!` 标识 GS1 系统，
        // 变长 AI 之间也用 `!` 断句。data 本身不含起始占位符，故显式补前缀。
        let content = b.content;
        if (sym === 'GS1_128') {
          const g = encodeGs1(b.content);
          if (g.invalid.length) warnings.push(`[TSPL] GS1 数据存疑：${g.invalid.join('；')}（已按原括号格式输出，请核对）`);
          else content = (g.fnc1Prefix ? '!' : '') + gs1ToProtocol(g.data, 'tspl');
        }
        L.push(`BARCODE ${bx},${by},"${mapped}",${h},${human},${rot},${narrow},${wide},1,"${esc(content)}"`);
        break;
      }
      case 'qrcode': {
        const q = e.qrcode!;
        const sym = canonSym(q.sym ?? 'QRCODE');
        // P7：能力判定统一走单一真源。MICROQR 在真源里声明为 degradeTo=QRCODE，
        // 会由 describeUnsupported 回一条降级 warning，且这里按 QRCODE 指令输出。
        const support = describeUnsupported('tspl', sym);
        warnings.push(...support.warnings);
        if (support.skip) break;

        // P7.6 静区按码制自动（QR=4 / DM=1 / PDF417=2 / Aztec=0）
        const qz = resolveBarcodeGeometry({
          sym, moduleWidthMm: q.moduleSizeMm ?? 0.5, heightMm: e.hMm ?? 15,
          showText: false, textPosition: 'bottom', rotation: rot,
        }, dpi).quietZone;
        const qx = x + mmToDots(qz.left, dpi);
        const qy = y + mmToDots(qz.top, dpi);
        // 模块大小按 DPI 对齐到整数 dot（P7.6），并夹到各指令合法区间
        const moduleDots = Math.max(1, mmToDots(q.moduleSizeMm ?? 0.5, dpi));
        const content = tspl2DContent(sym, q.content, warnings); // GS1 内容 → TSPL ~1 分隔符

        // P7.3：按码制分派 TSPL/TSPL2 原生二维指令（语法依据 TSC 官方编程手册）
        if (sym === 'DATAMATRIX' || sym === 'DATAMATRIX_RECT') {
          // DMATRIX x,y,width,height,[c#,x#,r#,a#,row,col,]"content"
          //   命名参数：x#=模块 dot、r#=旋转、a1=矩形。示例 DMATRIX 10,110,400,400,x8,18,18,"..."
          // width/height 为条码区域尺寸（dots），取合理默认：内容越长区域越大
          const area = Math.max(60, moduleDots * 24);
          const opts = [`x${Math.min(20, moduleDots)}`, `r${rot}`];
          if (sym === 'DATAMATRIX_RECT') opts.push('a1');
          L.push(`DMATRIX ${qx},${qy},${area},${area},${opts.join(',')},"${esc(content)}"`);
        } else if (sym === 'PDF417') {
          // PDF417 x,y,width,height,rotate,[option,]"content"
          //   option 用命名参数：W=模块宽(2~9)、H=条高(4~99)、E=纠错(0~8)
          const w = Math.max(2, Math.min(9, moduleDots));
          const h = Math.max(4, Math.min(99, Math.max(4, mmToDots(e.hMm ?? 8, dpi))));
          const eccLevel = q.ecc === 'H' ? '8' : q.ecc === 'Q' ? '5' : q.ecc === 'L' ? '1' : '3';
          L.push(`PDF417 ${qx},${qy},${Math.max(w * 30, 200)},${h * 4},${rot},E${eccLevel},W${w},H${h},"${esc(content)}"`);
        } else if (sym === 'AZTEC') {
          // AZTEC x,y,rotate,size,ecp,flg,menu,multi,rev,bytes,content （V6.91EZ+）
          //   size=模块(1~20)、ecp=0 默认纠错；用带 bytes 的完整式，content 用引号包裹
          const size = Math.max(1, Math.min(20, moduleDots));
          L.push(`AZTEC ${qx},${qy},${rot},${size},0,0,0,1,1,${Buffer.byteLength(content, 'utf8')},"${esc(content)}"`);
        } else {
          // QR / Micro QR（含 MICROQR 的显式降级）：QRCODE x,y,ECC,cell,mode,rotation,content
          const eccMap: Record<string, string> = { L: 'L', M: 'M', Q: 'Q', H: 'H' };
          const cell = Math.min(10, moduleDots);
          L.push(`QRCODE ${qx},${qy},${eccMap[q.ecc ?? 'M'] ?? 'M'},${cell},A,${rot},"${esc(content)}"`);
        }
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
 * 标准码制 → TSPL BARCODE 类型名。
 * 别名归一化交给 canonSym（单一真源），本表只做「标准名 → TSPL 语法名」映射。
 * ⚠️ 不支持的码制**不再回落 '128'**（docs/05-api.md §8.3），改返回 undefined，
 *    由 generateTspl 的能力判定出 warning 并跳过。
 */
function tsplSym(sym: string): string | undefined {
  const key = canonSym(sym);
  const map: Record<string, string> = {
    CODE128: '128', GS1_128: '128',
    CODE39: '39', CODE93: '93',
    EAN13: 'EAN13', EAN8: 'EAN8',
    UPC: 'UPCA', UPC_E: 'UPCE',
    ITF14: 'ITF14', ITF: 'ITF',
    CODABAR: 'CODABAR', MSI: 'MSI',
  };
  return map[key];
}

/**
 * P7.3 / P7.4：二维码 GS1 内容 → TSPL 数据流。
 * 人类可读格式 "(01)123...(10)AB..." 走 encodeGs1 解析：GS1 以 FNC1 起始，
 * 变长 AI 之间插 FNC1 分隔。TSPL/TSPL2 手册明确 DMATRIX 内 `~1` = FNC1，
 * QR 亦沿用 ~1 转义。非 GS1 内容原样返回。
 */
function tspl2DContent(sym: string, raw: string, warnings: string[]): string {
  const s = String(raw ?? '');
  if (!/^\(\d{2,4}\)/.test(s)) return s;
  const g = encodeGs1(s);
  if (g.invalid.length) {
    warnings.push(`[TSPL] ${sym} GS1 数据存疑：${g.invalid.join('；')}（已按原内容输出，请核对）`);
    return s;
  }
  const fnc1 = '~1';
  return fnc1 + g.data.split('\u001D').join(fnc1);
}

function esc(s: string): string { return s.replace(/"/g, '""'); }
