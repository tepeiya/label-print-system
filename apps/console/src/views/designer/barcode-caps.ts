// =============================================================================
// barcode-caps.ts —— 码制 × 打印协议 能力矩阵（Console 侧只读副本）
//
// 【与 backend/core/barcode-caps.ts 等价，CAP_MATRIX_VERSION 保持一致，由后端单测守卫】
// apps/console 与 backend 是两个独立 TS 工程（console 的 tsconfig 只覆盖 src/，
// 前端产物也不该打进服务端代码），所以这里不 import 后端，只维护一份「内容等价」副本：
// 表内容、状态语义、note 文案、版本号任何一项改动都必须两边同步，
// P7.8 的守卫单测会逐条比对两边 CAP_MATRIX 与 CAP_MATRIX_VERSION。
//
// 状态语义（与后端逐字一致，不要自创）：
//   native      —— 协议有原生指令，图案由打印机生成（首选，UI 不加任何标记）
//   degraded    —— 能出图但与预览不完全等价，必须伴随 warning
//   bitmap      —— 无原生指令，走 bwip-js 位图 + 图像通道，可扫但不是打印机原生符号
//   previewOnly —— 位图通道也拿不到数据，只能跳过 + warning（等于「这台机打不了」）
//
// -----------------------------------------------------------------------------
// 展示口径（本文件相对后端多出的一层 UI 判定，只决定「按哪个协议呈现」，
// 不改动任何结论；判定本身仍然只在 CAP_MATRIX 里）：
//   · 理想情况是标记跟随当前打印机协议，但 designer store 里目前没有打印机/协议概念
//     （协议只在导出指令时由调用方指定：backend/src/print/dto/print.dto.ts 的
//     `protocol?: 'zpl' | 'tspl' | 'epl'`，控制器把缺省与非白名单值归一到 zpl）。
//   · 所以 protocol 缺省时按「最差情况」聚合：在 DISPLAY_PROTOCOLS = ['zpl','tspl'] 里
//     按 native < degraded < bitmap < previewOnly 取最坏的一档。
//     为什么取最差而不是取最好：这次改动的目的就是「别等导出指令才发现打不了」，
//     宁可提前把 DataMatrix 在 TSPL 机上要走位图说清楚；只有两边都不掉链子的码制
//     才配得上「无标记」。
//     为什么不纳入 epl：epl 现在确实能走 /print/commands（DTO 白名单 zpl|tspl|epl），
//     不纳入它是刻意的产品决策，不是入口限制——EPL 是可选协议、面向老 Zebra/Eltron 机型，
//     覆盖面明显窄于 ZPL/TSPL：全部二维符号（含最常用的 QRCODE）在 EPL 下只能走 GW 点阵，
//     GS1_128 / MSI 干脆是 previewOnly。把它并进最坏情况，绝大多数用 ZPL/TSPL 的用户
//     都会看到「位图打印」「仅预览」，噪音盖掉信号。
//     需要 EPL 口径时由调用方显式传 protocol:'epl'，capStatus / capOptions / capHint
//     会按 CAP_MATRIX 的 epl 列如实呈现，无需改这张表。
//   · 以后接入打印机选择器时，把它的 protocol 传给 capStatus/capOptions/capHint 即可。
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

/** 状态 → 中文标签（后端 capNote 内的同一张映射，逐字照抄） */
const STATUS_LABEL: Record<CapStatus, string> = {
  native: '原生指令',
  degraded: '原生指令（有等价性差异）',
  bitmap: '位图通道（bwip-js 出图）',
  previewOnly: '仅预览',
};

/**
 * warnings 文案统一出口（与后端逐字一致）：说清「为什么不是原生」和「现在实际打出了什么」。
 */
export function capNote(sym: string, protocol: PrintProtocol): string {
  const c = capOf(sym);
  if (!c) return `${sym} 不在码制能力矩阵内，请确认前端码制标识`;
  return `${sym} @ ${protocol.toUpperCase()} → ${STATUS_LABEL[c[protocol]]}；${c.note}`;
}

// -----------------------------------------------------------------------------
// 以下为展示层（UI-only）辅助：只读上面这张表，不新增任何判定结论
// -----------------------------------------------------------------------------

/** 展示口径覆盖的协议，理由见文件头注释 */
export const DISPLAY_PROTOCOLS: PrintProtocol[] = ['zpl', 'tspl'];

/** 严重程度：越大越「不能直接打印」，最差情况聚合按这个序取最坏一档 */
const SEVERITY: Record<CapStatus, number> = { native: 0, degraded: 1, bitmap: 2, previewOnly: 3 };

/** 下拉项后缀：native 不加标记，其余让用户一眼看清降级方式 */
export const STATUS_SUFFIX: Record<CapStatus, string> = {
  native: '',
  degraded: '（打印有差异）',
  bitmap: '（位图打印）',
  previewOnly: '（仅预览·不能直接打印）',
};

/** 缺省协议口径下的最差状态；未知码制返回 undefined（UI 一律按原样呈现，不猜） */
export function worstStatusFor(sym: string): CapStatus | undefined {
  const c = capOf(sym);
  if (!c) return undefined;
  let worst: CapStatus = 'native';
  for (const p of DISPLAY_PROTOCOLS) {
    const st = c[p];
    if (SEVERITY[st] > SEVERITY[worst]) worst = st;
  }
  return worst;
}

/** 面板/下拉统一入口：拿到真实协议就按协议，拿不到就走最差情况口径 */
export function capStatus(sym: string, protocol?: PrintProtocol): CapStatus | undefined {
  return protocol ? statusFor(sym, protocol) : worstStatusFor(sym);
}

/**
 * 码制下拉 options（FSelect 认 [value, label] 元组）。
 * value 必须是 model.ts 里 BARCODE_SYMS / QRCODE_SYMS 的原值 —— 只改展示，不改取值集合。
 */
export function capOptions(syms: string[], protocol?: PrintProtocol): Array<[string, string]> {
  return syms.map((s) => {
    const st = capStatus(s, protocol);
    return [s, s + (st ? STATUS_SUFFIX[st] : '')];
  });
}

/**
 * 选中受限码制时的小字说明：每个「非 native 的降级方式」一行，native 不列。
 * native / 未知码制返回空数组 —— 面板不占位、不拦截、不弹窗。
 * 同一降级方式只说一次：PHARMACODE 在 ZPL 与 TSPL 都是「仅预览」，写两行没有增量信息；
 * 单协议时直接取 capNote 原文（与后端逐字一致），多协议时才把协议名并列。
 */
export function capHint(sym: string, protocol?: PrintProtocol): string[] {
  const c = capOf(sym);
  if (!c) return [];
  const byStatus = new Map<CapStatus, PrintProtocol[]>();
  for (const p of (protocol ? [protocol] : DISPLAY_PROTOCOLS)) {
    if (c[p] === 'native') continue;
    byStatus.set(c[p], [...(byStatus.get(c[p]) ?? []), p]);
  }
  return [...byStatus.entries()].map(([st, ps]) =>
    ps.length === 1
      ? capNote(sym, ps[0])
      : `${sym} @ ${ps.map((p) => p.toUpperCase()).join('/')} → ${STATUS_LABEL[st]}；${c.note}`,
  );
}

/**
 * /print/commands 的 warnings → 展示用「类别前缀 + 正文」（纯展示，不改判定）。
 * 类别一律取自后端文案自带的方括号标签（backend/core/*.ts 里是 [码制] / [几何] / [静区] /
 * [参数] / [位图] / [图像] / [校验位] / [GS1]，生成器还有历史格式的 [ZPL] / [TSPL]），
 * 前端只把它们归到可读的中文类别，正文原样保留（只把已用于分类的那个方括号标签摘掉，
 * 避免「【码制】[码制] …」重复），除此之外不做任何加工。
 * 无标签的按内容兜底：TSPL 中文字库依赖（backend print.controller.ts#buildWarnings）归「字体」。
 */
export function warnBadge(w: string): { kind: string; text: string } {
  const s = String(w ?? '');
  const m = /^\[([^\]]+)\]\s*/.exec(s);
  if (!m) return { kind: s.includes('FONT') || s.includes('字库') ? '字体' : '提示', text: s };
  const tag = m[1].toUpperCase();
  // 协议名标签（老格式 [ZPL]/[TSPL]/[EPL]）说的都是「这个码制在该协议下怎么出图」
  const kind = tag === 'ZPL' || tag === 'TSPL' || tag === 'EPL' ? `码制·${tag}` : m[1];
  return { kind, text: s.slice(m[0].length) };
}
