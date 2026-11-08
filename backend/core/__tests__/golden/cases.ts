// =============================================================================
// golden/cases.ts —— P7.8 golden 快照的**用例定义 + 渲染器**（纯函数，无第三方依赖）
//
// 为什么单独一个文件：update.ts（生成/比对）与 golden.test.ts（断言）必须用**同一份**
// 用例与同一份渲染规则，否则「测试绿的」和「快照里存的」可能不是同一个东西。
//
// 硬约束（仓库红线，docs/05-api.md §8.3 / docs/10 §B2）：
//   · 快照只由 core 下的**同步纯函数**产生：zpl/tspl/epl 三个生成器 + barcode-caps +
//     gs1 + bitmap-blocks。绝不允许 import sharp / bwip-js / TypeORM / Nest ——
//     一旦引入 bwip，快照就不再可重复（版本/平台差异会改像素）。
//   · 因此**位图段不调 raster.ts**，而是手工塞一个确定的 fallback 点阵（synthFallback）：
//     快照证明的是「点阵如何被各家协议封装下发」；像素本身是否可扫由
//     scripts/p7-acceptance.sh 的 C 段用真 bwip 点阵 + cv2 解码验证。
//   · 渲染必须可重复：不写时间戳、不写路径、不写随机数。
// =============================================================================

import { generateZpl, type ZplElement } from '../../zpl-generator';
import { tsplParts, type TsplElement } from '../../tspl-generator';
import { generateEpl, type EplElement, type EplPage } from '../../epl-generator';
import { CAP_MATRIX_VERSION, planChannel, statusFor } from '../../barcode-caps';
import type { PrintProtocol } from '../../barcode-caps';
import type { BarcodeSpec, BitmapFallback, QrcodeSpec } from '../../types';

export const PROTOCOLS: PrintProtocol[] = ['zpl', 'tspl', 'epl'];

/** 全用例统一 dpi / 页面：改这里会让所有快照重算，属有意为之 */
export const DPI = 203;
export const PAGE: EplPage = { widthMm: 60, heightMm: 40, gapMm: 2, density: 8, speed: 2, copies: 1 };

/** 元素摆放位置（点坐标也进快照，用来锁死 mm→dots 换算不被顺手改动） */
export const X_MM = 10;
export const Y_MM = 8;

// =============================================================================
// 内容样本：一份内容同时喂三个协议，便于横向比对。
// 选取原则：既符合该码制的字符集/位数规范（否则会被生成器的数据体检拦掉，快照就成了
// 「跳过」而不是「输出」，覆盖不到指令格式），又能触发该码制的**关键几何/语义分支**
// （GS1 的定长+变长 AI、ITF 的偶数位、EAN/UPC 的固定比例…）。
// =============================================================================
export const CONTENT: Record<string, string> = {
  CODE128: 'ABC-1234',
  // 01 定长 14 + 21 变长（后面还有 AI → 必须插 FNC1/GS）+ 30 变长（末位，不插）
  GS1_128: '(01)12345678901231(21)SN0007(30)1234',
  CODE39: 'ABC-123',
  CODE93: 'CODE93-1',
  EAN13: '6901234567892',   // 12 位数据 + 校验位 2
  EAN8: '96385074',         // 7 位数据 + 校验位 4
  UPC_A: '012345678905',    // 11 位数据 + 校验位 5
  UPC_E: '01234565',        // 零压缩：NS=0 + 123456 + 校验位 5（展开成 012345600000 后 Mod10=5）
  ITF: '12345670',          // 偶数位数字（不触发补 0 warning）
  ITF14: '10012345600019',  // GTIN-14：前 13 位 1001234560001 的 Mod10 校验位 = 9
  CODABAR: 'A1234567B',
  MSI: '1234567',
  PHARMACODE: '1234567',
  CODE16K: 'ABC-1234',
  QRCODE: 'https://labelflow.example/t/42',
  DATAMATRIX: 'DM-0001',
  PDF417: 'PDF417DATA',
  AZTEC: 'AZTEC-1',
  MICROQR: 'MICRO-42',
  DATAMATRIX_RECT: 'RECT-7',
  /** 派生标识：真实码制是 DATAMATRIX，内容带 (AI) → planChannel 必须改派位图通道 */
  DATAMATRIX_GS1: '(01)12345678901231(21)SN0007',
  /** 与上一行同内容，只是不预置点阵：验「位图通道拿不到点阵 → 跳过，绝不回落 ^BX/QRCODE/b」 */
  DATAMATRIX_GS1_NORASTER: '(01)12345678901231(21)SN0007',
};

/** 快照标识 → 能力矩阵/生成器用的真实码制 */
export function realSym(key: string): string {
  return key.startsWith('DATAMATRIX_GS1') ? 'DATAMATRIX' : key;
}

/** 一维码默认几何：模块宽 0.4mm、宽窄比 2.5 —— 2.5 正是「设计器 2.5、打印机 2」那个历史坑 */
export function bcSpec(key: string, over: Partial<BarcodeSpec> = {}): BarcodeSpec {
  return {
    sym: realSym(key), content: CONTENT[key] ?? 'ABC', moduleWidthMm: 0.4, wideRatio: 2.5,
    heightMm: 12, showText: true, textPosition: 'bottom', ...over,
  };
}

export function qrSpec(key: string, over: Partial<QrcodeSpec> = {}): QrcodeSpec {
  return { sym: realSym(key), content: CONTENT[key] ?? 'X', ecc: 'M', moduleSizeMm: 0.5, quietZoneMm: 1, ...over };
}

// =============================================================================
// 确定性点阵（替代 bwip 出图）
//   24 点宽（=3 字节/行）× 12 行：左上角 8×8「定位图形」+ 其余按固定公式铺数据模块。
//   刻意保证：0 与 1 都出现、行首字节 ≥0x80（MSB 在左 = 最左点是墨）、行数不是 8 的倍数
//   （行尾补 0 的语义在快照里看得见）、宽不是 8 的整数倍之外还留有半个字节（对齐可见）。
//   ⚠️ 这**不是**扫得出来的图案，只用来锁死各协议图像指令的封装格式；
//      图案可扫性由 p7-acceptance.sh 的 C 段用真实 bwip 点阵 + cv2 解码验证。
// =============================================================================
export const FALLBACK_MODULE_DOTS = 4;
export const FALLBACK_WIDTH_DOTS = 24;
export const FALLBACK_HEIGHT_DOTS = 12;

export function synthFallback(moduleDots: number = FALLBACK_MODULE_DOTS): BitmapFallback {
  const w = FALLBACK_WIDTH_DOTS, h = FALLBACK_HEIGHT_DOTS;
  const bytesPerRow = Math.ceil(w / 8);
  let hex = '';
  for (let y = 0; y < h; y++) {
    const bytes = new Uint8Array(bytesPerRow);
    for (let x = 0; x < w; x++) {
      const inFinder = x < 8 && y < 8;
      const finder = inFinder && (x === 0 || x === 7 || y === 0 || y === 7 || (x >= 3 && x <= 4 && y >= 3 && y <= 4));
      // 数据区按 2 点网格取模，保证同一网格内取值一致（肉眼可核对模块对齐）
      const data = !inFinder && (Math.floor(x / 2) + Math.floor(y / 2) * 3 + 5) % 4 < 2;
      if (finder || data) bytes[x >> 3] |= 0x80 >> (x & 7);
    }
    hex += Buffer.from(bytes).toString('hex').toUpperCase();
  }
  return { widthDots: w, heightDots: h, bytesPerRow, hex, moduleDots };
}

// =============================================================================
// 用例表
// =============================================================================
export type CaseKind = 'barcode' | 'qrcode';

export interface GoldenCase {
  /** 快照标识（同时是文件名前缀） */
  key: string;
  /** 能力矩阵里的真实码制标识 */
  sym: string;
  protocol: PrintProtocol;
  kind: CaseKind;
  /** 这份快照存在的意义：证明哪个缺陷不再复发（golden.test.ts 逐条断言） */
  regression: string;
  /** 位图通道但**故意不给** fallback：验「拿不到点阵 → 跳过 + warning，绝不换码制」 */
  noRaster?: boolean;
}

interface CaseSpec {
  /** 快照标识；DATAMATRIX_GS1* 是派生标识（真实码制仍是 DATAMATRIX） */
  key: string;
  kind: CaseKind;
  /** 各协议的回归说明；缺省 = 该 (key,protocol) 组合不出快照 */
  protocols: Partial<Record<PrintProtocol, string>>;
  noRaster?: boolean;
}

const SPECS: CaseSpec[] = [
  {
    key: 'CODE128', kind: 'barcode',
    protocols: {
      zpl: '^BY 三段参数顺序（模块宽,宽窄比,高度）与 ^BC 的 5 位参数齐全；宽窄比 2.5 必须取整为 3:1（Code128 的宽元素只能是整数模块），校验位不重复追加',
      tspl: 'BARCODE 码型必须是 "128"；narrow/wide 以「点」为单位且 wide≥narrow',
      epl: "B 指令 p4 类型码必须是 '1'（Table 2-1 Code128），p5 窄条 / p6 宽条 / p7 高度 / p8=B 的位次不能错",
    },
  },
  {
    key: 'GS1_128', kind: 'barcode',
    protocols: {
      zpl: '数据段必须以 >;（起始 FNC1）开头；变长 AI(21) 之后插 >8，定长 AI(01) 之后不插，末位之后不插；^BC 第 5 位（UCC 校验）必须锁 N，否则 AI 结构与校验位被固件重算',
      tspl: '★ 码型必须是 "EAN128" 而不是 "128"（P7.4 实伤：打成普通 Code128 时符号能扫但 AI 结构全丢）；变长 AI 之后是裸 0x1D（GS），定长 AI 之后不插、末尾不插',
      epl: "EPL2 虽有类型码 '1E'，但 FNC1 转义写法查证不到 → 必须整条跳过 + warning，绝不能把 (AI) 原样塞进 DATA 静默打错码",
    },
  },
  {
    key: 'CODE39', kind: 'barcode',
    protocols: {
      zpl: '^B3 的参数顺序是 o,e(校验),h,f(明文),g(明文在上)——与 ^BC 不同；位次错一位就把校验位当高度用',
      tspl: '码型 "39"；宽窄比 2.5 可原样下发（Code39 宽元素允许非整数模块）',
      epl: "类型码 '3'，p6 宽条可设定（wideSettable=true）→ 不得出现「p6 会被固件忽略」那条 warning",
    },
  },
  {
    key: 'CODE93', kind: 'barcode',
    protocols: {
      zpl: '^BA（Code93）而不是 ^B3/^BC；宽窄比按整数模块取整',
      tspl: '码型必须是 "93"（不是 "39"，也不是 "EAN128"——Code93 在 TSC 码型表里是独立一条）；narrow/wide 以点为单位',
      epl: "类型码 '9'（P7.7 复核由 bitmap 改 native：EPL 侧只应出 B 指令，不该出现 GW）",
    },
  },
  {
    key: 'EAN13', kind: 'barcode',
    protocols: {
      zpl: '固定比例码制：^BY 的宽窄比必须被显式忽略并出 warning（1:1），且用 ^BE 不是 ^BC',
      tspl: '★ narrow 必须等于 wide（EAN 是固定比例符号，wide≠narrow 打出来是非法符号）',
      epl: "类型码 'E30'，且 p5 窄条宽被钳到 Table 2-1 的 2–4 点",
    },
  },
  {
    key: 'EAN8', kind: 'barcode',
    protocols: {
      zpl: '^B8（不是 ^BE=EAN13）；固定比例同样忽略宽窄比',
      tspl: '码型 "EAN8"，wide===narrow',
      epl: "类型码 'E80'，7/8 位数据体检通过（末位校验位由打印机补）",
    },
  },
  {
    key: 'UPC_A', kind: 'barcode',
    protocols: {
      zpl: '^BU（UPC-A）；固定比例忽略宽窄比',
      tspl: '码型 "UPCA"，wide===narrow',
      epl: "类型码 'UA0'（不是 EAN13 的 E30）",
    },
  },
  {
    key: 'UPC_E', kind: 'barcode',
    protocols: {
      zpl: '^B9（UPC-E）而不是 ^BU（UPC-A）——零压缩符号用错指令，符号宽度差近一倍',
      tspl: '码型 "UPCE"（与 UPCA 是两条码型）',
      epl: "类型码 'UE0'（P7.7 复核：EPL 有 UE0，不该走位图）",
    },
  },
  {
    key: 'ITF', kind: 'barcode',
    protocols: {
      zpl: '★ 必须是 ^B2（Interleaved 2 of 5）。^BI 是 Industrial 2 of 5、^BJ 是 Standard 2 of 5，用错固件不报错但打出另一种符号（P7.1 实伤）',
      tspl: '码型 "ITF"（不是 "ITF14"）',
      epl: "类型码 '2'，p6 宽条可设定；偶数位数据不触发「补 0」warning",
    },
  },
  {
    key: 'ITF14', kind: 'barcode',
    protocols: {
      zpl: 'GTIN-14 仍用 ^B2 承载（ITF-14 只是数据规范 + 边框），指令层不得出现 ^BI / ^B7',
      tspl: '码型 "ITF14"（TSC 码型表里 ITF14 与 ITF 是两条，不能都写 ITF）',
      epl: "★ degraded：EPL2 无 ITF-14 类型码，用 '2' 承载 → 必须同时给出「不含 ITF-14 边框/承载标记」的等价性 warning，不能假装完全等价",
    },
  },
  {
    key: 'CODABAR', kind: 'barcode',
    protocols: {
      zpl: '^BK 的参数顺序是 o,e(校验),h,f,g —— 与 ^BM 的 e 位含义不同（BK 是 Y/N，BM 是 A/B/C/D）',
      tspl: '码型 "CODABAR"，且起迄符 A–D 必须原样出现在数据段里（被吞掉起迄符就不是 Codabar 符号了）',
      epl: "类型码 'K'（Codabar 在 Table 2-1 里只有 K 一条），p6 宽条可设定（wideSettable=true）→ 不得出现「p6 会被固件忽略」那条 warning",
    },
  },
  {
    key: 'MSI', kind: 'barcode',
    protocols: {
      zpl: "★ ^BM 第 2 位是「校验方式 A/B/C/D」而不是 Y/N：未要求校验位时必须显式给 A，否则固件按 B(单 Mod10) 多打一位，扫描结果比预览多一位",
      tspl: '码型 "MSI"（未要求校验位 → 不得自动换成 "MSIC"）',
      epl: "★ EPL2 的 'M'(MSI-3)/'L'(Plessey) 校验算法被固件写死，与本产品 MSI(+MSI10/11) 不是同一符号 → 必须跳过 + warning，不许拿 'M' 顶替",
    },
  },
  {
    key: 'PHARMACODE', kind: 'barcode',
    protocols: {
      zpl: '手册无原生指令、一维位图回填又会破坏条空比例 → 只能跳过 + 可执行建议；指令串里不得出现任何 ^B*（出现即等于悄悄换了码制）',
      tspl: '同上：三协议里唯一允许的输出是空指令 + [码制] warning，出现 BARCODE 行就等于把 PHARMACODE 悄悄换成别的码制',
      epl: '同上：不得出现 B 指令行；EPL 的 Table 2-1 没有 PHARMACODE 类型码，任何类型码顶替都是换码制',
    },
  },
  {
    key: 'CODE16K', kind: 'barcode',
    protocols: {
      zpl: 'ZPL 的 ^BB 是 Codablock 不是 Code16K，不可混用 → 跳过 + warning，不得出现 ^BB/^BC',
      tspl: '不得出现 BARCODE 行——^BB/TSC 都没有可引用的 Code16K 语法，跳过比「打个看着像的」安全',
      epl: '不得出现 B 指令行，也不得回落成 Code128 的 \'1\'（Code16K 是堆叠式，不是 Code128）',
    },
  },
  {
    key: 'QRCODE', kind: 'qrcode',
    protocols: {
      zpl: '^BQ 的 model 位必须是 2（手册无 Micro QR / 汉字模式），放大系数与纠错等级按参数位次给全；数据走 ^FDQA, 段',
      tspl: 'QRCODE 指令的 cell size 单位是点/模块，mode 位固定 A（标准模型）',
      epl: '★ EPL 的 b(2D) 语法查证不到 → 只能走 GW；GW 的 p3=每行字节数、p4=行数，载荷字节数必须严格等于 p3×p4（差一字节整块图错位）',
    },
  },
  {
    key: 'DATAMATRIX', kind: 'qrcode',
    protocols: {
      zpl: '^BX 的 quality 只能是 200（ECC200）；h 是「每符号元素高度」而不是符号总高',
      tspl: 'TSPL 无原生 DM → 位图 BITMAP 下发；头必须是 BITMAP x,y,每行字节数,行数,0,',
      epl: 'GW 下发（同 QRCODE 的字节数一致性要求）',
    },
  },
  {
    key: 'PDF417', kind: 'qrcode',
    protocols: {
      zpl: '★ 必须是 ^B7（PDF417）。^B2 是 Interleaved 2 of 5，把 PDF417 交给 ^B2 会打成一维交叉二五码（P7.1 实伤）；行高按 3×模块给',
      tspl: '位图 BITMAP 下发（TSPL 无原生 PDF417）：头必须是 BITMAP x,y,bpr,rows,0,，不能降级成一维码',
      epl: 'GW 下发（EPL 无原生 PDF417）：载荷字节数必须等于 p3×p4，行高/行数按 synthFallback 点数',
    },
  },
  {
    key: 'AZTEC', kind: 'qrcode',
    protocols: {
      zpl: '^B0（Aztec，^BO 同义）而不是 ^BX/^BQ；放大系数按 1–20 钳制',
      tspl: '位图 BITMAP 下发（TSPL 无原生 Aztec）：出现 QRCODE 行就是拿 QR 顶替 Aztec，属换码制',
      epl: 'GW 下发（EPL 无原生 Aztec）：载荷字节数必须等于 p3×p4，不得凭空造 b(2D) 指令',
    },
  },
  {
    key: 'MICROQR', kind: 'qrcode',
    protocols: {
      zpl: '★ ^BQ 明确 model 2 only，Micro QR 无原生指令 → 必须走 ^GFA 位图；旧实现谎称原生（发 ^BQ 打出的是标准 QR，与预览不是同一符号）',
      tspl: '位图 BITMAP 下发（降级成标准 QR 也不等价，所以不得给 QRCODE 指令）',
      epl: 'GW 下发：Micro QR 只能靠点阵还原，GW 载荷必须与 synthFallback 的 bpr×rows 逐字节对齐',
    },
  },
  {
    key: 'DATAMATRIX_RECT', kind: 'qrcode',
    protocols: {
      zpl: '★ ^BX 的 columns/rows 允许范围 9–49，ECC200 矩形尺寸 8×18/8×32/12×26 越界会整块不打印 → 必须走位图而不是硬编 ^BX',
      tspl: '位图 BITMAP 下发：矩形 DM 的宽高比只能由点阵表达，BITMAP 头的前两个参数是字节数/行数而不是 mm',
      epl: 'GW 下发：同上，宽高由 p3×p4 决定；出现 b 指令即视为硬编未查证的语法',
    },
  },
  {
    key: 'DATAMATRIX_GS1', kind: 'qrcode',
    protocols: {
      zpl: '★ 能力矩阵把 DATAMATRIX 判为 zpl=native，但内容含 (AI) → planChannel 必须改派位图通道（^GFA）：^BX 没有可引用的 FNC1 转义写法，硬编会把 GS1 DataMatrix 静默打成普通 DataMatrix（数据错但肉眼看不出）',
      tspl: '二维 + (AI) → 位图；封装格式同 DATAMATRIX@tspl',
      epl: '二维 + (AI) → GW；载荷字节数与头部声明一致',
    },
  },
  {
    key: 'DATAMATRIX_GS1_NORASTER', kind: 'qrcode', noRaster: true,
    protocols: {
      zpl: '位图通道但调用方没预置点阵（同步直调生成器）→ 必须「跳过 + 说清原因的 warning」，不得回落到 ^BX 原生指令（那是另一种符号），也不得凭空造 ^GFA',
      tspl: '同上：不得回落 QRCODE 指令、也不得造一条空 BITMAP（空载荷会让打印机吃掉后续指令）',
      epl: '同上：不得凭空造 GW；warning 要说清缺的是点阵（fallback）而不是码制不支持，否则排查方向直接被带偏',
    },
  },
];

/** 全部用例（每码制 × 每协议一条） */
export function goldenCases(): GoldenCase[] {
  const out: GoldenCase[] = [];
  for (const s of SPECS) {
    for (const p of PROTOCOLS) {
      const regression = s.protocols[p];
      if (!regression) continue;
      out.push({
        key: s.key, sym: realSym(s.key), protocol: p, kind: s.kind,
        regression, noRaster: !!s.noRaster,
      });
    }
  }
  return out;
}

/** 用例 → 元素（三个生成器共用同一份 spec 构造，保证横向可比） */
export function elementFor(c: GoldenCase): ZplElement | TsplElement | EplElement {
  const base = { xMm: X_MM, yMm: Y_MM };
  if (c.kind === 'barcode') return { ...base, type: 'barcode', barcode: bcSpec(c.key) } as ZplElement;
  const fallback = c.noRaster ? undefined : synthFallback();
  return { ...base, type: 'qrcode', qrcode: qrSpec(c.key), fallback } as ZplElement;
}

// =============================================================================
// 快照渲染
// =============================================================================

export interface Snapshot {
  case: GoldenCase;
  /** 实际喂给生成器的内容（由 elementFor 反查，保证头部注释与指令用的是同一份） */
  content: string;
  /** 生成器返回的原始文本（含二进制/控制字符），供结构性断言用 */
  raw: string;
  warnings: string[];
  /** 落到 .txt 的可见文本（控制字符转 <GS>/<xx>，二进制段转 ⟦BIN⟧） */
  body: string;
}

/**
 * 把不可见字节换成可打印标记：指令文本本身是 ASCII，warnings 是中文，
 * 两者都要能直接在 .txt 里读，所以只逃控制字符（<0x20 与 DEL），不动可打印 Unicode。
 * 二进制载荷不经过这里——它已由 binTag 换成 hex。
 */
export function visible(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\n') out += '\n';
    else if (ch === '\r') out += '<CR>';
    else if (c === 0x1d) out += '<GS>';
    else if (c < 0x20 || c === 0x7f) out += `<${c.toString(16).padStart(2, '0').toUpperCase()}>`;
    else out += ch;
  }
  return out;
}

/** 二进制段 → ⟦BIN 字节数:HEX⟧（一个 latin1 char = 一个字节） */
export function binTag(bin: string): string {
  const buf = Buffer.from(bin, 'latin1');
  return `⟦BIN ${buf.length}B:${buf.toString('hex').toUpperCase()}⟧`;
}

/**
 * EPL 的 GW 载荷是 latin1 原始字节，里面随时可能出现 CR/LF —— 直接写进快照会截断指令行，
 * 所以按「头部声明的 widthBytes×heightBytes」整段取出换成 ⟦BIN⟧。
 * 顺带这条扫描本身就在验：头部声明的字节数必须和解出的载荷长度一致。
 */
export function hideEplBinary(text: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const at = text.indexOf('GW', i);
    if (at < 0) { out += text.slice(i); break; }
    const m = /^GW(\d+),(\d+),(\d+),(\d+),/.exec(text.slice(at));
    if (!m) { out += text.slice(i, at + 2); i = at + 2; continue; }
    const payload = Number(m[3]) * Number(m[4]);
    const head = at + m[0].length;
    out += text.slice(i, head) + binTag(text.slice(head, head + payload));
    i = head + payload;
  }
  return out;
}

/** 生成一份快照（纯函数：同一输入必得同一输出） */
export function makeSnapshot(c: GoldenCase): Snapshot {
  const el = elementFor(c);
  const content = String(c.kind === 'barcode' ? (el as ZplElement).barcode?.content : (el as ZplElement).qrcode?.content);
  if (c.protocol === 'zpl') {
    const r = generateZpl([el as ZplElement], DPI);
    return { case: c, content, raw: r.text, warnings: r.warnings, body: visible(r.text) };
  }
  if (c.protocol === 'tspl') {
    const { parts, warnings } = tsplParts([el as TsplElement], DPI);
    const raw = parts.map((p) => (typeof p === 'string' ? p : p.head + p.bin.toString('latin1'))).join('\r\n');
    const text = parts.map((p) => (typeof p === 'string' ? p : p.head + binTag(p.bin.toString('latin1')))).join('\r\n');
    return { case: c, content, raw, warnings, body: visible(text) };
  }
  const r = generateEpl([el as EplElement], DPI, PAGE);
  return { case: c, content, raw: r.text, warnings: r.warnings, body: visible(hideEplBinary(r.text)) };
}

/** 快照全文：头部说明「这份快照证明什么」，正文是指令 + warnings */
export function renderSnapshot(s: Snapshot): string {
  const plan = planChannel(s.case.sym, s.case.protocol, s.content);
  const st = statusFor(s.case.sym, s.case.protocol);
  const head = [
    `# golden —— ${s.case.key} @ ${s.case.protocol.toUpperCase()}（dpi=${DPI}，由 core/__tests__/golden/update.ts 生成，勿手改）`,
    `# 回归点: ${s.case.regression}`,
    `# 能力矩阵: CAP_MATRIX_VERSION=${CAP_MATRIX_VERSION} status=${st ?? 'unknown'} —— 码制 ${s.case.sym}`
      + `${s.case.key !== s.case.sym ? `（派生标识 ${s.case.key}：同码制不同内容口径）` : ''} / 内容 ${JSON.stringify(s.content)}`,
    `# 通道派单: channel=${plan.channel}${plan.why ? ` why=${plan.why}` : ''}`,
    `# 位图段: ${s.case.kind === 'barcode' ? '不涉及（一维无位图回填通道）'
      : s.case.noRaster ? '故意不给 fallback —— 验「拿不到点阵 → 跳过 + warning，绝不换码制」'
        : `确定性合成点阵 synthFallback()（${FALLBACK_WIDTH_DOTS}×${FALLBACK_HEIGHT_DOTS} 点 / ${FALLBACK_MODULE_DOTS} 点每模块），不经 bwip/sharp`}`,
    '',
    '--- commands ---',
  ];
  const warn = ['', '--- warnings ---'].concat(
    s.warnings.length ? s.warnings.map((w) => `- ${visible(w).replace(/\n/g, ' ')}`) : ['- (none)'],
  );
  return head.join('\n') + '\n' + s.body.replace(/\n+$/, '') + '\n' + warn.join('\n') + '\n';
}

export function fileNameFor(c: GoldenCase): string {
  return `${c.key.toLowerCase()}.${c.protocol}.txt`;
}
