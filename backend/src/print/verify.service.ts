// =============================================================================
// verify.service.ts —— 解码执行层（第三层 · 打印后解码验证闭环）
//
// 职责：把「渲染好的条码图像」交给 zxing-wasm 解码，产出候选文本供 verify.calc 判定。
// 与 ai-template/barcode-reader.ts 的区别：
//   - 那里是「任意上传图 → 识别所有码」（formats:All + tryHarder + 分块，首次可达数十秒）；
//   - 这里已知期望码制，指定 formats + 关闭 tryHarder，首次 WASM 初始化后单次解码 ~1ms。
//  Zap: zxing-wasm 首次加载 ~20s 是 WASM 初始化，进程内只发生一次。
// =============================================================================

import bwipjs from '@bwip-js/node';
import sharp from 'sharp';
import { readBarcodes } from 'zxing-wasm';
import { canonSym } from '../../core/symbology.capabilities';
import { bcidOf } from '../../core/barcode-renderer';
import type { CandidateDecoded } from './verify.calc';

/** LabelFlow sym → zxing BarcodeFormat 列表（精确优先，避免 All 的慢速全扫描） */
export function zxingFormatsFor(sym: string): string[] {
  const s = canonSym(sym);
  const map: Record<string, string[]> = {
    CODE128: ['Code128'], GS1_128: ['Code128', 'Code128'],
    CODE39: ['Code39'], CODE93: ['Code93'],
    EAN13: ['EAN13'], EAN8: ['EAN8'],
    UPC: ['UPCA'], UPC_A: ['UPCA'], UPC_E: ['UPCE'],
    ITF: ['ITF'], ITF14: ['ITF14'],
    CODABAR: ['Codabar'], MSI: ['Code39'], PHARMACODE: ['Code39'], CODE16K: ['Code128'],
    QRCODE: ['QRCode'], QR: ['QRCode'], MICROQR: ['MicroQRCode'], MICRO_QR: ['MicroQRCode'],
    DATAMATRIX: ['DataMatrix'], DATAMATRIX_RECT: ['DataMatrix'],
    PDF417: ['PDF417'], AZTEC: ['AztecCode'], AZTECCODE: ['AztecCode'],
    MAXICODE: ['MaxiCode'], PZN: ['PZN'],
    HIBC_128: ['Code128'], HIBC: ['Code128'], HIBC_CODE39: ['Code39'],
    HIBC_DATAMATRIX: ['DataMatrix'], HIBC_QR: ['QRCode'],
  };
  return map[s] ?? ['Code128', 'QRCode', 'DataMatrix', 'EAN13', 'Code39', 'PDF417'];
}

export interface DecodeOptions {
  /** 指定 zxing 格式（默认按 sym 推导） */
  formats?: string[];
  /** 是否费力重试（默认 false，验证场景已知码制无需） */
  tryHarder?: boolean;
}

/** 从 PNG/JPEG buffer 解码条码；透明底自动合成白底 */
export async function decodeBarcodeImage(buf: Buffer, sym: string, opts: DecodeOptions = {}): Promise<CandidateDecoded[]> {
  const { data, info } = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const results = await readBarcodes(
    { data: new Uint8ClampedArray(data), width: info.width, height: info.height },
    {
      formats: (opts.formats ?? zxingFormatsFor(sym)) as any,
      tryHarder: opts.tryHarder ?? false,
      tryRotate: true,
      tryInvert: false,
      maxNumberOfSymbols: 8,
    },
  );
  return results
    .filter((r) => r.text)
    .map((r) => ({ text: String(r.text), format: String((r as any).format ?? 'Unknown') }));
}

export interface RoundtripResult {
  sym: string;
  expected: string;
  /** bwip 渲染的 PNG（base64），便于留档/排查 */
  pngBase64: string;
  candidates: CandidateDecoded[];
}

/** 三方一致性自检：bwip 渲染 → zxing 解码 → 返回候选（判定交给 verify.calc）。
 *  这就是 B6「预览/指令/位图三方一致」里可执行的一环：证明同一内容在
 *  bwip 位图通道产出可解码且文本正确的条码。真机指令通道仍需硬件验收。
 */
export async function renderAndDecode(expected: string, sym: string, dpi = 203): Promise<RoundtripResult> {
  const bcid = bcidOf(sym);
  // 关键：不传 height。DataMatrix/QR/Aztec 是方阵，若强加 height 会被扭曲成
  // 非正方图（如 192x206），zxing 对特定尺寸敏感会解不出；让 bwip 按码制固有形状出图。
  // scale 保底 5（经验值：>=5 各主流码制 zxing 均可稳定解出）。
  const scale = Math.max(5, Math.round(dpi / 40));
  const png = await bwipjs.toBuffer({
    bcid,
    text: expected,
    scale,
    includetext: false,
    padding: 8,
  } as any);
  const candidates = await decodeBarcodeImage(png, sym);
  return { sym, expected, pngBase64: png.toString('base64'), candidates };
}
