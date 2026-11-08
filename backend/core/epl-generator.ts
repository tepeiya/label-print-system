// =============================================================================
// epl-generator.ts —— EPL2 指令生成（旧 Zebra / 原 Eltron 桌面机：EL270、EPL-2120、
// Zebra 888-TT / GK420t / TLP2844 等「EPL/EPL2」机型的 page 模式）
//
// ── 本版范围（roadmap P7.7：先做一维码 + QR，其他回 warnings）
//   ✅ 页面头 N / q / Q / ZB / D / S + 页尾 P（参数单位是「点」，行尾 CR LF）
//   ✅ 一维码：只输出 EPL2 类型码表（Table 2-1）里查证到类型码的码制
//   ✅ 文本：A 指令（内置拉丁字体 1–5 + 膨胀系数；亚洲双字节字体 8/9 依赖机型字库 → warning）
//   ✅ 二维码 / 图像：EPL2 的 b（2D）指令**参数级语法未查证到**，因此不打原生二维码；
//      拿到 fallback 点阵时走 GW（Direct Graphic Write）位图通道
//   ⛔ 框 / 线 / 椭圆：手册有 X（Box Draw）与 LO/LS/LW/LE（Line Draw 家族），
//      但参数几何含义（x1,y1,x2,y2 还是 x,y,w,h + 线宽放在第几位）在可引用资料里说法不一致 →
//      warning + 跳过。**宁可不打，也不猜语法**（猜错的指令固件不报错，打出来是错图）。
//
// ── 查证依据（下文用代号引用；每条写进输出的指令旁边都标了来源）
//   [M] Zebra,「EPL2 Programmer's Manual — Programming for Page Mode Printing」,
//       Manual No. 980352-001 Rev. D, © 2003 ZIH Corp.（命令目录页码：A 3-4、B 3-11、
//       B(RSS-14) 3-16、b(2D DataMatrix) 3-20、b(2D MaxiCode) 3-25、b(2D PDF417) 3-29、
//       D 3-40、GG 3-57、GI 3-58、GK 3-59、GM 3-60、GW 3-62、LE 3-68、LO 3-69、LS 3-70、
//       LW 3-71、N 3-73、P 3-87、q 3-89、Q 3-91、S 3-97、X 3-120、Z 3-122）
//       —— 目录里**没有** SIZE / DENSITY / SPEED / TEXT / BARCODE / QRCODE 这些名字：
//          它们是 TSPL/兼容机的指令名，EPL2 的对应物是 q+Q / D / S / A / B / b。
//       —— 目录里也**没有**裸 `G` 指令：图形族只有 GG/GI/GK/GM/GW（+UG 查询），
//          所以本文件下发的是 GW，不是 G（详见「与 coordinator 结论不一致的两点」）。
//   [Z]「EPL 命令简单解释」——[M] 第 2 章 A/B 指令逐参数 + Table 2-1 类型码表的抄录
//       https://www.cnblogs.com/lab-zj/p/14066951.html （同文镜像 wk.baidu.com/view/a33190f5270c844769eae009581b6bd97f19bc2a）
//   [S] Scribd「EPL Language Manual」A/B 指令语法段（p5 字体宽 1,2,3,4,5,6 & 8、p6 字号 1–9、
//       p7 N/R；B 的 p6 宽条 2–30、p7 高度点、p8 B=打印条码下方/N=不打印；与 [Z] 互证）
//       https://www.scribd.com/document/972262056/EPL-Language-Manual
//   [N] Neodynamic「Virtual EPL Printer」EPL Commands Support 表（第三方实现的指令族覆盖面，
//       用来交叉验证「哪些指令族存在」，不作为参数语法依据）
//       https://www.neodynamic.com/products/virtual-epl-printer
//   [E] 在用的真实 EPL 作业样本（q / B / A / LO / LW / LE / GW / P 的实际写法）：
//       C# EPL USB 指令打印（模板 SOE05640007536.epl2）https://www.cnblogs.com/rinack/p/4843627.html
//       —— 样本里 GW 的写法是 `GW0, 535 , 3 , 64` + 紧随其后的点阵数据（x,y,字节宽,行数）
//   [G] EPL 图像下发的 C# 实现（GW 参数顺序 + 位图数据按 iso-8859-1/latin1 原样写字节）：
//       https://blog.51cto.com/u_16822845/11650914 、https://www.cnblogs.com/JourneyOfFlower/p/15255278.html
//       等多份同类实现，写法一致：
//       `N\r\nGW{0},{1},{每行实际字节数},{图高行数},{latin1(字节缓冲)}\r\nP{copies},1\r\n`
//
// ── 与 coordinator 结论不一致的两点（都按任务规则「凡查证不到的一律走 warnings，不允许猜」处理）
//   1) 图形指令名：要求里写的是 `G`/`g`，但 [M] 980352-001 Rev. D 的目录与 [N] 的命令表里
//      只有 GG/GI/GK/GM/GW，没有裸 `G`；参数级证据（x,y,bytesPerRow,rows + 原始二进制）也只对
//      GW 成立。本文件因此输出 GW，并把指令名收敛到常量 EPL_GRAPHIC_COMMAND 一处——
//      若贵方手上的《Eltron Programming Manual》pp.58–61（A730-1404-00）确有 `G`，
//      改那一个常量即可，不需要动生成逻辑。
//   2) GS1-128：要求里写的是 `b1` + `{G}` + `&`。在 [M]/[Z]/[S]/[N] 里查不到任何 `b1..b8` 形式的
//      一维类型码（`b` 在 EPL2 里是 2D 家族：DataMatrix/MaxiCode/PDF417），也查不到用 `{G}`/`&`
//      表达 FNC1 / AI 分隔的写法；[Z] 里 GS1-128 的类型码是 `1E`（UCC/EAN 128），但**数据段里
//      FNC1 怎么打**没有任何可引用依据。按 (AI) 原样塞进 `1E` 会把 GS1 结构静默打成错码
//      （扫描结果与预览不一致且看不出来），所以本版仍然「跳过 + warning」，
//      并把 (AI) 解析结果写进 warning 文本，方便实机验证后再放行。
//
// ── 自包含交付说明（本轮 coordinator 要求）
//   本文件**只 import `./types`（纯类型，零运行时依赖）**，不 import barcode-caps /
//   barcode-geometry / bitmap-blocks / gs1 / raster，也不 import zpl/tspl 生成器。集成由上层负责。
//   为此内联了三份「本仓其他模块的最小李集」，改动时需要双向同步：
//     · normSym / geometry1d   ← core/barcode-geometry.ts（只内联**影响指令数值**的部分：
//       X-dim 点数量化、固定比例强制、宽条取整、高度点数换算；「高度不低于符号长度 25%」这类
//       纯提示性检查仍留在 barcode-geometry / 预览侧，不在这里重复）
//     · eplGraphic 的尺寸单位  ← core/bitmap-blocks.ts 的 eplGraphicSize()
//     · gs1AiDiagnosis         ← core/gs1.ts 的定长 AI 表（只用于诊断文本，不参与输出决策）
//   EPL_SYM_STATUS 是**面向能力矩阵合并的审计快照**（含 status/command/note+来源），
//   与 core/barcode-caps.ts 的 `epl` 列口径对照见该表上方注释；本文件不读矩阵，因此
//   status→epl 列的映射是：native→native（ITF14 例外，请标 degraded，见该行 note）、
//   bitmap→bitmap、previewOnly / no-evidence→previewOnly。
//
// ── 仓库既有约定（不变）
//   · 签名/返回形态与 zpl-generator / tspl-generator 对齐：同步、返回 { text, warnings }、
//     **永不抛异常**、不支持的码制绝不静默降级成 Code128/QR（docs/05-api.md §8.3，
//     docs/10-dev-handover.md:574 复述）。
//   · 坐标换算：dots = mm * dpi / 25.4（EPL2 的 A/B/q/Q 参数单位就是点，[M] 1-4 章）。
//   · **数据字段永不省略**：A/B 的语法里 "DATA" 是必选项（[S]/[Z] 的 A/B 语法串都以 ,"Data" 结尾）。
//     另按 coordinator 提供的实机经验：`b`/`B` 家族省略数据段时固件会打印**上一次缓存的符号**，
//     这类错在标签上看不出来。所以本文件的规则是：内容为空 ⇒ 整条元素跳过 + [数据] warning，
//     绝不下发 `B...,""` 这种「有指令无数据」的半成品；有内容 ⇒ 数据段必须逐次写全。
// =============================================================================

import type { BarcodeSpec, BitmapFallback, QrcodeSpec } from './types';

/** mm → dots（与 zpl/tspl 生成器同一公式；[M] 1-4 章参数单位是点） */
export function mmToDots(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / 25.4);
}

/**
 * 位图回填点阵的字段契约（与 core/types.ts 的 BitmapFallback 完全同构，
 * 这里只是把「生成器实际读到的五个字段」写明：hex 为逐行 ASCII hex 拼接，
 * 1=墨、MSB 在左、行序自上而下、行尾补 0 到字节边界，见 core/raster.ts:45 packRows）。
 */
export type EplBitmap = Pick<BitmapFallback, 'widthDots' | 'heightDots' | 'bytesPerRow' | 'hex' | 'moduleDots'>;

export interface EplElement {
  type: 'text' | 'barcode' | 'qrcode' | 'image' | 'box' | 'line' | 'ellipse';
  xMm: number; yMm: number;
  rotation?: 0 | 90 | 180 | 270;
  // text
  text?: string; fontFamily?: string; fontHeightMm?: number; fontWidthMm?: number;
  bold?: boolean; align?: 'L' | 'C' | 'R';
  colorInvert?: boolean;
  // barcode / qrcode
  barcode?: BarcodeSpec;
  qrcode?: QrcodeSpec;
  // image
  imageData?: string; imgWmm?: number; imgHmm?: number;
  // 图形元素
  wMm?: number; hMm?: number; x2Mm?: number; y2Mm?: number;
  borderMm?: number; strokeMm?: number;
  /**
   * 位图回填点阵（P7.3 的 BitmapFallback）。EPL2 的 2D 指令 b 参数语法未查证到，
   * 所以 QR/DataMatrix 等只有拿到点阵时才可能下发（GW）；拿不到就跳过 + 可执行 warning。
   */
  fallback?: EplBitmap;
}

export interface EplPage {
  widthMm: number;
  heightMm: number;
  /** Q 指令第二位（标签间距，点）。缺省按仓库惯例 2mm */
  gapMm?: number;
  /** D 指令（打印深度/darkness）。上限依机型（[Z] 示例用 D10），故只按调用方给定整数原样输出 */
  density?: number;
  /** S 指令（打印速度）。可引用资料只给出「范围依机型」，故不钳制 */
  speed?: number;
  copies?: number;
  /** 走纸方向；也可用 generateEpl 的第 4 个参数（第 4 个参数优先） */
  orientation?: 0 | 90 | 180 | 270;
}

// =============================================================================
// 码制标识归一（core/barcode-geometry.ts 的 normSym 内联副本：同一张别名表）
// =============================================================================
const SYM_ALIAS: Record<string, string> = {
  'CODE-128': 'CODE128', CODE128: 'CODE128', UCC128: 'GS1_128', 'GS1-128': 'GS1_128',
  'EAN-13': 'EAN13', 'EAN-8': 'EAN8', 'UPC-A': 'UPC', UPCA: 'UPC', 'UPC-E': 'UPC_E',
  UPCE: 'UPC_E', '2OF5': 'ITF', 'INTERLEAVED2OF5': 'ITF', 'ITF-14': 'ITF14',
  'CODE-39': 'CODE39', 'CODE-93': 'CODE93', NW7: 'CODABAR', CODABAR: 'CODABAR',
  '2D': 'MICROQR', MICRO_QR: 'MICROQR', DM: 'DATAMATRIX', QR: 'QRCODE',
};

export function normSym(sym: string): string {
  const raw = String(sym ?? '').toUpperCase();
  return SYM_ALIAS[raw] ?? raw.replace(/^CODE-?/, 'CODE');
}

// =============================================================================
// 一维码几何（core/barcode-geometry.ts 的 computeGeometry 中最小必要集的本地实现）
//   规则与 barcode-geometry 一致：
//     1) X-dim 必须是整数个打印点（一个点 = 25.4/dpi mm），非整数点宽在热敏头上会被抖成忽粗忽细；
//     2) 固定比例码制（EAN/UPC 家族）wide 必须 === narrow，否则印出非法符号；
//     3) Code128 家族的宽元素必须是整数模块（规范上 2–4 模块）。
// =============================================================================

/** 各码族最小可用 X-dim（mm）：低于此值判为「扫不出来风险」，只提示不改变换码 */
const MIN_X_MM: Record<string, number> = {
  EAN13: 0.293, EAN8: 0.293, UPC: 0.293, UPC_A: 0.293, UPC_E: 0.293, // GS1 37% 放大率下限
  CODE128: 0.249, GS1_128: 0.249, CODE39: 0.249, CODE93: 0.249, ITF: 0.249, ITF14: 0.249,
  CODABAR: 0.249, MSI: 0.249, PHARMACODE: 0.249, CODE16K: 0.249,
};

/** 固定比例（1:1）码制：宽条 = 窄条，不接受 wideRatio */
const FIXED_RATIO = new Set(['EAN13', 'EAN8', 'UPC', 'UPC_A', 'UPC_E', 'ISBN', 'ISSN']);

/** 各码制默认宽窄比（对齐专业软件缺省值，与 barcode-geometry.defaultRatio 同一份数） */
const DEFAULT_RATIO: Record<string, number> = {
  CODE128: 2, GS1_128: 2, CODE93: 2,
  CODE39: 2.5, CODABAR: 2.5, MSI: 2.5, ITF: 2.5, ITF14: 2.5,
};

function defaultRatio(sym: string): number {
  if (FIXED_RATIO.has(sym)) return 1;
  return DEFAULT_RATIO[sym] ?? 2;
}

/**
 * 一维码几何。返回 EPL B 指令要的 p5（窄条点宽）/ p6（宽条点宽）/ p7（高度点）的**输入值**，
 * 参数范围钳制留给 EPL 自己（clampNarrow/clampWide），这样警告说的是「EPL 的事」。
 */
function geometry1d(
  sym: string, dpi: number, b: BarcodeSpec,
): { narrow: number; wide: number; height: number; warnings: string[] } {
  const pitch = 25.4 / (Number(dpi) > 0 ? Number(dpi) : 203);
  const warnings: string[] = [];

  const reqMm = Number(b.moduleWidthMm) > 0 ? Number(b.moduleWidthMm) : 0.25;
  let narrow = Math.round(reqMm / pitch);
  if (narrow < 1) {
    warnings.push(`[几何] ${sym} X-dim ${reqMm.toFixed(3)}mm 在 ${dpi}dpi 下不足 1 点（${pitch.toFixed(3)}mm/点），已抬到 1 点=${pitch.toFixed(3)}mm`);
    narrow = 1;
  }
  const xMm = narrow * pitch;
  const minX = MIN_X_MM[sym];
  if (minX && xMm < minX) {
    warnings.push(`[几何] ${sym} X-dim ${xMm.toFixed(3)}mm 低于该码制推荐下限 ${minX}mm，建议 ≥${minX}mm（提高打印分辨率或加宽模块）以保证识读`);
  }
  // 量化提示只在偏差 ≥0.02mm 时报，避免 300dpi 下满屏噪音
  if (Math.abs(xMm - reqMm) >= 0.02) {
    warnings.push(`[几何] ${sym} X-dim 由 ${reqMm.toFixed(3)}mm 量化为 ${xMm.toFixed(3)}mm（${narrow} 点 × ${pitch.toFixed(3)}mm/点）`);
  }

  let wide: number;
  if (FIXED_RATIO.has(sym)) {
    wide = narrow;
    if (Number.isFinite(b.wideRatio as number) && Number(b.wideRatio) !== 1) {
      warnings.push(`[几何] ${sym} 为固定比例码制，宽窄比 ${b.wideRatio} 已忽略（强制 1:1）`);
    }
  } else {
    const reqRatio = Number.isFinite(b.wideRatio as number) ? Number(b.wideRatio) : defaultRatio(sym);
    const clamped = Math.min(3.5, Math.max(1.5, reqRatio));
    const is128Family = sym === 'CODE128' || sym === 'GS1_128';
    // Code128 的宽元素必须是整数模块（2–4），2.5 这种比例在指令里会被固件舍成不确定的宽窄比
    const eff = is128Family ? Math.max(2, Math.min(4, Math.round(clamped))) : clamped;
    if (is128Family && Number.isFinite(b.wideRatio as number) && Math.abs(eff - Number(b.wideRatio)) > 0.01) {
      warnings.push(`[几何] Code128/GS1-128 宽元素必须为整数模块，宽窄比 ${b.wideRatio} 已取整为 ${eff}:1`);
    }
    wide = Math.max(narrow, Math.round(narrow * eff));
  }

  const height = Math.max(1, Math.round((Number(b.heightMm) > 0 ? Number(b.heightMm) : 8) / pitch));
  return { narrow, wide, height, warnings };
}

// =============================================================================
// Table 2-1（EPL2 条码类型码）抄录 + 参数取值范围
//   type         : B 指令 p4
//   narrowMin/Max: B 指令 p5（窄条点宽）允许范围 —— [Z] Table 2-1 右列
//   wideSettable : [Z] Table 2-1「P6 Value」列，Y = 宽条宽度由用户设定，N = 固件固定/忽略
//   checkType    : 要求校验位时的类型码（同样来自 Table 2-1，只有确实存在的才填）
// ⚠️ 只列查证到类型码**且数据段写法也可用**的码制。GS1_128 有类型码 `1E`（UCC/EAN 128），
//    但 FNC1 / 变长 AI 分隔符的转义写法在 [M]/[Z]/[S] 里都没抄到 ⇒ 不进这张表（见 EPL_SYM_STATUS）。
//    若贵方手册的一维类型码是另一套编号（如 `b1..b8` 之类），只需替换这张表的 type 字段，
//    生成逻辑不必改动。
// =============================================================================
export interface EplSymDef {
  type: string;
  narrowMin: number;
  narrowMax: number;
  wideSettable: boolean;
  checkType?: string;
  /** 与预览不完全等价时（如 ITF14 用交叉二五码承载）说明差异 */
  degraded?: string;
  cite: string;
}

export const EPL_BARCODE_TYPES: Record<string, EplSymDef> = {
  CODE128: {
    type: '1', narrowMin: 1, narrowMax: 10, wideSettable: false,
    cite: "[Z]/[M] Table 2-1: Code 128 auto A,B,C modes → B p4='1'",
  },
  CODE39: {
    type: '3', narrowMin: 1, narrowMax: 10, wideSettable: true, checkType: '3C',
    cite: "[Z]/[M] Table 2-1: Code 39 std./extended='3'，Code 39 with check digit='3C'",
  },
  CODE93: {
    type: '9', narrowMin: 1, narrowMax: 10, wideSettable: false,
    cite: "[Z]/[M] Table 2-1: Code 93 → B p4='9'",
  },
  EAN13: {
    type: 'E30', narrowMin: 2, narrowMax: 4, wideSettable: false,
    cite: "[Z]/[M] Table 2-1: EAN13='E30'（2 位附加码 E32、5 位 E35 本版不输出，见 emitBarcode 注）",
  },
  EAN8: {
    type: 'E80', narrowMin: 2, narrowMax: 4, wideSettable: false,
    cite: "[Z]/[M] Table 2-1: EAN8='E80'（附加码 E82/E85 同上，不输出）",
  },
  UPC: {
    type: 'UA0', narrowMin: 2, narrowMax: 4, wideSettable: false,
    cite: "[Z]/[M] Table 2-1: UPC-A='UA0'（+2='UA2'、+5='UA5'）",
  },
  UPC_A: {
    type: 'UA0', narrowMin: 2, narrowMax: 4, wideSettable: false,
    cite: "[Z]/[M] Table 2-1: UPC-A='UA0'（UPC_A 别名，normSym 未把 UPC_A 归一到 UPC）",
  },
  UPC_E: {
    type: 'UE0', narrowMin: 2, narrowMax: 4, wideSettable: false,
    cite: "[Z]/[M] Table 2-1: UPC-E='UE0'（+2='UE2'、+5='UE5'）",
  },
  ITF: {
    type: '2', narrowMin: 1, narrowMax: 10, wideSettable: true, checkType: '2C',
    cite: "[Z]/[M] Table 2-1: Interleaved 2 of 5='2'，+mod10 校验='2C'，+可读校验位='2D'",
  },
  ITF14: {
    type: '2', narrowMin: 1, narrowMax: 10, wideSettable: true,
    degraded: 'EPL2 Table 2-1 无 ITF-14 类型码，用交叉二五码 `2` 承载：编码数据链一致（GTIN-14），'
      + '但不含 ITF-14 的边框/承载标记，外观与预览不同',
    cite: "[Z]/[M] Table 2-1 只有 Interleaved 2 of 5='2'；[N] 的 EPL 线性码清单同样不含 ITF-14",
  },
  CODABAR: {
    type: 'K', narrowMin: 1, narrowMax: 10, wideSettable: true,
    cite: "[Z]/[M] Table 2-1: Codabar='K'（p6 宽条可设定）",
  },
};

// =============================================================================
// EPL_SYM_STATUS —— 面向能力矩阵合并的**全码制审计表**（P7.7 复核结论 + 来源）
//
// status 语义（本表口径；映射到 core/barcode-caps.ts 的 epl 列见下方注释）：
//   native       —— [M]/[Z]/[S] 里有类型码，且数据段写法也能查证 → 本生成器输出 B 指令
//   bitmap       —— 无可用原生指令（或 b 家族参数语法查证不到）→ 只能靠 GW 点阵下发
//   previewOnly  —— 手册里有「像那么回事」的指令/类型码，但关键语法（FNC1 转义、校验算法归属）
//                   查证不到，硬编会静默出错码 → 本生成器**不输出**，只 warning
//   no-evidence  —— 手册/类型码表/第三方命令表里根本找不到这条指令 → 本生成器**不输出**，只 warning
// 映射到矩阵 epl 列：native→native、bitmap→bitmap、previewOnly 与 no-evidence 都→previewOnly。
// 唯一需要手工处理的一行：ITF14 —— 它有指令但不等价，矩阵应标 **degraded**（本表没有该枚举值）。
// =============================================================================
export type EplSymStatusKind = 'native' | 'bitmap' | 'previewOnly' | 'no-evidence';
export interface EplSymStatus {
  status: EplSymStatusKind;
  /** 实际下发的指令（native=B 的类型码；bitmap=图形指令）；不输出时省略 */
  command?: string;
  note: string;
}

export const EPL_SYM_STATUS: Record<string, EplSymStatus> = {
  // --------------------------- 一维 ---------------------------
  CODE128: {
    status: 'native', command: "B p4='1'",
    note: "[Z]/[M] Table 2-1 'Code 128 auto A,B,C modes'='1'；p5 窄条 1–10 点；p6 固件固定（P6=N）",
  },
  CODE39: {
    status: 'native', command: "B p4='3' / '3C'",
    note: "[Z]/[M] Table 2-1 'Code 39 standard/extended'='3'，带校验位='3C'；p5 1–10 点；p6 宽条可设定",
  },
  CODE93: {
    status: 'native', command: "B p4='9'",
    note: "[Z]/[M] Table 2-1 'Code 93'='9'；符号本身自带校验字符，EPL 无「自动加校验」的独立类型码",
  },
  EAN13: {
    status: 'native', command: "B p4='E30'",
    note: "[Z]/[M] Table 2-1 'EAN13'='E30'（+2='E32'、+5='E35' 本版不输出）；p5 只能 2–4 点；末位校验位由打印机生成",
  },
  EAN8: {
    status: 'native', command: "B p4='E80'",
    note: "[Z]/[M] Table 2-1 'EAN8'='E80'（+2='E82'、+5='E85' 本版不输出）；p5 只能 2–4 点",
  },
  UPC: {
    status: 'native', command: "B p4='UA0'",
    note: "[Z]/[M] Table 2-1 'UPC-A'='UA0'（+2='UA2'、+5='UA5'）；p5 只能 2–4 点",
  },
  UPC_A: {
    status: 'native', command: "B p4='UA0'",
    note: "[Z]/[M] Table 2-1 'UPC-A'='UA0'：UPC 的别名行，与 UPC 同一类型码（normSym 不把 UPC_A 归一到 UPC，所以单独留一行）",
  },
  UPC_E: {
    status: 'native', command: "B p4='UE0'",
    note: "[Z]/[M] Table 2-1 'UPC-E'='UE0'（+2='UE2'、+5='UE5'）；位数与零压缩规则在可引用资料里没有明确说法，故只做纯数字体检",
  },
  ITF: {
    status: 'native', command: "B p4='2' / '2C' / '2D'",
    note: "[Z]/[M] Table 2-1 'Interleaved 2 of 5'='2'，带 mod10 校验='2C'，带可读校验位='2D'；p5 1–10 点、p6 可设定",
  },
  ITF14: {
    status: 'native', command: "B p4='2'",
    note: "矩阵请标 **degraded**：[Z]/[M] Table 2-1 与 [N] 的线性码清单都没有 ITF-14 类型码，"
      + '用交叉二五码 `2` 承载 —— 编码数据链（GTIN-14）一致，但没有 ITF-14 的边框/承载标记，外观与预览不同',
  },
  CODABAR: {
    status: 'native', command: "B p4='K'",
    note: "[Z]/[M] Table 2-1 'Codabar'='K'；p6 宽条可设定",
  },
  GS1_128: {
    status: 'previewOnly',
    note: "[Z]/[M] Table 2-1 有 'UCC/EAN 128'='1E'，但数据段里 FNC1（符号起始）与变长 AI 之后的 "
      + "GS 分隔符怎么写在 [M]/[Z]/[S]/[N] 里都查不到；按 (AI) 原样塞进 `1E` 会静默打成普通 Code128 结构"
      + "（扫描结果与预览不一致且看不出来），因此本版不输出。coordinator 提的 `b1`+`{G}`+`&` 写法"
      + "在上述资料里同样查不到（EPL2 的 `b` 是 2D 家族：DataMatrix p.3-20 / MaxiCode p.3-25 / PDF417 p.3-29）",
  },
  MSI: {
    status: 'previewOnly',
    note: "[Z]/[M] Table 2-1 只有 'M'（MSI-3，带 Mod10 校验）与 'L'（Plessey/MSI-1，带 Mod10 校验）："
      + "校验算法被类型码写死，与本产品 MSI + MSI10/MSI11 的组合不是同一符号，不能拿来顶替",
  },
  PHARMACODE: {
    status: 'no-evidence',
    note: '手册无此指令：[Z]/[M] Table 2-1 与 [N] 的 EPL 码清单都没有 PHARMACODE',
  },
  CODE16K: {
    status: 'no-evidence',
    note: '手册无此指令：[Z]/[M] Table 2-1 与 [N] 的 EPL 码清单都没有 Code 16K（[M] 另有 oW/Customize Bar Code Parameters p.3-82，但它不是 Code16K 的定义）',
  },

  // --------------------------- 二维（全部走 GW 点阵）---------------------------
  QRCODE: {
    status: 'bitmap', command: 'GW',
    note: '[M] 目录里 b(2D) 只有 DataMatrix p.3-20 / MaxiCode p.3-25 / PDF417 p.3-29 三节，'
      + '没有 QR 专页；[N] 的第三方实现把 QR 也归进 b 族，但参数级语法（模式、纠错等级、放大系数、'
      + '数据定界）查不到 → 不打 b，用 bwip-js 点阵经 GW（p.3-62）下发',
  },
  MICROQR: {
    status: 'bitmap', command: 'GW',
    note: '同 QRCODE：[M] 目录（b 家族 p.3-20/3-25/3-29）与 [N] 的命令清单里都没有 Micro QR 的条目，'
      + '参数语法更无从引用 → 只能 GW 点阵',
  },
  DATAMATRIX: {
    status: 'bitmap', command: 'GW',
    note: '[M] p.3-20 有「b Command - 2D Bar Code - Data Matrix Specific Options」——指令族存在，'
      + '但本版没抄到 b 的参数级语法（含矩形 DataMatrix 的尺寸设定）→ GW 点阵',
  },
  DATAMATRIX_RECT: {
    status: 'bitmap', command: 'GW',
    note: '同 DATAMATRIX：[M] p.3-20 的 b(DataMatrix) 专页有指令族但语法不可引用，矩形尺寸（8×18/8×32/12×26）'
      + '更没有任何参数依据 → GW 点阵',
  },
  PDF417: {
    status: 'bitmap', command: 'GW',
    note: '[M] p.3-29 有「b Command - 2D Bar Code - PDF417 Specific Options」（Rev. D 前言还提到改进了 '
      + 'PDF-417 数据压缩说明），但行数/列比/安全级的参数写法未抄到 → GW 点阵',
  },
  AZTEC: {
    status: 'bitmap', command: 'GW',
    note: '机型规格（如 ZT211/ZT231 的 EPL 码制清单）里列了 Aztec，[M] 目录却没有 Aztec 专页、'
      + '[N] 也未给出参数语法 → GW 点阵',
  },
};

/**
 * 精确原因（口径：先说「手册有没有这条指令」，再说「本产品暂未覆盖」，
 * 避免出现「已按 QRCODE 输出」而实际跳过的自相矛盾提示）。
 * 数据源就是 EPL_SYM_STATUS，因此审计表与运行时提示永远一致。
 */
function eplUnsupportedReason(sym: string): string {
  const st = EPL_SYM_STATUS[sym];
  if (st) return st.note;
  return EPL_BARCODE_TYPES[sym]
    ? `${sym} 未列入本版本已复核的类型码表`
    : `${sym} 不在 EPL2 类型码表（[M] Table 2-1）内，也不在 UI 码制全集内`;
}

// =============================================================================
// EAN/UPC 位数体检（只用于「查得到明确位数规则」的码制；UPC_E 未查证到 → 不查）
// =============================================================================
const EAN_UPC_DIGITS: Record<string, [number, number]> = {
  EAN8: [7, 8],       // [Z]：E80 与 EAN13 同为「末位校验位由打印机生成」
  EAN13: [12, 13],    // [Z]
  UPC: [11, 12],      // 与 EAN13 同族（UPC-A 数据 11 位 + 校验 1 位）
  UPC_A: [11, 12],
};

/** EAN/UPC 家族（纯数字符号）才做字符与位数体检；其它码制数据是字母数字混合，不能这么查 */
const EAN_UPC_FAMILY = new Set(['EAN8', 'EAN13', 'UPC', 'UPC_A', 'UPC_E']);

// =============================================================================
// 文本字体表（[Z] A 指令 p4 字体表，抄自 [M]）
//   单字节拉丁字体：1 8×12 / 12×20，2 10×16 / 16×28，3 12×20 / 20×36，
//                   4 14×24 / 24×44，5 32×48 / 48×80（点，203dpi / 300dpi）
//   6、7：Numeric Only 14×19（本版不用：只允许数字的字体遇到字母是固件未定义行为）
//   8、9：亚洲机型双字节字体（8=简体中文/日文/韩文 24×24 @203dpi、36×36 @300dpi；
//          9=繁体中文/日文）—— 依赖机型字库，见 CJK warning
// =============================================================================
interface EplFont { font: number; w203: number; h203: number; w300: number; h300: number; }
const EPL_LATIN_FONTS: EplFont[] = [
  { font: 1, w203: 8, h203: 12, w300: 12, h300: 20 },
  { font: 2, w203: 10, h203: 16, w300: 16, h300: 28 },
  { font: 3, w203: 12, h203: 20, w300: 20, h300: 36 },
  { font: 4, w203: 14, h203: 24, w300: 24, h300: 44 },
  { font: 5, w203: 32, h203: 48, w300: 48, h300: 80 },
];
/** 亚洲双字节字体（[Z] A 指令字体表「亚洲打印机」段；p3 也改用 4–7） */
const EPL_FONT_CJK = 8;

/** CJK 汉字 + CJK 标点 + 全角形式；与 print.controller 的 CJK 判定口径一致（略宽，含全角） */
const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

// =============================================================================
// GS1 (AI) 最小解析 —— 只用于把 warning 写清楚，**不参与任何输出决策**
//   口径与 core/gs1.ts 一致（本文件按自包含要求不 import）：
//   GS1 General Specifications 5.4.6 / ISO/IEC 15418：符号起始必须是 FNC1；
//   定长 AI 之后不加 FNC1；变长 AI 之后若还有下一个 AI 必须加 FNC1（GS）分隔。
//   未知 AI 一律按变长处理（保守）。
// =============================================================================
const GS1_FIXED_AI: Record<string, number> = {
  '00': 18, '01': 14, '02': 14,
  '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2,
  '410': 13, '411': 13, '412': 13, '413': 13, '414': 13, '415': 13,
  '7001': 13, '7002': 3, '7006': 4, '7007': 4, '7021': 3,
  '8006': 18, '8010': 8, '8011': 6, '8012': 12, '8013': 8, '8016': 12, '8017': 12,
  '8018': 18, '8019': 10, '8026': 13, '8031': 8, '8035': 4, '8037': 4, '8042': 2,
  '8043': 4, '8044': 4, '8046': 18, '8052': 14, '8053': 14, '8057': 14, '8059': 14,
  '8061': 6, '8074': 10, '8102': 4, '8103': 6, '8107': 2, '8110': 13, '8112': 4, '8113': 3,
};

/** 该 AI 是否定长（31nn–36nn 这类「前缀 + 6 位」计量 AI 按定长处理） */
function gs1AiFixed(ai: string): boolean {
  if (/^[34][1-6]\d{2}$/.test(ai) && !ai.startsWith('41')) return true;
  return GS1_FIXED_AI[ai] !== undefined;
}

/**
 * 扫描 (AI) 结构，返回一句人话诊断。变长 AI 后面还有字段时，EPL2 必须插入 FNC1 分隔 ——
 * 而这正是本版查证不到的写法，所以这句话也是「为什么不敢打」的直接证据。
 */
function gs1AiDiagnosis(content: string): string {
  const s = String(content ?? '');
  const hits = [...s.matchAll(/\((\d{2,4})\)/g)].map((m) => m[1]);
  if (!hits.length && !s.includes('\u001d')) return '';
  const variable: string[] = [];
  const fixed: string[] = [];
  hits.forEach((ai) => (gs1AiFixed(ai) ? fixed : variable).push(ai));
  const parts: string[] = [];
  if (hits.length) parts.push(`检出 ${hits.length} 个 (AI)`);
  if (fixed.length) parts.push(`定长 ${fixed.join('/')}`);
  if (variable.length) parts.push(`变长 ${variable.join('/')}（其后若还有字段必须插 FNC1/GS 分隔）`);
  if (s.includes('\u001d')) parts.push(`数据里已有 ${s.split('\u001d').length - 1} 个 GS(0x1D) 分隔符`);
  return parts.join('，');
}

// =============================================================================
// 对外入口
// =============================================================================

/**
 * 生成一整张标签的 EPL2（页头 + 元素 + P）。
 * 同步、不抛异常；表达不了的元素一律 warning + 跳过，绝不编造指令、绝不换码制。
 *
 * @param els         元素列表（与 ZPL/TSPL 生成器同一套 type 口径）
 * @param dpi         打印机分辨率（203 / 300 常见；非法值按 203 换算并 warning）
 * @param page        页面参数（宽/高/间距 mm + density/speed/copies）
 * @param orientation 走纸方向；给了就以它为准（覆盖 page.orientation）
 */
export function generateEpl(
  els: EplElement[],
  dpi: number,
  page: EplPage,
  orientation?: 0 | 90 | 180 | 270,
): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const body: string[] = [];
  // dpi 缺失/非法时按 203dpi 换算（EPL2 桌面机主流分辨率，与 barcode-geometry 同一缺省）
  const d = Number.isFinite(Number(dpi)) && Number(dpi) > 0 ? Number(dpi) : 203;
  if (d !== Number(dpi)) warnings.push(`[版式] dpi ${dpi} 无效，已按 ${d}dpi 换算坐标`);

  const list = Array.isArray(els) ? els : [];
  for (const e of list) {
    const x = dots(e?.xMm, d);
    const y = dots(e?.yMm, d);
    switch (e?.type) {
      case 'text':
        emitText(body, warnings, e, d, x, y);
        break;
      case 'barcode':
        emitBarcode(body, warnings, e, d, x, y);
        break;
      case 'qrcode':
        emit2d(body, warnings, e, d, x, y);
        break;
      case 'image':
        emitImage(body, warnings, e, d, x, y);
        break;
      case 'box':
      case 'line':
      case 'ellipse':
        emitVector(warnings, e);
        break;
      default:
        warnings.push(`[版式] 未知的元素类型 ${String(e?.type)}，该元素已跳过输出`);
    }
  }

  const ori = orientation ?? page?.orientation ?? 0;
  return { text: assemble(warnings, body, d, page, ori), warnings };
}

/** mm → dots，且把 NaN/Infinity 收敛成 0：指令里出现 "NaN" 会让整份作业被固件丢掉 */
function dots(mm: number | undefined, dpi: number): number {
  const v = mmToDots(Number(mm), dpi);
  return Number.isFinite(v) ? v : 0;
}

/** 角度 → A/B 指令的 p3 旋转值（[Z]：0/1/2/3 = 0°/90°/180°/270°） */
function rotParam(rotation: number | undefined): number {
  const deg = Number(rotation);
  if (!Number.isFinite(deg)) return 0;
  const idx = Math.round((((deg % 360) + 360) % 360) / 90);
  return idx > 3 ? 0 : idx;
}

// =============================================================================
// 页头 / 页尾
// =============================================================================

/**
 * 组装整段作业：`N` → `q` → `Q` →（`Z`/`D`/`S`）→ 元素 → `P`。
 * 行尾用 CR LF；开头的 LF 与结尾的 CR 是手册/样本要求的：[M] N 指令建议前面补一个换行，
 * [Z] 的示例代码在 N 之前先写 char(13)+char(10) 并注「此行为激活命令N」，
 * 且 P 之后必须再给一个回车，否则最后一张不出纸（[E]/[G] 的真实作业同样以 CR LF 收尾）。
 */
function assemble(
  warnings: string[], body: string[], dpi: number, page: EplPage, ori: number,
): string {
  const lines: string[] = ['N']; // [M] N Command - Clear Image Buffer（p.3-73）

  const w = dots(page?.widthMm, dpi);
  const h = dots(page?.heightMm, dpi);
  if (!(w > 0) || !(h > 0)) {
    warnings.push(`[版式] 页面尺寸无效（${page?.widthMm}×${page?.heightMm}mm），q/Q 仍按 ${w}×${h} 点输出，固件可能拒打整份作业`);
  }
  lines.push(`q${w}`);                                   // [M] q Command - Set Label Width（p.3-89），单位点
  const gap = dots(page?.gapMm ?? 2, dpi);
  lines.push(`Q${h},${gap}`);                            // [M] Q Command - Set Form Length（p.3-91）：长度,间距（点）；[Z]「Q240,24=30mm 标签、3mm 间距」

  if (ori === 180) lines.push('ZB');                     // [Z]「ZB 打印方向为旋转 180 度」；[M] Z Command - Print Direction（p.3-122）
  else if (ori === 90 || ori === 270) {
    // 不猜：[M] Z 指令只切换打印方向，可引用资料只抄到 ZB/ZT 两个取值，没有 90°/270° 走纸路径的等价命令
    warnings.push('[版式] 走纸方向 90°/270° 无对应的 EPL2 设置（[M] p.3-122 Z 指令，[Z] 抄录的取值只有 ZB/ZT），已忽略该设置；需要横打请用元素的 rotation（A/B 的 p3=1/3）');
  }

  if (Number.isInteger(page?.density)) {
    lines.push(`D${page.density}`);                      // [M] D Command - Density（p.3-40）；[Z]「D10 设置打印深度」，上限依机型，故不钳制
  } else if (page?.density !== undefined) {
    warnings.push(`[版式] density ${page.density} 不是整数，D 指令已忽略`);
  }
  if (Number.isInteger(page?.speed) && (page.speed as number) >= 0) {
    lines.push(`S${page.speed}`);                        // [M] S Command - Speed Select（p.3-97）；[Z]「S2 打印速度」，范围依机型
  } else if (page?.speed !== undefined) {
    warnings.push(`[版式] speed ${page.speed} 不是非负整数，S 指令已忽略`);
  }

  lines.push(...body);

  const copies = Number.isFinite(page?.copies) ? Math.max(1, Math.round(page.copies as number)) : 1;
  lines.push(`P${copies}`);                              // [M] P Command - Print（p.3-87）；[E]/[G] 实际作业写 P1、P{copies},1

  // 开头的换行：见上方 [M]/[Z] 注记
  return '\r\n' + lines.join('\r\n') + '\r\n';
}

// =============================================================================
// 文本：A p1,p2,p3,p4,p5,p6,p7,"DATA"
//   p1/p2 起点（点）、p3 旋转、p4 字体、p5 水平膨胀(1–6,8)、p6 垂直膨胀(1–9)、
//   p7 N 正常 / R 反白 —— [M] A Command - ASCII Text（p.3-4）；语法与取值范围据 [Z] 抄录，
//   与 [S]（"p5 accepts 1,2,3,4,5,6 & 8"、"p6 accepts values from 1 to 9"）互证。
//   末尾的 "DATA" 是语法必选项（[S] p.2-4），不允许省略 —— 见文件头「数据字段永不省略」。
// =============================================================================
function emitText(out: string[], warnings: string[], e: EplElement, dpi: number, x: number, y: number): void {
  const raw = String(e.text ?? '');
  if (!raw.trim()) return; // 空文本不产生指令（与 zpl/tspl 生成器一致）

  if (e.bold) warnings.push('[字体] A 指令无粗体参数（[M]/[Z] 只有膨胀 p5/p6 与反白 p7），已按常规字重输出');
  if (e.align && e.align !== 'L') warnings.push(`[字体] A 指令从起点向右排版，无 ${e.align} 对齐参数（[M] p.3-4 未提供对齐），已按左对齐输出`);

  // 旋转：0/1/2/3 = 0°/90°/180°/270°（[Z] A 指令 p3；亚洲双字节字体改用 4–7，见 [Z]「4-7是针对亚洲字体的设置」）
  const rotIdx = rotParam(e.rotation);

  const hMm = Number(e.fontHeightMm) > 0 ? Number(e.fontHeightMm) : 3;
  const wMm = Number(e.fontWidthMm) > 0 ? Number(e.fontWidthMm) : hMm * 0.6;
  const wantH = Math.max(1, dots(hMm, dpi));
  const wantW = Math.max(1, dots(wMm, dpi));
  const hasCjk = CJK_RE.test(raw);
  const nonAscii = /[^\x00-\x7f]/.test(raw);

  let font: number;
  let fw: number;
  let fh: number;
  let p3: number;
  if (hasCjk) {
    // 双字节字体：203dpi 24×24、300dpi 36×36（[Z] 字体表「亚洲打印机」段）
    font = EPL_FONT_CJK;
    fw = fh = dpi > 203 ? 36 : 24;
    p3 = rotIdx + 4;
    warnings.push(
      `[字体] 文本含中日韩字符，已改用 A 指令的双字节字体 p4=${font}（[Z] 字体表：亚洲机型 203dpi 24×24 点）：`
      + '该字体只在带亚洲字库的机型上有字形，且数据段必须是打印机码页（GBK/GB18030 或 BIG5）的字节——'
      + '按 UTF-8 直发会变乱码，下发通道需转码。无字库/无法转码时请改用 ZPL(^CI28) 或 protocol=image 图像通道',
    );
  } else {
    font = pickLatinFont(wantH, dpi);
    const f = EPL_LATIN_FONTS.find((it) => it.font === font)!;
    const metric = dpi > 203 ? { w: f.w300, h: f.h300 } : { w: f.w203, h: f.h203 };
    fw = metric.w; fh = metric.h;
    p3 = rotIdx;
    if (nonAscii) {
      warnings.push(`[字体] 文本含非 ASCII 字符：A 指令的 DATA 按打印机码页解释（[M] p.3-4 未定义统一 Unicode 入口，附录 A 只给默认 Code 437 字符表），实际字形依机型码页而定，建议改用 protocol=image 或 ZPL(^CI28)`);
    }
  }

  const my = clampExpand(Math.round(wantH / fh), 1, 9, '垂直膨胀 p6', warnings);
  const mx = clampXExpand(Math.round(wantW / fw), warnings);
  const p7 = e.colorInvert ? 'R' : 'N'; // [Z][S] p7：N 普通 / R 反白（白字黑底）

  out.push(`A${x},${y},${p3},${font},${mx},${my},${p7},"${eplData(raw, warnings, 'A')}"`);
}

/** 选最接近目标高度的内置拉丁字体（[Z] 字体表 1–5） */
function pickLatinFont(hDots: number, dpi: number): number {
  let best = EPL_LATIN_FONTS[0];
  let bestErr = Infinity;
  for (const f of EPL_LATIN_FONTS) {
    const h = dpi > 203 ? f.h300 : f.h203;
    const err = Math.abs(h - hDots) / Math.max(1, hDots);
    if (err < bestErr) { bestErr = err; best = f; }
  }
  return best.font;
}

/** p6 垂直膨胀取值 1–9（[S]）；越界钳制并说明 */
function clampExpand(v: number, min: number, max: number, what: string, warnings: string[]): number {
  const n = Math.max(min, Math.min(max, Math.round(Number.isFinite(v) ? v : min)));
  if (n !== Math.round(v)) warnings.push(`[字体] ${what} ${v} 超出 EPL2 允许范围 ${min}–${max}（[S]），已钳到 ${n}`);
  return n;
}

/** p5 水平膨胀取值是「1–6 与 8」（[S] 原文 "Accepts the values 1, 2, 3, 4, 5, 6, & 8"），没有 7 */
function clampXExpand(v: number, warnings: string[]): number {
  const n = Math.max(1, Math.round(Number.isFinite(v) ? v : 1));
  if (n === 7) {
    warnings.push('[字体] 水平膨胀 p5 的合法取值是 1–6 与 8（[S]），无 7 档，已抬到 8（字宽比目标约 +14%）');
    return 8;
  }
  if (n > 8) {
    warnings.push('[字体] 水平膨胀 p5 上限 8 档（[S]），已钳到 8；如需更宽的字请改用位图通道');
    return 8;
  }
  return n;
}

/**
 * DATA 段（A/B 共用）：EPL2 用双引号包字符串，[M]/[Z]/[S] 都没抄到引号或反斜杠的转义写法，
 * 所以只能「去掉会截断指令的字符 + 如实告知」，不允许猜一套转义规则。
 * 返回值即使为空串也一定会被写成 `""` 放进指令里（数据字段永不省略）；
 * 内容为空的元素在调用方就被跳过了，不会走到「有指令无数据」这一步。
 */
function eplData(s: string, warnings: string[], cmd: 'A' | 'B'): string {
  let out = String(s ?? '');
  if (out.includes('"')) {
    warnings.push(`[数据] ${cmd} 指令的数据含双引号：" 是 EPL2 DATA 段的定界符，而 [M]/[Z]/[S] 未给出引号转义写法，已把 " 替换为 ' 以保证指令不被截断`);
    out = out.replace(/"/g, "'");
  }
  const cleaned = out.replace(/[\r\n\t\x00-\x08\x0b-\x1f]/g, '');
  if (cleaned !== out) {
    warnings.push(`[数据] ${cmd} 指令的数据含换行/制表等控制字符，已剔除（EPL2 指令以 CR LF 分行，控制字符会截断后续指令）`);
  }
  return cleaned;
}

// =============================================================================
// 一维码：B p1,p2,p3,p4,p5,p6,p7,p8,"DATA"
//   p1/p2 起点（点）、p3 旋转（0–3，同 A）、p4 类型码（Table 2-1）、
//   p5 窄条点宽（范围见 Table 2-1 右列）、p6 宽条点宽（2–30）、
//   p7 条码高度（点）、p8 可读文本 B=打印在条码下方 / N=不打印 —— [M] B Command - Bar Code
//   （p.3-11）；参数逐项取自 [Z]/[S] 抄录。实际作业写法样本见 [E]
//   （`B85,29,0,3,2,5,60,B,V01`）与 [Z] 的 EAN13 例子（`B240,80,0,E30,3,6,126,B,"123456789012"`）。
// =============================================================================
function emitBarcode(out: string[], warnings: string[], e: EplElement, dpi: number, x: number, y: number): void {
  const b: BarcodeSpec | undefined = e.barcode;
  if (!b) { warnings.push('[码制] barcode 元素缺少 spec，该元素已跳过输出'); return; }
  const sym = normSym(b.sym);
  if (!String(b.content ?? '').trim()) {
    warnings.push(`[数据] ${sym || '(未指定码制)'} 条码内容为空，已跳过该元素：省略数据段的 B 指令依固件可能打印上一次缓存的符号（本生成器的规则是内容为空 ⇒ 整条元素不打，绝不发 B...,""）`);
    return;
  }
  const def = EPL_BARCODE_TYPES[sym];

  if (!def) {
    warnings.push(
      `[码制] EPL 无法原生输出 ${sym}：${eplUnsupportedReason(sym)}。`
      + (sym === 'GS1_128' ? `本条数据的 (AI) 结构：${gs1AiDiagnosis(String(b.content ?? '')) || '未检出 (AI)' }。` : '')
      + `该元素已跳过输出。建议：①改用 ZPL（^B 家族覆盖更广）或 TSPL 协议；`
      + `②protocol=image 让后端走 bwip-js 位图下发（EPL 侧对应 ${EPL_GRAPHIC_COMMAND} 图形指令，需预置点阵）；`
      + `③换成业务上等效的常见码制（如 GS1_128 的定长数据可评估直接用 CODE128 承载）`,
    );
    return;
  }

  // 几何：模块宽/宽条/高度与预览同一份量化规则（本文件内联实现，见 geometry1d 上方注释）
  const geo = geometry1d(sym, dpi, b);
  warnings.push(...geo.warnings);

  const narrow = clampNarrow(geo.narrow, def, sym, warnings);
  // 宽条宽直接取几何量化后的结果（固定比例码制里它等于窄条，Code128 家族已按整数模块取整）
  const wide = clampWide(Math.max(narrow, geo.wide), narrow, warnings);
  if (!def.wideSettable) {
    warnings.push(`[参数] ${sym} 在 EPL2 里 p6（宽条宽）为固件固定值（[Z] Table 2-1 的 P6 列为 N），指令里仍按 ${wide} 点给出但会被打印机忽略，实际宽窄比以符号规范为准`);
  }
  const height = Math.max(1, geo.height);

  const type = resolveType(sym, b, def, warnings);
  const p3 = rotParam(e.rotation);
  const p8 = b.showText ? 'B' : 'N'; // [Z][S] p8：B=打印条码下方可读文本，N=不打印
  if (b.showText && b.textPosition === 'top') {
    warnings.push(`[参数] ${sym} 要求可读文本置顶，但 A/B 指令族里 p8 只有 B（打印在条码下方）与 N（不打印）两种取值（[Z]/[S]），已按下方输出`);
  }

  const data = validateNumeric(sym, b.content, warnings);
  if (data === undefined) return; // 位数/字符集明显不合规范：已 warning，跳过该元素

  out.push(`B${x},${y},${p3},${type},${narrow},${wide},${height},${p8},"${eplData(data, warnings, 'B')}"`);
  if (def.degraded) warnings.push(`[码制] ${sym}：${def.degraded}（类型码 \`${type}\`，${def.cite}）`);
}

/** p5 窄条点宽：Table 2-1 右列给出的范围之外一律钳制并说明 */
function clampNarrow(v: number, def: EplSymDef, sym: string, warnings: string[]): number {
  let n = Math.round(Number.isFinite(v) ? v : def.narrowMin);
  if (n < def.narrowMin) {
    warnings.push(`[参数] ${sym} 窄条宽 ${n} 点低于 EPL2 p5 下限 ${def.narrowMin} 点（${def.cite}），已抬到 ${def.narrowMin} 点`);
    n = def.narrowMin;
  }
  if (n > def.narrowMax) {
    warnings.push(`[参数] ${sym} 窄条宽 ${n} 点超出 EPL2 p5 上限 ${def.narrowMax} 点（${def.cite}），已钳到 ${def.narrowMax} 点；如仍嫌窄请缩小模块宽（X-dim）设定`);
    n = def.narrowMax;
  }
  return n;
}

/** p6 宽条点宽：[S]/[Z] 给出取值范围 2–30，且必须 ≥ 窄条 */
function clampWide(v: number, narrow: number, warnings: string[]): number {
  let n = Math.round(v);
  if (n < Math.max(2, narrow)) n = Math.max(2, narrow);
  if (n > 30) {
    warnings.push('[参数] 宽条宽 30 点是 EPL2 p6 的上限（[S]/[Z]），已钳到 30 点；如需更大宽窄比请改用固定比例码制或位图通道');
    n = 30;
  }
  return n;
}

/** 类型码解析：要求校验位时只有在 Table 2-1 里确实存在「带校验位」类型码时才换 */
function resolveType(sym: string, b: BarcodeSpec, def: EplSymDef, warnings: string[]): string {
  if (b.checksum !== true) return def.type;
  if (def.checkType) {
    warnings.push(`[校验位] ${sym} 已改用带校验位的 EPL2 类型码 \`${def.checkType}\`（${def.cite}）：扫描结果会比预览数据多一位，确认下游按带校验位解析`);
    return def.checkType;
  }
  warnings.push(`[校验位] ${sym} 在 EPL2 类型码表里没有「自动加校验位」的独立类型码（${def.cite}），已按 \`${def.type}\` 输出：Code128/Code93 等符号本身含强制性校验字符，但 EAN/UPC 请自行确认数据末位校验位是否与预览一致`);
  return def.type;
}

/**
 * EAN/UPC 位数体检：[Z]「EAN13 码最后一位自动生成」→ 12 位（数据）或 13 位（已带校验位）都收。
 * UPC_E 的位数与零压缩规则没在可引用资料里查到明确说法，因此只做「必须是纯数字」这一项。
 */
function validateNumeric(sym: string, content: string, warnings: string[]): string | undefined {
  const s = String(content ?? '');
  if (!EAN_UPC_FAMILY.has(sym)) return s;
  if (!/^\d+$/.test(s)) {
    warnings.push(`[码制] ${sym} 数据含非数字字符：EAN/UPC 是纯数字符号，已跳过该元素以保证标签其余部分正常打印`);
    return undefined;
  }
  const range = EAN_UPC_DIGITS[sym];
  if (range && (s.length < range[0] || s.length > range[1])) {
    warnings.push(`[码制] ${sym} 数据为 ${s.length} 位，EPL2 该类型码要求 ${range[0]}–${range[1]} 位（[Z]：末位校验位由打印机自动生成），已跳过该元素`);
    return undefined;
  }
  return s;
}

// =============================================================================
// 二维码（QRCODE / DATAMATRIX / PDF417 / AZTEC / MICROQR …）
//   [M] 目录里有 b Command - 2D Bar Code（DataMatrix p.3-20、MaxiCode p.3-25、PDF417 p.3-29），
//   [N] 的第三方实现清单还把 QR Code / Aztec 也归到 b 里 —— 说明 EPL2 有二维指令族，
//   但**参数级语法（模式/纠错/放大系数怎么写、数据怎么定界）在所有可引用资料里都没抄到**，
//   而 Rev. D 目录里没有 QR 专页（QR 走的是哪条 b 变体无法确定）。
//   → 结论：本版不打 b，只走 GW 位图通道；没有点阵时给可执行的修复建议。
// =============================================================================
function emit2d(out: string[], warnings: string[], e: EplElement, dpi: number, x: number, y: number): void {
  const q: QrcodeSpec | undefined = e.qrcode;
  if (!q) { warnings.push('[码制] qrcode 元素缺少 spec，该元素已跳过输出'); return; }
  const sym = normSym(q.sym ?? 'QRCODE');

  if (!e.fallback) {
    warnings.push(
      `[码制] EPL 无法原生输出 ${sym}：EPL2 的二维指令是 b（[M] p.3-20/3-25/3-29，[N] 清单还含 QR/Aztec），`
      + `但参数级语法（模式、纠错等级、放大系数、数据定界）在可引用资料里查不到，硬编会把整块标签打废，`
      + `因此本版不打 b 指令；本元素又没有预置位图点阵（fallback），已跳过输出。`
      + `建议：①改用 ZPL 或 TSPL 协议（QR 有可引用的原生指令 ^BQ / QRCODE）；`
      + `②protocol=image 让后端预生成 bwip-js 点阵，再由 EPL 的 ${EPL_GRAPHIC_COMMAND} 图形指令下发（可扫，但不是打印机原生符号）`,
    );
    return;
  }
  out.push(eplGraphic(e.fallback, x, y, dpi, warnings, sym));
}

/** image 元素：与二维码同一图形通道 */
function emitImage(out: string[], warnings: string[], e: EplElement, dpi: number, x: number, y: number): void {
  if (!e.fallback) {
    warnings.push('[图像] image 元素未预置点阵数据（调用方未走位图通道），该元素已跳过。建议：确认经 /print/commands 或 RawTcpProvider 打印（这两条路径会预生成点阵），或改用 protocol=image');
    return;
  }
  out.push(eplGraphic(e.fallback, x, y, dpi, warnings, 'image'));
}

// =============================================================================
// 图形（位图）指令
//   GW p1,p2,p3,p4,<原始二进制数据>
//     p1 x（点）、p2 y（点）、p3 **每行字节数**、p4 **行数**、其后是 bytesPerRow×rows 个原始字节。
//   依据：[M] GW Command - Direct Graphic Write（p.3-62）；[E] 的真实作业写 `GW0, 535 , 3 , 64`；
//   [G] 的多份 C# 实现完全一致：`GW{0},{1},{每行实际字节数},{图高行数},{iso-8859-1(字节缓冲)}`，
//   且整行以 CR LF 结束（本文件的行连接由 assemble 统一用 CR LF，故 GW 行后面自带结束符）。
//   宽高单位：widthBytes = bytesPerRow、rows = heightDots（与 core/bitmap-blocks.ts 的
//   eplGraphicSize() 同一结论，本文件内联实现）。
//
//   ⚠️ DATA 是**原始字节**（latin1/逐字节），不是 ASCII hex：[G] 的实现把字节按
//      Encoding("iso-8859-1"/latin1) 直接塞进指令；[M] 的图形族里只有 GG（Print Graphics）
//      与 GM（Store Graphics）是「已存图形名」引用，裸 hex 文本形态属于 CPCL 的 EG / TSPL 的 BITMAP，
//      不是 EPL 的 GW。**若按 utf8 编码下发，≥0x80 的字节会翻倍，行数×每行字节数就对不上。**
//
//   ❓ 位极性（1 代表墨还是代表白）**未查证到**：
//      · [M] p.3-62 的正文与 [E]/[G] 的样本都只给参数顺序，没有一句说 1/0 各代表什么；
//      · 反面线索：同样这几份 C# 实现里，CPCL(EG) 分支对 BMP 字节做了 `^= 0xFF` 反色，
//        EPL(GW) 分支**没有**反色，而 1bpp BMP 的默认调色板是 index0=黑 / index1=白
//        → 按这批实现推论「GW 里 1 = 白（与 BMP 存储序一致）」；
//      · 但同一份代码的 ZPL(^DG) 分支也没反色，而 ZPL 明确 1 = 黑，三者互相矛盾，
//        说明这批代码本身不足以定 polarity（且三份 EPL 实现同源，不能算独立证据）。
//      ⇒ 结论：不做猜出来的位翻转。默认与仓内 raster.packRows（1=墨，core/raster.ts:45）同向，
//        并把翻转收敛成一个常量 + 一个函数，实机验证后改这一行即可：
//        EPL_GW_POLARITY = 'mark-is-0'  // 若实机打出来是负片（黑底白码）就改成这个
// =============================================================================

/** 图形指令名：见文件头「与 coordinator 结论不一致的两点」第 1 条 */
export const EPL_GRAPHIC_COMMAND = 'GW';

/** GW DATA 的位极性；'mark-is-1' = 1 代表墨（与仓内 raster 同向），'mark-is-0' = 1 代表白 */
export type EplGwPolarity = 'mark-is-1' | 'mark-is-0';
export const EPL_GW_POLARITY: EplGwPolarity = 'mark-is-1';

/** 整串点阵 hex 按位取反（行/列序不变，输出保持仓内大写 hex 约定），供 EPL_GW_POLARITY='mark-is-0' 时使用 */
export function eplInvertHex(hex: string): string {
  const clean = String(hex ?? '').replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i < clean.length; i += 2) {
    const b = parseInt(clean.slice(i, i + 2), 16);
    out += (b ^ 0xff).toString(16).padStart(2, '0');
  }
  return out.toUpperCase();
}

/**
 * 生成一条图形指令。同步、不抛异常；长度异常时按头部声明截齐并 warning。
 * （core/bitmap-blocks.ts 的 eplGraphicSize 结论已内联：widthBytes=bytesPerRow、rows=heightDots）
 */
export function eplGraphic(
  b: EplBitmap, xDots: number, yDots: number, dpi: number, warnings: string[], label: string,
): string {
  const widthBytes = Math.max(0, Math.round(Number(b?.bytesPerRow) || 0));
  const rows = Math.max(0, Math.round(Number(b?.heightDots) || 0));
  const src = EPL_GW_POLARITY === 'mark-is-0' ? eplInvertHex(b?.hex ?? '') : String(b?.hex ?? '');
  const bytes = hexToLatin1(src);
  const expect = widthBytes * rows;
  if (bytes.length !== expect) {
    warnings.push(`[位图] ${label} 点阵数据长度异常：hex 解出 ${bytes.length} 字节，${EPL_GRAPHIC_COMMAND} 头部声明 ${widthBytes}×${rows}=${expect} 字节，已按头部声明截齐`);
  }
  const payload = bytes.slice(0, expect);
  const mm = ((Number(b?.widthDots) || 0) * 25.4 / (Number(dpi) > 0 ? Number(dpi) : 203)).toFixed(2);
  warnings.push(
    `[位图] ${label} 已用 bwip-js 点阵经 ${EPL_GRAPHIC_COMMAND} 图形指令下发（${b?.widthDots}×${b?.heightDots} 点 ≈ ${mm}mm 宽，`
    + `${widthBytes} 字节/行 × ${rows} 行，${b?.moduleDots} 点/模块，含四周静区），可扫但不是打印机原生符号；`
    + `${EPL_GRAPHIC_COMMAND} 的 DATA 是原始二进制，下发通道必须按 latin1/binary 逐字节写出（不能用 utf8，否则高位字节翻倍）；`
    + `位极性按 [${EPL_GW_POLARITY === 'mark-is-1' ? '默认 1=墨，与 raster.packRows 同向' : '翻转 1=白'}] 输出——手册未查证到该位定义，实机若打出负片请改 EPL_GW_POLARITY 一个常量`,
  );
  return `${EPL_GRAPHIC_COMMAND}${xDots},${yDots},${widthBytes},${rows},${payload}`;
}

/** ASCII hex → latin1 字符串（每个字节 1 个 char code），供图形指令原样下发 */
export function hexToLatin1(hex: string): string {
  const clean = String(hex ?? '').replace(/[^0-9a-fA-F]/g, '');
  return Buffer.from(clean, 'hex').toString('latin1');
}

// =============================================================================
// 矢量元素（框 / 线 / 椭圆）
//   [M] 目录确有 X Command - Box Draw（p.3-120）与 Line Draw 家族
//   LE p.3-68 / LO p.3-69 / LS p.3-70 / LW p.3-71，[N] 也列出这几条，
//   [E] 的真实作业里有 `LO0,78,780,2`、`LW386,0,150,79` 这种四个数的写法，
//   但「后两个数是右下角坐标还是宽高、线宽放在哪一位」在可引用资料里没有一致说法
//   （[N] 只给了命令名 Line Draw Black/Diagonal/White/Exclusive OR）。
//   → 参数含义查证不到 ⇒ 按仓库规则不输出，改出 warning。
// =============================================================================
function emitVector(warnings: string[], e: EplElement): void {
  const shape = e.type === 'box' ? '矩形框' : e.type === 'line' ? '直线' : '椭圆';
  warnings.push(
    `[图形] EPL 暂不输出${shape}（type=${e.type}）：EPL2 有 X（Box Draw，[M] p.3-120）与 `
    + 'LO/LS/LW/LE（Line Draw 家族，[M] p.3-68~3-71，[N] 命令表同名）这些指令，'
    + '但参数级几何含义（是 x1,y1,x2,y2 还是 x,y,width,height、线宽位置）在可引用资料与真实作业里说法不一致，'
    + '未查证到就不输出——猜错的指令固件不报错，会打出错图。'
    + `建议：①protocol=image 走位图通道（边框栅格化后用 ${EPL_GRAPHIC_COMMAND} 下发）；②改用 ZPL(^GB) / TSPL(BOX,BAR) 协议`,
  );
}
