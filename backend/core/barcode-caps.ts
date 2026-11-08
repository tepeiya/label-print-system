// =============================================================================
// barcode-caps.ts —— 码制 × 打印协议 能力矩阵（单一真源）
//
// 为什么需要：P7.1/P7.2 之前，「前端可选码制」「生成器支持码制」「文档承诺」三者
// 各写一份，导致 ZPL 的 ^B2/^BI 用反、PDF417 用 ^B2、MicroQR 谎称原生支持等硬伤。
// 本文件把结论收敛成一张表，生成器 / 前端 / 单测 / 验收脚本都以它为准。
//
// 状态语义（务必按此实现，不要自创）：
//   native      —— 协议有原生指令，按规范参数输出，图案由打印机生成（首选）
//   degraded    —— 协议能出图，但输出与预览不完全等价（例如矩形 DM 出方形 DM），
//                  必须伴随 warning 说明差异
//   bitmap      —— 协议无原生指令，走 bwip-js 位图 + 图像通道（^GFa / BITMAP / G），
//                  图案由服务端生成，可扫但不是打印机原生符号
//   previewOnly —— 位图通道也拿不到数据（例如生成器被同步调用且未预置 raster），
//                  只能跳过 + warning
//
// 依据（2026-11-08 复核，逐条对照协议手册；^B 参数表按 ZPL II Command Summary 抄录）：
//   · ZPL ^B 家族：^B2=Interleaved 2 of 5(o,h,line,lineAbove,checkDigit)、
//     ^BI=Industrial 2 of 5、^BJ=Standard 2 of 5 —— 三者不通用，^B2 用 ^BI 打出来是另一种符号；
//     ^B7=PDF417(o,rowHeight,security,columns,rows,truncate)、
//     ^BX=Data Matrix(o,height=每符号元素高度,quality,columns,rows,format,escape,ratio)，
//       quality 可取 0/50/80/100/140/200，但手册标注 **quality 200 only**，
//       columns/rows 允许范围 9–49，ECC200 的矩形尺寸（8×18/8×32/12×26）落在范围外；
//     ^BO/^B0=Aztec(o,magnification,eci,size,readerInit,symbols,id)、
//     ^BQ=QR(o,model,magnification,errorCorrection,mask)，**model 2 only，无 Micro QR / 混合模式 / 汉字模式**；
//     ^BC=Code128(o,h,line,lineAbove,checkDigit,mode)、^BM=MSI(o,checkDigitType,h,line,lineAbove,checkDigit)、
//     ^BK=Codabar(o,checkDigit,h,line,lineAbove,startChar,stopChar)；
//     ^BY(w,r,h) 的 r 对固定比例码制无效（EAN/UPC 忽略）。
//   · TSPL BARCODE 码型表：128/128M/EAN128/EAN128M/39/39C/93/EAN13(+2/+5)/
//     EAN8(+2/+5)/UPCA(+2/+5)/UPCE(+2/+5)/ITF/ITF14/CODABAR/MSI/... 二维仅 QRCODE；
//     EAN128 才是 GS1-128（旧称 UCC/EAN-128），映射成 "128" 会打成普通 Code128（P7.2 的实伤）。
//   · bwip-js 实测可出图：datamatrix / datamatrixrectangular / pdf417 / azteccode /
//     microqrcode / code16k / pharmacode / gs1-128（一维 GS1 由 gs1-128 自己解析 (AI)）
//   · 二维符号的 GS1 (AI) 内容：ZPL/TSPL 均未给出 ^BX/^B7/^B0/^QRCODE 里 FNC1 的可引用转义写法，
//     按原生指令硬编会把 GS1 DataMatrix 静默打成普通 DataMatrix（数据错但肉眼看不出），
//     因此 planChannel() 把「二维 + (AI)」一律改派到位图通道。位图侧也不是开个 parsefnc 就完事：
//     bwip 对 datamatrix/qrcode 的括号 AI 不做 FNC1（实测解出 `]d1`，AI 结构丢失），
//     必须喂 `^FNC1` 文本（gs1.ts: gs1ToBwipFnc1 / gs1BwipText，实测 `]d2`/`]Q3`）。
// =============================================================================

export type PrintProtocol = 'zpl' | 'tspl' | 'epl';
export type CapStatus = 'native' | 'degraded' | 'bitmap' | 'previewOnly';

export interface SymCap {
  zpl: CapStatus;
  tspl: CapStatus;
  /** EPL 通道（P7.7）：旧 Zebra ELtron 机，覆盖面比 ZPL/TSPL 更窄 */
  epl: CapStatus;
  /** 二维码制标记，供前端分组与校验用 */
  twoD?: boolean;
  /** 人类可读说明，前端 tooltip / warnings 复用，避免三处写三份 */
  note: string;
}

/** 能力矩阵版本：前端缓存与验收脚本按这个号判断是否过期（前后端字面量必须一致，P7.8 守卫） */
export const CAP_MATRIX_VERSION = 'p7-2026-11-08.4';

const N: CapStatus = 'native';
const D: CapStatus = 'degraded';
const B: CapStatus = 'bitmap';
const P: CapStatus = 'previewOnly';

/**
 * epl 列的口径（P7.7 复核，.2 → .3）：以 core/epl-generator.ts 的
 * EPL_BARCODE_TYPES（Zebra EPL2 Programmer's Manual 980352-001 Table 2-1 的抄录）为准，
 * 并把原先偏保守的判定改对：
 *   · CODE128 / CODE93 / UPC_E 手册里有类型码（'1' / '9' / 'UE0'）→ native，不是 bitmap；
 *   · ITF14 没有独立类型码，用交叉二五码 '2' 承载 → degraded（少 ITF-14 边框标记）；
 *   · GS1_128 有 '1E' 但 FNC1/AI 分隔符的转义写法查不到 → previewOnly（宁可不打，不打错码）；
 *   · MSI 的 'M'/'L' 是 MSI-3 / Plessey，与本产品 MSI + MSI10/MSI11 不是同一符号 → previewOnly；
 *   · 一维码一律不给 bitmap：位图通道只对二维符号成立（raster 只有 qrcodeMonoRaster），
 *     一维的 bwip 缩放单位与打印点不成整数倍，栅格化会破坏条空比例；
 *   · 二维码制全部 bitmap：EPL2 的 b（2D）指令语法未查证到，改走 GW（[M] p.3-62）下发点阵。
 */

export const CAP_MATRIX: Record<string, SymCap> = {
  // ------------------------------- 一维码制 -------------------------------
  CODE128: { zpl: N, tspl: N, epl: N, note: 'ZPL ^BC / TSPL "128"，子集自动切换；EPL B 指令类型码 \'1\'' },
  GS1_128: {
    zpl: N, tspl: N, epl: P,
    note: 'ZPL ^BC + FNC1(>;, 变长 AI 间 >8)；TSPL "EAN128" 同为 GS1-128（旧称 UCC/EAN-128）；'
      + 'EPL 有类型码 \'1E\' 但 FNC1 转义写法未查证到，不做输出',
  },
  CODE39: { zpl: N, tspl: N, epl: N, note: 'ZPL ^B3 / TSPL "39"，宽窄比可变 2.0–3.0；EPL 类型码 \'3\'（带校验 \'3C\'）' },
  CODE93: { zpl: N, tspl: N, epl: N, note: 'ZPL ^BA / TSPL "93"；EPL 类型码 \'9\'' },
  EAN13: { zpl: N, tspl: N, epl: N, note: '固定比例 1:1，宽条=窄条，模块数固定' },
  EAN8: { zpl: N, tspl: N, epl: N, note: '固定比例 1:1' },
  UPC: { zpl: N, tspl: N, epl: N, note: 'UPC-A，固定比例 1:1' },
  UPC_A: { zpl: N, tspl: N, epl: N, note: 'UPC-A 别名' },
  UPC_E: { zpl: N, tspl: N, epl: N, note: 'UPC-E，固定比例 1:1，零压缩；EPL 类型码 UE0' },
  ITF: {
    zpl: N, tspl: N, epl: N,
    note: 'Interleaved 2 of 5 —— ZPL 用 ^B2（^BI 是 Industrial 2 of 5，用错就印不出）',
  },
  ITF14: {
    zpl: N, tspl: N, epl: D,
    note: 'GTIN-14 用 Interleaved 2 of 5 承载，ZPL ^B2 / TSPL "ITF14"；'
      + 'EPL Table 2-1 无 ITF-14 类型码，用 \'2\' 承载 → 编码链一致但不含 ITF-14 边框/承载标记',
  },
  CODABAR: { zpl: N, tspl: N, epl: N, note: 'ZPL ^BK / TSPL "CODABAR"，宽窄比可变；EPL 类型码 \'K\'' },
  MSI: {
    zpl: N, tspl: N, epl: P,
    note: 'ZPL ^BM / TSPL "MSI"（校验位另用 MSI10/MSI11）；'
      + 'EPL 只有 \'M\'(MSI-3) 与 \'L\'(Plessey/MSI-1)，校验算法被固件写死，不是同一符号，不做输出',
  },
  PHARMACODE: {
    zpl: P, tspl: P, epl: P,
    note: 'ZPL/TSPL 手册均无原生指令；一维符号的 bwip 缩放单位与打印点不成整数倍，位图回填会破坏条空比例，因此只保证预览',
  },
  CODE16K: {
    zpl: P, tspl: P, epl: P,
    note: 'ZPL 有 ^BB Codablock 但不是 Code16K，不可混用；同 PHARMACODE，仅预览',
  },

  // ------------------------------- 二维码制 -------------------------------
  QRCODE: {
    zpl: N, tspl: N, epl: B, twoD: true,
    note: 'ZPL ^BQ（model 2）/ TSPL QRCODE 指令；EPL 无 b(2D) 语法证据，用 GW 点阵下发 bwip-js 出图',
  },
  MICROQR: {
    zpl: B, tspl: B, epl: B, twoD: true,
    note: 'ZPL ^BQ 明确 model 2 only，Micro QR 无原生指令；TSPL 降级标准 QR 也不等价，统一走位图；'
      + 'EPL 的 b(2D) 语法未查证到，同样只能 GW 点阵',
  },
  DATAMATRIX: {
    zpl: N, tspl: B, epl: B, twoD: true,
    note: 'ZPL ^BX（质量级只能 200=ECC200，列/行走自动）；TSPL 无原生指令走位图；'
      + 'EPL 手册有 b(2D DataMatrix, p.3-20) 但参数语法查不到 → GW 点阵',
  },
  DATAMATRIX_RECT: {
    zpl: B, tspl: B, epl: B, twoD: true,
    note: 'ZPL ^BX 的 columns/rows 允许范围是 9–49，ECC200 矩形尺寸 8×18/8×32/12×26 越界会整块不打印，改走位图更稳；EPL 同走 GW',
  },
  PDF417: {
    zpl: N, tspl: B, epl: B, twoD: true,
    note: 'ZPL ^B7（安全级 0–8）；^B2 是 Interleaved 2 of 5，不能拿来当 PDF417 用；TSPL 无原生指令 → 位图；EPL 同走 GW',
  },
  AZTEC: {
    zpl: N, tspl: B, epl: B, twoD: true,
    note: 'ZPL ^BO/^B0；TSPL 无原生指令走位图；EPL 手册 2D 清单有 Aztec 但语法未查证 → GW 点阵',
  },
};

/** 前端可选码制全集（与 apps/console model.ts 的 BARCODE_SYMS + QRCODE_SYMS 对齐，P7.8 有守卫测试） */
export const UI_SYMS = Object.keys(CAP_MATRIX);

export function capOf(sym: string): SymCap | undefined {
  return CAP_MATRIX[String(sym ?? '').toUpperCase()];
}

export function statusFor(sym: string, protocol: PrintProtocol): CapStatus | undefined {
  const c = capOf(sym);
  return c ? c[protocol] : undefined;
}

export function isKnownSym(sym: string): boolean {
  return !!capOf(sym);
}

/** 该协议下需要位图回填的码制（生成器会尝试用调用方预置的 raster 出图） */
export function needsBitmap(sym: string, protocol: PrintProtocol): boolean {
  return statusFor(sym, protocol) === 'bitmap';
}

/** 该协议下有原生指令的码制集合，生成器白名单直接取这里 */
export function nativeSymsFor(protocol: PrintProtocol): string[] {
  return UI_SYMS.filter((s) => CAP_MATRIX[s][protocol] === 'native');
}

/** 内容是否是 GS1 (AI) 数据链（括号形式或含 GS 分隔符） */
export function isGs1Content(content: string): boolean {
  const s = String(content ?? '');
  return /\(\d{2,4}\)/.test(s) || /\u001d/.test(s);
}

export type Channel = 'native' | 'bitmap' | 'none';

/**
 * 通道派单（生成器与位图预生成共用同一判定，避免两边口径漂移）：
 *   native —— 出原生指令
 *   bitmap —— 需要调用方预置 fallback 点阵，出图像指令
 *   none   —— 什么都不能出，只能 warning + 跳过
 * 规则：能力矩阵说了算；唯一例外是「二维 + GS1 内容」——原生指令没有可引用的
 * FNC1 转义写法，硬编会静默丢 AI 结构，所以改派位图（bwip parsefnc 已验证）。
 */
/**
 * 通道派单（生成器与位图预生成共用同一判定，避免两边口径漂移）：
 *   native —— 出原生指令
 *   bitmap —— 需要调用方预置 fallback 点阵，出图像指令
 *   none   —— 什么都不能出，只能 warning + 跳过
 * 规则：能力矩阵说了算；唯一例外是「二维 + GS1 内容」——原生指令没有可引用的
 * FNC1 转义写法，硬编会静默丢 AI 结构，所以改派位图（bwip parsefnc 已验证）。
 * degraded 归 native：协议确实有指令，只是输出与预览不完全等价（如 EPL 的 ITF14
 * 用交叉二五码承载），差异由生成器自己出 warning，不改建码制。
 */
export function planChannel(sym: string, protocol: PrintProtocol, content: string): { channel: Channel; why?: string } {
  const st = statusFor(sym, protocol);
  if (!st) return { channel: 'none', why: `${sym} 不在码制能力矩阵内` };
  if ((st === 'native' || st === 'degraded') && capOf(sym)?.twoD && isGs1Content(content)) {
    return { channel: 'bitmap', why: `${sym} 含 GS1 (AI)：${protocol.toUpperCase()} 原生指令缺少可引用的 FNC1 转义写法，改走位图通道以保证 AI 结构可识别` };
  }
  if (st === 'native') return { channel: 'native' };
  if (st === 'degraded') return { channel: 'native', why: capNote(sym, protocol) };
  if (st === 'bitmap') return { channel: 'bitmap', why: capNote(sym, protocol) };
  return { channel: 'none', why: capNote(sym, protocol) };
}

/**
 * warnings 文案统一出口：说清「为什么不是原生」和「现在实际打出了什么」，
 * 不要出现 P7.1 之前那种「已按 QRCODE 输出」而生成器其实跳过的自相矛盾提示。
 */
export function capNote(sym: string, protocol: PrintProtocol): string {
  const c = capOf(sym);
  if (!c) return `${sym} 不在码制能力矩阵内，请确认前端码制标识`;
  const st = c[protocol];
  const label: Record<CapStatus, string> = {
    native: '原生指令',
    degraded: '原生指令（有等价性差异）',
    bitmap: '位图通道（bwip-js 出图）',
    previewOnly: '仅预览',
  };
  return `${sym} @ ${protocol.toUpperCase()} → ${label[st]}；${c.note}`;
}
