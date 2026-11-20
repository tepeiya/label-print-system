// =============================================================================
// maxicode.ts —— UPS MaxiCode 原生 ZPL ^BD 指令构造（第三层 · 码制专业性）
//
// 【为什么单独做】P8.4 把 MaxiCode 标为「预览仅」（位图通道），并在能力表里诚实写
//   "ZPL 手册有 ^BD，但本产品暂未覆盖（需 mode/邮编/国家码结构化参数）"。
//   本模块把这最后一句补上：提供 ^BD 原生指令构造，但保持「显式 opt-in」——
//   不改动默认打印通道行为（Mode 2/3 结构化数据一旦填错会被 UPS 拒收，
//   故默认仍走位图 + warning，专业用户可用本构造器/端点显式生成 ^BD）。
//
// 【^BD 语法（Zebra ZPL II 官方）】
//   ^BDm,n,t     m=模式(2/3 结构化载体 / 4/5/6 自由数据), n=符号序号(1-8), t=总数(1-8)
//   ^FH          开启十六进制转义，_XX 表示一个字节（GS=_1D, RS=_1E, EOT=_04, [=_5B）
//   ^FD<data>^FS 数据；Mode 2/3 的 <data> = 高优先级消息(hpm) + 低优先级消息(lpm)
//   注意：^BY 对 MaxiCode 无效、无旋转参数、固定约 1 英寸见方。
//
// 算法/语法来源见 docs/10 §10.32（Zebra ^BD 参考 + UPS MaxiCode 样例）。
// 纯函数、无副作用，可单测；真机打印/UPS 受理仍需硬件与承运商验收。
// =============================================================================

export type MaxicodeMode = 2 | 3 | 4 | 5 | 6;

export interface StructuredMaxicode {
  /** 2=美国数字邮编 / 3=非美国字母数字邮编 */
  mode: 2 | 3;
  /** 三位服务等级（class of service），如 001 / 066 */
  serviceClass: string;
  /** 三位国家码，如 840(US) / 826(UK) / 630(波多黎各) */
  countryCode: string;
  /** 邮编：Mode 2 五位数字；Mode 3 六位字母数字（不足补空格） */
  postalCode: string;
  /** Mode 2 四位邮编扩展（无则 0000）；Mode 3 忽略 */
  postalExtension?: string;
  /** 低优先级消息（UPS 结构化 `[)>\x1E...`；原样传入，由调用方保证格式） */
  lowPriority?: string;
}

export interface BdResult {
  /** 完整 ^BD 指令片段（含 ^FO 之外的部分，位置由调用方拼） */
  zpl: string;
  /** 十六进制转义后的 ^FD 数据 */
  escapedData: string;
  mode: MaxicodeMode;
  warnings: string[];
  ok: boolean;
}

/**
 * ZPL ^FH 十六进制转义：把非 ASCII 可打印与 ZPL 特殊字符转成 _XX。
 * - 下划线自身必须转 _5F（否则与转义引导符冲突）
 * - GS=_1D / RS=_1E / EOT=_04 / [ =_5B / ] =_5D
 * - ASCII 32–126 其余字符原样保留
 */
export function zplHexEscape(s: string): string {
  let out = '';
  for (const ch of String(s ?? '')) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126 && ch !== '_' && ch !== '[' && ch !== ']') {
      out += ch;
    } else {
      out += '_' + code.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/**
 * 构造 UPS Mode 2/3 结构化高优先级消息（hpm）。
 * Mode 2: aaa(服务) + bbb(国家) + ccccc(邮编5位) + dddd(扩展4位，缺省0000)
 * Mode 3: aaa + bbb + cccccc(邮编6位，字母数字，不足尾部补空格)
 */
export function buildHighPriorityMessage(spec: StructuredMaxicode): { hpm: string; ok: boolean; error?: string } {
  const three = (v: string, name: string): string | null => {
    const s = String(v ?? '');
    if (!/^\d{3}$/.test(s)) return `${name} 必须 3 位数字，实际 "${s}"`;
    return null;
  };
  let err = three(spec.serviceClass, '服务等级');
  if (err) return { hpm: '', ok: false, error: err };
  err = three(spec.countryCode, '国家码');
  if (err) return { hpm: '', ok: false, error: err };

  if (spec.mode === 2) {
    if (!/^\d{5}$/.test(String(spec.postalCode ?? ''))) {
      return { hpm: '', ok: false, error: 'Mode 2 邮编必须 5 位数字（不足前补 0）' };
    }
    const ext = spec.postalExtension ?? '0000';
    if (!/^\d{4}$/.test(String(ext))) {
      return { hpm: '', ok: false, error: 'Mode 2 邮编扩展必须 4 位数字（无则填 0000）' };
    }
    return { hpm: spec.serviceClass + spec.countryCode + spec.postalCode + ext, ok: true };
  }
  // Mode 3
  const postal = String(spec.postalCode ?? '').toUpperCase().padEnd(6, ' ').slice(0, 6);
  if (!/^[A-Z0-9 ]{6}$/.test(postal)) {
    return { hpm: '', ok: false, error: 'Mode 3 邮编必须 6 位字母数字（不足尾部补空格）' };
  }
  return { hpm: spec.serviceClass + spec.countryCode + postal, ok: true };
}

/** 默认结构化低优先级消息头（UPS `[)>\x1E01\x1D...` 的起始段；完整字段由调用方补） */
export const UPS_LPM_HEADER = '[)>\u001E01\u001D96';

/**
 * 构造 MaxiCode 的 ZPL ^BD 指令片段。
 * @param input 自由数据字符串，或 StructuredMaxicode 结构化对象
 * @param opts  mode/n/t；结构化输入时 mode 取自 spec
 */
export function buildMaxicodeZpl(
  input: string | StructuredMaxicode,
  opts: { n?: number; t?: number; mode?: MaxicodeMode } = {},
): BdResult {
  const warnings: string[] = [];
  const n = Math.min(8, Math.max(1, opts.n ?? 1));
  const t = Math.min(8, Math.max(1, opts.t ?? 1));

  let mode: MaxicodeMode;
  let rawData: string;

  if (typeof input === 'object' && input !== null) {
    const spec = input as StructuredMaxicode;
    mode = spec.mode;
    const hp = buildHighPriorityMessage(spec);
    if (!hp.ok) {
      return { zpl: '', escapedData: '', mode, warnings: [hp.error ?? '结构化数据非法'], ok: false };
    }
    const lpm = spec.lowPriority ?? UPS_LPM_HEADER;
    rawData = hp.hpm + lpm;
    warnings.push('Mode 2/3 为 UPS 结构化载体消息：请核对服务等级/国家码/邮编与 lowPriority 字段，格式错误会被承运商系统拒收');
  } else {
    mode = opts.mode ?? 4; // 自由数据默认 Mode 4
    if (mode === 2 || mode === 3) {
      return {
        zpl: '', escapedData: '', mode,
        warnings: ['Mode 2/3 需要结构化数据（serviceClass/countryCode/postalCode），请传结构化对象或改用 Mode 4/5/6'],
        ok: false,
      };
    }
    rawData = String(input ?? '');
    if (!rawData) return { zpl: '', escapedData: '', mode, warnings: ['MaxiCode 内容为空'], ok: false };
    if (rawData.length > 138) {
      warnings.push(`自由数据 ${rawData.length} 字符超过 Mode 4/5/6 上限 138，可能被截断`);
    }
  }

  const escapedData = zplHexEscape(rawData);
  // ^BY 对 MaxiCode 无效，故不输出 ^BY；^FH 开启十六进制转义
  const zpl = `^BD${mode},${n},${t}^FH^FD${escapedData}^FS`;
  warnings.push('MaxiCode 固定约 1 英寸见方、无旋转参数、^BY 无效；真机尺寸与 UPS 受理需硬件/承运商验收');
  return { zpl, escapedData, mode, warnings, ok: true };
}
