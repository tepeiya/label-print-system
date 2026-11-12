// =============================================================================
// symbology.capabilities.ts —— 码制能力单一真源（Single Source of Truth）
//
// 【为什么要有这个文件】P7.2 复核暴露的根因不是"某个 case 漏了"，而是能力判定散落在
//   四处各写一份：前端 BARCODE_SYMS/QRCODE_SYMS、ZPL 的 SUPPORTED_ZPL_BARCODES、
//   TSPL 的 SUPPORTED_TSPL_BARCODES、print.controller 的 buildWarnings。
//   四处一旦漂移，就会出现"前端能选 / 预览能看 / 打印机上是错的"或"响应里两条
//   warnings 自相矛盾"。专业解法：集中声明，其余各处一律派生，不再各自维护名单。
//
// 【设计约束】
//   1. 纯 TS，不 import TypeORM / Nest（单测跑 node --test + tsx，见 docs/10 §10.15.6）。
//   2. "手册无原生指令" 与 "本产品暂未覆盖" 必须区分：前者引导换通道，后者是可排期缺口。
//   3. 能力声明同时驱动：生成器分支、warnings 文案、前端"受限"标签、验收脚本。
//   4. 不静默降级。任何降级都必须显式声明 degradeTo 并回一条 warning。
// =============================================================================

/** 支持的打印机协议（P7.7 新增 EPL） */
export type Protocol = 'zpl' | 'tspl' | 'epl' | 'image';

/** 单协议能力 */
export interface ProtocolCap {
  /** 是否有原生指令 */
  native: boolean;
  /** 原生指令助记符（用于 golden 快照与文档），无则 undefined */
  cmd?: string;
  /**
   * 手册确实没有该码制指令（true）还是本产品暂未覆盖（false）。
   * 用于生成"可执行"的修复建议，而不是笼统一句"不支持"。
   */
  noNativeInManual?: boolean;
  /** 显式降级：形状/语义会变，但可扫。必须配 warning，绝不静默 */
  degradeTo?: string;
  /** 不支持时的建议（面向用户，可执行） */
  hint?: string;
}

export interface SymbologyCap {
  /** 标准标识（大写、下划线） */
  sym: string;
  kind: 'linear' | '2d';
  /** 中文名 */
  label: string;
  /** 各协议能力；缺席的协议 = 明确不支持 */
  caps: Partial<Record<Protocol, ProtocolCap>>;
  /** bwip-js 位图通道（protocol=image / 前端预览）是否支持 */
  bitmap: boolean;
  /** 是否 GS1 语义码制（需要 FNC1） */
  gs1: boolean;
  /** 静区规范：以 X-dimension 模块数为单位 */
  quietZoneX: { left: number; right: number; top: number; bottom: number };
  /** 默认宽窄比（仅线性码有意义） */
  defaultWideRatio?: number;
  /** 高度建议系数：heightMm ≈ moduleWidthMm × heightFactor（专业系统经验值 8~12） */
  heightFactor?: number;
  /** 纠错能力（二维码） */
  ecc?: 'L/M/Q/H' | 'ECC200' | '0-8';
}

// -----------------------------------------------------------------------------
// 静区规范依据（P7.6）：
//   - EAN-13 / EAN-8 / UPC-A / UPC-E：GS1 规范左右各 ≥ 7X（含明文 guard 区），
//     上下 ≥ 1X；这里取 7/7。
//   - Code128 / Code39 / Codabar / ITF：ISO/IEC 规定左右各 ≥ 10X。
//   - ITF-14 还需 bearer bar（承重框），由生成器处理，静区仍按 10X。
//   - QR Code：ISO/IEC 18004 规定四周 4 模块；DataMatrix 四周 1 模块；
//     PDF417 四周 2 模块；Aztec 无静区要求（0）。
// -----------------------------------------------------------------------------
const QZ_LINEAR_10 = { left: 10, right: 10, top: 1, bottom: 1 };
const QZ_GS1_RETAIL = { left: 7, right: 7, top: 1, bottom: 1 };
const QZ_QR = { left: 4, right: 4, top: 4, bottom: 4 };
const QZ_DM = { left: 1, right: 1, top: 1, bottom: 1 };
const QZ_PDF417 = { left: 2, right: 2, top: 2, bottom: 2 };
const QZ_NONE = { left: 0, right: 0, top: 0, bottom: 0 };

const IMG_HINT = '改用 protocol=image 让后端走 bwip-js 位图下发（ZPL ^GF / TSPL BITMAP）';
const ZPL_HINT = '改用 ZPL 协议（^B 家族覆盖更广）';
const TSPL_HINT = '改用 TSPL 协议试试';

/**
 * 能力表：前端可选的 14 种一维 + 6 种二维 **全部**在此登记。
 * 新增码制只改这一处，生成器 / warnings / 前端标签自动跟随。
 */
export const SYMBOLOGIES: Record<string, SymbologyCap> = {
  // ------------------------------ 一维线性 ------------------------------
  CODE128:   { sym: 'CODE128', kind: 'linear', label: 'Code 128', gs1: false, bitmap: true,
    quietZoneX: QZ_LINEAR_10, defaultWideRatio: 2.0, heightFactor: 10,
    caps: { zpl: { native: true, cmd: '^BC' }, tspl: { native: true, cmd: '128' }, epl: { native: true, cmd: 'B' }, image: { native: true } } },
  GS1_128:   { sym: 'GS1_128', kind: 'linear', label: 'GS1-128 (UCC/EAN-128)', gs1: true, bitmap: true,
    quietZoneX: QZ_LINEAR_10, defaultWideRatio: 2.0, heightFactor: 10,
    // P7.4：TSPL 现在显式声明支持 FNC1（由生成器加前缀），不再只映射成普通 128
    caps: { zpl: { native: true, cmd: '^BC + FNC1' }, tspl: { native: true, cmd: '128 + FNC1' }, epl: { native: false, noNativeInManual: false, hint: 'EPL 无 FNC1 语义，建议用 ZPL/TSPL' }, image: { native: true } } },
  CODE39:    { sym: 'CODE39', kind: 'linear', label: 'Code 39', gs1: false, bitmap: true,
    quietZoneX: QZ_LINEAR_10, defaultWideRatio: 2.5, heightFactor: 10,
    caps: { zpl: { native: true, cmd: '^B3' }, tspl: { native: true, cmd: '39' }, epl: { native: true, cmd: 'B' }, image: { native: true } } },
  CODE93:    { sym: 'CODE93', kind: 'linear', label: 'Code 93', gs1: false, bitmap: true,
    quietZoneX: QZ_LINEAR_10, heightFactor: 10,
    // EPL2 手册有 Code93/ITF14/MSI 类型码，但本轮 P7.7 只落了一维主力 + QR，
    // 如实标 "暂未覆盖"（noNativeInManual=false），不谎称手册没有。
    caps: { zpl: { native: true, cmd: '^BA' }, tspl: { native: true, cmd: '93' }, epl: { native: false, noNativeInManual: false, hint: '本产品 EPL 通道暂未覆盖该码制；建议用 ZPL/TSPL 或 protocol=image' }, image: { native: true } } },
  EAN13:     { sym: 'EAN13', kind: 'linear', label: 'EAN-13', gs1: false, bitmap: true,
    quietZoneX: QZ_GS1_RETAIL, heightFactor: 10,
    caps: { zpl: { native: true, cmd: '^BE' }, tspl: { native: true, cmd: 'EAN13' }, epl: { native: true, cmd: 'B' }, image: { native: true } } },
  EAN8:      { sym: 'EAN8', kind: 'linear', label: 'EAN-8', gs1: false, bitmap: true,
    quietZoneX: QZ_GS1_RETAIL, heightFactor: 10,
    caps: { zpl: { native: true, cmd: '^B8' }, tspl: { native: true, cmd: 'EAN8' }, epl: { native: true, cmd: 'B' }, image: { native: true } } },
  UPC:       { sym: 'UPC', kind: 'linear', label: 'UPC-A', gs1: false, bitmap: true,
    quietZoneX: QZ_GS1_RETAIL, heightFactor: 10,
    caps: { zpl: { native: true, cmd: '^BU' }, tspl: { native: true, cmd: 'UPCA' }, epl: { native: true, cmd: 'B' }, image: { native: true } } },
  UPC_E:     { sym: 'UPC_E', kind: 'linear', label: 'UPC-E', gs1: false, bitmap: true,
    quietZoneX: QZ_GS1_RETAIL, heightFactor: 10,
    caps: { zpl: { native: true, cmd: '^B9' }, tspl: { native: true, cmd: 'UPCE' }, epl: { native: true, cmd: 'B' }, image: { native: true } } },
  ITF14:     { sym: 'ITF14', kind: 'linear', label: 'ITF-14', gs1: false, bitmap: true,
    quietZoneX: QZ_LINEAR_10, heightFactor: 10,
    caps: { zpl: { native: true, cmd: '^BI + bearer' }, tspl: { native: true, cmd: 'ITF14' }, epl: { native: false, noNativeInManual: false, hint: '本产品 EPL 通道暂未覆盖该码制；建议用 ZPL/TSPL 或 protocol=image' }, image: { native: true } } },
  ITF:       { sym: 'ITF', kind: 'linear', label: 'Interleaved 2 of 5', gs1: false, bitmap: true,
    quietZoneX: QZ_LINEAR_10, heightFactor: 10,
    caps: { zpl: { native: true, cmd: '^BI' }, tspl: { native: true, cmd: 'ITF' }, epl: { native: true, cmd: 'B' }, image: { native: true } } },
  CODABAR:   { sym: 'CODABAR', kind: 'linear', label: 'Codabar', gs1: false, bitmap: true,
    quietZoneX: QZ_LINEAR_10, defaultWideRatio: 2.5, heightFactor: 10,
    caps: { zpl: { native: true, cmd: '^BK' }, tspl: { native: true, cmd: 'CODABAR' }, epl: { native: true, cmd: 'B' }, image: { native: true } } },
  MSI:       { sym: 'MSI', kind: 'linear', label: 'MSI/Plessey', gs1: false, bitmap: true,
    quietZoneX: QZ_LINEAR_10, heightFactor: 10,
    caps: { zpl: { native: true, cmd: '^BM' }, tspl: { native: true, cmd: 'MSI' }, epl: { native: false, noNativeInManual: false, hint: '本产品 EPL 通道暂未覆盖该码制；建议用 ZPL/TSPL 或 protocol=image' }, image: { native: true } } },
  // 手册原生指令确实不存在的小众码制 —— 只保留位图通道，前端必须标"预览仅"
  PHARMACODE:{ sym: 'PHARMACODE', kind: 'linear', label: 'Pharmacode', gs1: false, bitmap: true,
    quietZoneX: QZ_LINEAR_10, heightFactor: 10,
    caps: { zpl: { native: false, noNativeInManual: true, hint: IMG_HINT }, tspl: { native: false, noNativeInManual: true, hint: IMG_HINT }, image: { native: true } } },
  CODE16K:   { sym: 'CODE16K', kind: 'linear', label: 'Code 16K', gs1: false, bitmap: true,
    quietZoneX: QZ_LINEAR_10, heightFactor: 10,
    caps: { zpl: { native: false, noNativeInManual: true, hint: IMG_HINT }, tspl: { native: false, noNativeInManual: true, hint: IMG_HINT }, image: { native: true } } },

  // ------------------------------ 二维 ------------------------------
  QRCODE:   { sym: 'QRCODE', kind: '2d', label: 'QR Code', gs1: false, bitmap: true,
    quietZoneX: QZ_QR, ecc: 'L/M/Q/H',
    caps: { zpl: { native: true, cmd: '^BQ' }, tspl: { native: true, cmd: 'QRCODE' }, epl: { native: true, cmd: 'QR' }, image: { native: true } } },
  MICROQR:  { sym: 'MICROQR', kind: '2d', label: 'Micro QR', gs1: false, bitmap: true,
    quietZoneX: QZ_QR,
    // TSPL 无 Micro QR 指令：显式的"降级为标准 QR"，形状变但可扫，必须回 warning
    caps: { zpl: { native: true, cmd: '^BQ model1' }, tspl: { native: false, noNativeInManual: true, degradeTo: 'QRCODE', hint: '已降级为标准 QRCODE（可扫）；要真 Micro QR 请用 ZPL' }, epl: { native: false, noNativeInManual: true, hint: IMG_HINT }, image: { native: true } } },
  DATAMATRIX:       { sym: 'DATAMATRIX', kind: '2d', label: 'Data Matrix', gs1: false, bitmap: true,
    quietZoneX: QZ_DM, ecc: 'ECC200',
    caps: { zpl: { native: true, cmd: '^BX' }, tspl: { native: false, noNativeInManual: true, hint: `${ZPL_HINT} 或 ${IMG_HINT}` }, epl: { native: false, noNativeInManual: true, hint: IMG_HINT }, image: { native: true } } },
  DATAMATRIX_RECT:  { sym: 'DATAMATRIX_RECT', kind: '2d', label: 'Data Matrix (矩形)', gs1: false, bitmap: true,
    quietZoneX: QZ_DM, ecc: 'ECC200',
    caps: { zpl: { native: true, cmd: '^BX rect' }, tspl: { native: false, noNativeInManual: true, hint: `${ZPL_HINT} 或 ${IMG_HINT}` }, epl: { native: false, noNativeInManual: true, hint: IMG_HINT }, image: { native: true } } },
  PDF417:   { sym: 'PDF417', kind: '2d', label: 'PDF417', gs1: false, bitmap: true,
    quietZoneX: QZ_PDF417, ecc: '0-8',
    caps: { zpl: { native: true, cmd: '^B2' }, tspl: { native: false, noNativeInManual: true, hint: `${ZPL_HINT} 或 ${IMG_HINT}` }, epl: { native: false, noNativeInManual: true, hint: IMG_HINT }, image: { native: true } } },
  AZTEC:    { sym: 'AZTEC', kind: '2d', label: 'Aztec', gs1: false, bitmap: true,
    quietZoneX: QZ_NONE,
    caps: { zpl: { native: true, cmd: '^BO' }, tspl: { native: false, noNativeInManual: true, hint: `${ZPL_HINT} 或 ${IMG_HINT}` }, epl: { native: false, noNativeInManual: true, hint: IMG_HINT }, image: { native: true } } },
};

/** 前端可能传的别名 → 标准标识（历史模板 / AI 生成结果里会出现） */
const ALIASES: Record<string, string> = {
  UPCA: 'UPC', 'UPC-A': 'UPC', 'UPC_A': 'UPC',
  UPCE: 'UPC_E', 'UPC-E': 'UPC_E',
  'GS1-128': 'GS1_128', 'GS1128': 'GS1_128', 'UCC128': 'GS1_128',
  'CODE-128': 'CODE128', 'CODE128A': 'CODE128', 'CODE128B': 'CODE128', 'CODE128C': 'CODE128',
  '2OF5': 'ITF', 'INTERLEAVED2OF5': 'ITF', 'I2OF5': 'ITF',
  'MSI10': 'MSI', 'MSI11': 'MSI',
  DM: 'DATAMATRIX', 'DATA_MATRIX': 'DATAMATRIX',
  QR: 'QRCODE', 'QR_CODE': 'QRCODE', 'MICRO_QR': 'MICROQR',
};

/** 归一化：大小写、连字符/下划线、别名 */
export function canonSym(sym: string): string {
  const s = String(sym ?? '').trim().toUpperCase();
  if (SYMBOLOGIES[s]) return s;
  return ALIASES[s] ?? s.replace(/^CODE[-_]?/, 'CODE');
}

/** 查能力（归一化后）；未登记的返回 null —— 调用方按"不支持"处理并出 warning */
export function capabilityFor(sym: string): SymbologyCap | null {
  return SYMBOLOGIES[canonSym(sym)] ?? null;
}

/** 某码制在指定协议下能否原生打印 */
export function hasNative(protocol: Protocol, sym: string): boolean {
  const c = capabilityFor(sym);
  return !!c?.caps[protocol]?.native;
}

/**
 * 生成"可执行"的 warnings（替代散落在生成器里的硬编码文案）。
 * 返回 [] 表示可原生打印；返回非空表示需要跳过 / 降级 / 换通道。
 * 这是 P7.2 里"两种根因分别提示"的统一实现。
 */
export function describeUnsupported(protocol: Protocol, sym: string): { warnings: string[]; degradeTo?: string; skip: boolean } {
  const key = canonSym(sym);
  const c = capabilityFor(key);
  if (!c) {
    return { warnings: [`[${protocol.toUpperCase()}] 未登记的码制 "${String(sym)}"，该元素已跳过输出。请检查模板 sym 字段`], skip: true };
  }
  const cap = c.caps[protocol];
  if (cap?.native) return { warnings: [], skip: false };

  const reason = cap?.noNativeInManual
    ? `${protocol.toUpperCase()} 手册无 ${c.label} 原生指令（${key}）`
    : `${protocol.toUpperCase()} 暂未覆盖 ${c.label} 指令（${key}）`;

  // 显式降级：不跳过，但必须回一条 warning
  if (cap?.degradeTo) {
    return {
      warnings: [`[${protocol.toUpperCase()}] ${reason}，已降级为 ${cap.degradeTo} 输出（形状变化但可扫）。${cap.hint ?? ''}`.trim()],
      degradeTo: cap.degradeTo,
      skip: false,
    };
  }
  return {
    warnings: [`[${protocol.toUpperCase()}] ${reason}，该元素已跳过输出。建议：${cap?.hint ?? IMG_HINT}`],
    skip: true,
  };
}

/**
 * 前端能力标签（P7.5）：给每个可选择的码制算一个"受限"标记。
 * printProtocols = 该码制能原生打印的协议集合；为空 → 标"(预览仅)"。
 */
export interface SymUiItem {
  sym: string;
  label: string;
  kind: 'linear' | '2d';
  /** 能原生打印的协议 */
  printProtocols: Protocol[];
  /** 在某个协议下会降级 */
  degradeOn: Protocol[];
  /** 仅能预览（位图），无任何指令协议 */
  previewOnly: boolean;
  /** 展示用后缀，如 "(ZPL/TSPL 可用)" / "(预览仅)" */
  badge: string;
}
export function uiSymbologyList(kind?: 'linear' | '2d'): SymUiItem[] {
  return Object.values(SYMBOLOGIES)
    .filter((c) => !kind || c.kind === kind)
    .map((c) => {
      const protocols: Protocol[] = ['zpl', 'tspl', 'epl'];
      const printProtocols = protocols.filter((p) => c.caps[p]?.native);
      const degradeOn = protocols.filter((p) => !!c.caps[p]?.degradeTo);
      const previewOnly = printProtocols.length === 0;
      const badge = previewOnly
        ? '(预览仅)'
        : `(指令：${printProtocols.map((p) => p.toUpperCase()).join('/')})`;
      return { sym: c.sym, label: c.label, kind: c.kind, printProtocols, degradeOn, previewOnly, badge };
    });
}

// -----------------------------------------------------------------------------
// P7.6 条码几何专业调优（纯函数，算法原理写清楚）
// -----------------------------------------------------------------------------

/** 打印机最小可分辨点：1 dot = 25.4/dpi mm */
export function dotMm(dpi: number): number { return 25.4 / dpi; }

/**
 * 模块宽对齐到整数点阵（原理）：
 * 打印机只能画整数个 dot；若 X-dimension 换算后不是整数 dot，直接下发会产生
 * 非均匀条宽、扫描译码失败。做法：先算 dots = round(mm*dpi/25.4)，最少 1 dot，
 * 再反算回 mm，保证"设计值→实际值"一致，预览与打印不漂移。
 */
export function snapModuleWidth(moduleWidthMm: number, dpi: number): { mm: number; dots: number; adjusted: boolean } {
  const raw = Number(moduleWidthMm) > 0 ? Number(moduleWidthMm) : 0.25;
  const dots = Math.max(1, Math.round((raw * dpi) / 25.4));
  const mm = (dots * 25.4) / dpi;
  return { mm: Number(mm.toFixed(4)), dots, adjusted: Math.abs(mm - raw) > 1e-6 };
}

/** 静区按码制自动计算（返回 mm，已做 DPI 对齐） */
export function quietZoneMm(sym: string, moduleWidthMm: number, dpi: number) {
  const c = capabilityFor(sym);
  const q = c?.quietZoneX ?? QZ_LINEAR_10;
  const snapped = snapModuleWidth(moduleWidthMm, dpi);
  const f = (x: number) => Number((x * snapped.mm).toFixed(3));
  return { left: f(q.left), right: f(q.right), top: f(q.top), bottom: f(q.bottom), basis: c?.label ?? '默认 10X' };
}

/** 高度建议：heightMm ≈ X × heightFactor（8~12X），避免用户把一维码压成"一条线" */
export function suggestedHeightMm(sym: string, moduleWidthMm: number): number | null {
  const c = capabilityFor(sym);
  if (!c?.heightFactor) return null;
  return Number((moduleWidthMm * c.heightFactor).toFixed(3));
}

/**
 * 旋转时明文位置修正（P7.6）：
 * 条码整体旋转 R/I/B 后，"明文在下方"的语义会跟着旋转，导致明文跑到条码左侧/上方
 * 甚至压到静区。做法：把 bottom/top 按旋转角映射到打印机的物理方位，
 * 由生成器用对应的 g 参数（ZPL ^BC 第 4 参数 f/g）表达。
 *   N(0°): bottom→N(不上置) / top→Y(上置)
 *   R(90°)/I(180°)/B(270°): 上下语义反转（旋转 180° 时明文应在物理上方）
 */
export function humanReadablePlacement(textPosition: 'bottom' | 'top', rotation: 0 | 90 | 180 | 270) {
  const flip = rotation === 180 || rotation === 270;
  const above = textPosition === 'top' ? !flip : flip;
  return { above, zplFlag: above ? 'Y' : 'N', note: flip ? '旋转后明文方位已反转以避开静区' : '' };
}

/**
 * 一次性算全几何约束（供生成器与前端属性面板共用）
 */
export function resolveBarcodeGeometry(input: {
  sym: string; moduleWidthMm: number; wideRatio?: number; heightMm: number;
  showText: boolean; textPosition: 'bottom' | 'top'; rotation?: 0 | 90 | 180 | 270;
}, dpi: number) {
  const c = capabilityFor(input.sym);
  const snapped = snapModuleWidth(input.moduleWidthMm, dpi);
  const wideRatio = Number.isFinite(input.wideRatio) && Number(input.wideRatio) > 0
    ? Number(input.wideRatio) : (c?.defaultWideRatio ?? 2.5);
  const qz = quietZoneMm(input.sym, snapped.mm, dpi);
  const suggested = suggestedHeightMm(input.sym, snapped.mm);
  const placement = humanReadablePlacement(input.textPosition, (input.rotation ?? 0) as any);
  return {
    moduleWidthMm: snapped.mm, moduleDots: snapped.dots, moduleAdjusted: snapped.adjusted,
    wideRatio, quietZone: qz, suggestedHeightMm: suggested,
    heightTooSmall: suggested !== null && input.heightMm < suggested * 0.6,
    humanReadable: placement,
  };
}

// -----------------------------------------------------------------------------
// P7.4 GS1 FNC1 语义（纯函数）
// -----------------------------------------------------------------------------

/** 常见 GS1 定长 AI（长度不含 AI 本身）；变长 AI 之间必须插 FNC1 分隔 */
const FIXED_LEN_AI: Record<string, number> = {
  '00': 18, '01': 14, '02': 14, '03': 14, '04': 16,
  '11': 6, '12': 6, '13': 6, '14': 6, '15': 6, '16': 6, '17': 6, '18': 6, '19': 6, '20': 2,
  '31': 8, '32': 8, '33': 8, '34': 8, '35': 8, '36': 8,
  '41': 13,
};
// 值不能吞掉下一个 AI 的起始括号：用 [^\s(]* 而非 [^\s]*，否则
// "(01)123...(17)251231" 会被一次性当成 AI(01) 的值，定长判定与分隔符全错。
const AI_RE = /^\((\d{2,4})\)([^\s(]*)/;

/**
 * GS1 内容编码：把人类可读的 "(01)123...(17)..." 转成码制数据流。
 * 原理：GS1-128 以 FNC1 开头（ZPL 用 `>;`，TSPL 用 `!` 或 `\x7C` 前缀视机型），
 *   定长 AI 后直接接续下一个 AI；变长 AI 后必须插 FNC1 分隔，否则译码器无法断句。
 * 返回 { data, fnc1Prefix, separators } —— 生成器按协议选择转义写法。
 */
export function encodeGs1(content: string): { data: string; fnc1Prefix: boolean; separators: number; invalid: string[] } {
  const s = String(content ?? '').trim();
  const invalid: string[] = [];
  if (!s) return { data: '', fnc1Prefix: false, separators: 0, invalid: ['GS1 内容为空'] };

  // 已是不带括号的原始数据流 → 原样返回（视为已编码）
  if (!s.includes('(')) return { data: s.replace(/\s+/g, ''), fnc1Prefix: true, separators: 0, invalid };

  let rest = s;
  let data = '';
  let separators = 0;
  let guard = 0;
  while (rest.length && guard++ < 50) {
    const m = AI_RE.exec(rest);
    if (!m) { invalid.push(`无法解析的片段: "${rest}"`); break; }
    const ai = m[1];
    const value = m[2];
    const fixed = FIXED_LEN_AI[ai];
    if (fixed && value.length !== fixed) {
      invalid.push(`AI(${ai}) 应为 ${fixed} 位，实际 ${value.length} 位`);
    }
    data += ai + value;
    rest = rest.slice(m[0].length).replace(/^\s+/, '');
    // 后面还有 AI 且当前是变长 AI → 插 FNC1（用占位符 \u001D 表示，生成器按协议转义）
    if (rest.length && !fixed) { data += '\u001D'; separators++; }
  }
  return { data, fnc1Prefix: true, separators, invalid };
}

/** 把 GS1 数据流里的 FNC1 占位符按协议转义 */
export function gs1ToProtocol(data: string, protocol: 'zpl' | 'tspl'): string {
  const fnc1 = protocol === 'zpl' ? '>8' : '!';
  return data.replace(/\u001D/g, fnc1);
}
