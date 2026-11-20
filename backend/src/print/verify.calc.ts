// =============================================================================
// verify.calc.ts —— 打印后解码验证判定层（第三层 · 码制专业性）
//
// 【解决什么】B6「三方一致性」一直未真正闭环：前端预览（bwip）、指令生成
//   （ZPL/TSPL/EPL）、位图渲染（sharp）三者对同一内容是否产出可扫的同一条码，
//   过去没有任何自动验证。本模块把「解码文本 vs 期望内容」的判定做成纯函数，
//   单一真源，供 HTTP 端点、批处理脚本、单测共用。
//
// 【边界（诚实）】
//   - 本层只判定「解码出来的文本是否等于期望」，不做图像采集/打印真机验收；
//   - 真实打印机 + 扫描枪的通道效果仍需硬件验收，见 docs/10 §10.32；
//   - GS1 的 FNC1 在不同解码器里表现为 ]d2/]C1/\u001D 或 AI 括号，判定做归一化。
// =============================================================================

/** 判定等级：exact=逐字相同 / normalized=归一化后相同 / none=不匹配 */
export type MatchGrade = 'exact' | 'normalized' | 'none';

export interface CompareVerdict {
  match: boolean;
  grade: MatchGrade;
  /** 0–100，exact=100，normalized=80，none=按编辑距离折算 */
  score: number;
  expected: string;
  decoded: string;
  reason: string;
}

/** LabelFlow 码制 → zxing 期望格式族（用于判断解码格式是否对得上） */
export function symFormatFamily(sym: string): string {
  const s = String(sym ?? '').toUpperCase();
  if (/QR|MICRO/.test(s)) return 'QR';
  if (/DATAMATRIX/.test(s)) return 'DATAMATRIX';
  if (/PDF417/.test(s)) return 'PDF417';
  if (/AZTEC/.test(s)) return 'AZTEC';
  if (/MAXICODE/.test(s)) return 'MAXICODE';
  if (/HIBC/.test(s)) return 'HIBC';
  if (/EAN13/.test(s)) return 'EAN13';
  if (/EAN8/.test(s)) return 'EAN8';
  if (/UPC/.test(s)) return 'UPC';
  if (/ITF/.test(s)) return 'ITF';
  if (/GS1/.test(s)) return 'GS1';
  if (/CODE128/.test(s)) return 'CODE128';
  if (/CODE39/.test(s)) return 'CODE39';
  if (/CODE93/.test(s)) return 'CODE93';
  if (/CODABAR/.test(s)) return 'CODABAR';
  if (/MSI/.test(s)) return 'MSI';
  if (/PHARMACODE|CODE16K/.test(s)) return 'LINEAR';
  return 'LINEAR';
}

/** zxing 解码格式名 → 格式族（与 symFormatFamily 同口径） */
export function zxingFormatFamily(format: string): string {
  const f = String(format ?? '').toUpperCase();
  if (/QR/.test(f)) return 'QR';
  if (/DATA.?MATRIX/.test(f)) return 'DATAMATRIX';
  if (/PDF417/.test(f)) return 'PDF417';
  if (/AZTEC/.test(f)) return 'AZTEC';
  if (/MAXICODE/.test(f)) return 'MAXICODE';
  if (/EAN_?13/.test(f)) return 'EAN13';
  if (/EAN_?8/.test(f)) return 'EAN8';
  if (/UPC/.test(f)) return 'UPC';
  if (/ITF|INTERLEAVED/.test(f)) return 'ITF';
  if (/CODABAR/.test(f)) return 'CODABAR';
  if (/MSI/.test(f)) return 'MSI';
  if (/CODE_?128/.test(f)) return 'CODE128';
  if (/CODE_?39/.test(f)) return 'CODE39';
  if (/CODE_?93/.test(f)) return 'CODE93';
  return 'LINEAR';
}

/**
 * 解码文本归一化：把不同解码器对同一语义的多种表达压成可比形式。
 * - GS1 前缀 ]d2 / ]C1 / ]d1 / ]e0（zxing 的 symbology identifier）统一剥离；
 * - FNC1 控制字符 (\u001D) 与 GS 字符去掉；
 * - 去掉首尾空白；可选忽略大小写（Code128/39 默认大小写敏感，故默认不忽略）。
 */
export function normalizeDecoded(text: string, opts: { ignoreCase?: boolean } = {}): string {
  let t = String(text ?? '');
  // 剥离 zxing/GS1 symbology identifier 前缀（] + 1 字母 + 可选 1 数字：]d2/]C1/]e0/]Q3）
  // 不能贪婪吃满 3 位，否则 ]C1ABC 会把数据首位 A 当前缀吞掉
  t = t.replace(/^\][A-Za-z][0-9]?/, '');
  // 去 FNC1 / GS / RS 控制字符
  t = t.replace(/[\u001D\u001E\u001F]/g, '');
  t = t.trim();
  if (opts.ignoreCase) t = t.toLowerCase();
  return t;
}

/** Levenshtein 编辑距离（纯函数，短串足够快） */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** 相似度分数 0–100 */
function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 100;
  return Math.round(100 * (1 - editDistance(a, b) / max));
}

/**
 * 判定单条解码结果是否等于期望内容。
 * @param expected 模板里条码元素的期望文本
 * @param decoded  zxing 解码出的文本
 * @param sym      码制（决定归一化规则）
 */
export function compareDecoded(expected: string, decoded: string, sym: string): CompareVerdict {
  const exp = String(expected ?? '');
  const normExpected = normalizeDecoded(exp, { ignoreCase: false });
  const normDecoded = normalizeDecoded(decoded, { ignoreCase: false });

  if (normDecoded === normExpected) {
    const exact = decoded === exp;
    return {
      match: true,
      grade: exact ? 'exact' : 'normalized',
      score: exact ? 100 : 80,
      expected: exp,
      decoded: String(decoded ?? ''),
      reason: exact ? '逐字一致' : '归一化后一致（GS1 前缀/控制字符/空白差异）',
    };
  }

  const lowerMatch = normDecoded.toLowerCase() === normExpected.toLowerCase();
  if (lowerMatch) {
    return {
      match: true, grade: 'normalized', score: 78,
      expected: exp, decoded: String(decoded ?? ''),
      reason: '忽略大小写后一致',
    };
  }

  const score = similarity(normExpected, normDecoded);
  return {
    match: false, grade: 'none', score,
    expected: exp, decoded: String(decoded ?? ''),
    reason: score >= 70 ? '内容高度相似但不一致（疑似校验位/字符差异）' : '解码内容与期望不一致',
  };
}

export interface CandidateDecoded {
  text: string;
  format: string;
}

export interface VerifyVerdict extends CompareVerdict {
  /** 命中的候选数量 */
  hitCount: number;
  /** 解码格式族是否与码制期望一致 */
  formatOk: boolean;
  /** 附加提示（如「识别到多个码，取最匹配者」） */
  notes: string[];
}

/**
 * 聚合多次/多区域解码结果，给出最终判定。
 * 取与期望最匹配的候选；格式族不符时给 note 但不直接判失败（解码器格式名可能异名）。
 */
export function verdictOf(candidates: CandidateDecoded[], expected: string, sym: string): VerifyVerdict {
  const notes: string[] = [];
  if (candidates.length === 0) {
    return {
      match: false, grade: 'none', score: 0,
      expected, decoded: '', reason: '未能从图像中解出任何条码',
      hitCount: 0, formatOk: false, notes: ['解码无结果：检查图像清晰度/静区/模块宽'],
    };
  }

  const scored = candidates.map((c) => ({ c, v: compareDecoded(expected, c.text, sym) }));
  scored.sort((a, b) => (b.v.match ? 1000 + b.v.score : b.v.score) - (a.v.match ? 1000 + a.v.score : a.v.score));
  const best = scored[0];
  const wantFamily = symFormatFamily(sym);
  const formatOk = scored.some((s) => zxingFormatFamily(s.c.format) === wantFamily);
  if (!formatOk) notes.push(`解码格式族与期望 ${wantFamily} 不一致（识别到 ${[...new Set(scored.map((s) => s.c.format))].join('/')}）`);
  if (candidates.length > 1) notes.push(`识别到 ${candidates.length} 个码，取最匹配者`);

  return { ...best.v, hitCount: candidates.length, formatOk, notes };
}
