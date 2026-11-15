// =============================================================================
// inkjet.calc.ts —— P8.5 喷码机 / 打码机输出协议「判定层单一真源」
//
// 【范围界定】CIJ（连续喷墨）/ TIJ（热发泡）/ 激光打码机的**指令集是厂商私有**
// （Videojet / Domino / Markem-Imaje / Linx 各家不兼容，且多需厂商 SDK 或串口协议）。
// 本文件做的是厂商中立的**作业数据契约**：把「一模板多数据」转成
// 「逐件喷印的行文本 + 触发参数」信封，本地代理再按具体品牌翻译。
// 好处：换品牌只改代理适配器，服务端与模板不动；坏处要如实说明 ——
// 这里没有、也不会假装有任何一家真机的指令实现，见 docs/10 §10.30。
//
// 【不变式】
//   1. 纯函数、显式 now / 不读系统时钟、不引第三方；
//   2. 行数 / 字符数 / 字符集在生成侧就夹取并给 warnings，绝不把超长文本悄悄发给设备；
//   3. 变量占位与模板引擎同源 {{name}}，缺失变量输出空串并记 warning（fail-visible）；
//   4. jobKey 稳定哈希，重放/重试幂等。
// =============================================================================
import { fingerprint } from '../jobs/trigger.calc';

export const INKJET_MAX_LINES = 8;
export const INKJET_MAX_CHARS_PER_LINE = 200;
export const INKJET_MAX_ITEMS = 5000;
/**
 * 控制字符处理不用正则：ESLint no-control-regex 会拦，且逐码点判定更直观。
 * 可打印 ASCII 从 0x20 起，0x7F(DEL) 单列；中文等 Unicode 文字码点 > 0x7F，正常保留。
 */
export function stripInkjetControlChars(v: string): string {
  let out = '';
  for (const ch of String(v ?? '')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x20 && c !== 0x7F) out += ch;
  }
  return out;
}

export function hasInkjetControlChars(v: string): boolean {
  for (const ch of String(v ?? '')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7F) return true;
  }
  return false;
}

const PLACEHOLDER_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
export type TriggerMode = 'encoder' | 'sensor' | 'continuous';
export const TRIGGER_MODES: TriggerMode[] = ['encoder', 'sensor', 'continuous'];

export interface InkjetLine {
  text: string;
  fontHeightMm: number;
  boldMultiplier: number;
  /** 该行相对触发点的延时（mm），用于多喷头/多行错位补偿 */
  delayMm: number;
  reverse: boolean;
}

export interface InkjetItem {
  index: number;
  lines: InkjetLine[];
  /** 该件的数据快照（回执与追溯用，不含敏感凭证） */
  data: Record<string, any>;
}

export interface InkjetJob {
  version: string;
  jobKey: string;
  tenantId: number;
  jobId: number;
  dpi: number;
  direction: 0 | 180;
  trigger: {
    mode: TriggerMode;
    pulsesPerMm: number;
    debounceMs: number;
    /** 连续模式下每件间隔（mm） */
    intervalMm: number;
  };
  items: InkjetItem[];
  warnings: string[];
}

export interface InkjetConfig {
  /** 每行模板，支持 {{name}} 占位 */
  lines?: Array<{ text?: string; fontHeightMm?: number; bold?: number; delayMm?: number; reverse?: boolean }>;
  dpi?: number;
  direction?: number;
  triggerMode?: string;
  pulsesPerMm?: number;
  debounceMs?: number;
  intervalMm?: number;
}

/** 变量替换：与模板引擎同源 {{name}}；缺值输出空串并记 warning，不抛异常中断整批 */
export function expandInkjetText(tpl: string, row: Record<string, any>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const replaced = String(tpl ?? '').replace(PLACEHOLDER_RE, (_m, key: string) => {
    const v = row?.[key];
    if (v === undefined || v === null) { if (!missing.includes(key)) missing.push(key); return ''; }
    return String(v);
  });
  // 控制字符会让设备解析错位，统一剔除
  const text = stripInkjetControlChars(replaced);
  return { text, missing };
}

function clamp(v: any, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * 生成喷码作业。超长文本**截断并记 warning**（不是静默截断），
 * 行数超上限直接丢弃多余行并记 warning —— 设备缓冲区有限，宁可少喷不可溢出。
 */
export function inkjetJob(
  tenantId: number, jobId: number, rows: Record<string, any>[], config: InkjetConfig = {},
): InkjetJob {
  const warnings: string[] = [];
  const lineTpls = (Array.isArray(config.lines) ? config.lines : []).slice(0, INKJET_MAX_LINES);
  if ((config.lines ?? []).length > INKJET_MAX_LINES) {
    warnings.push(`行模板超过 ${INKJET_MAX_LINES} 行，多余行已忽略`);
  }
  const safeRows = (Array.isArray(rows) ? rows : []).slice(0, INKJET_MAX_ITEMS);
  if ((rows ?? []).length > INKJET_MAX_ITEMS) warnings.push(`数据行超过 ${INKJET_MAX_ITEMS}，多余行已忽略`);

  const items: InkjetItem[] = [];
  safeRows.forEach((row, i) => {
    const lines: InkjetLine[] = [];
    lineTpls.forEach((t, li) => {
      const { text, missing } = expandInkjetText(String(t?.text ?? ''), row ?? {});
      if (missing.length) warnings.push(`第 ${i + 1} 件第 ${li + 1} 行缺少变量：${missing.join(',')}`);
      let out = text;
      if (out.length > INKJET_MAX_CHARS_PER_LINE) {
        warnings.push(`第 ${i + 1} 件第 ${li + 1} 行超 ${INKJET_MAX_CHARS_PER_LINE} 字符，已截断`);
        out = out.slice(0, INKJET_MAX_CHARS_PER_LINE);
      }
      lines.push({
        text: out,
        fontHeightMm: clamp(t?.fontHeightMm, 1, 30, 3),
        boldMultiplier: clamp(t?.bold, 1, 4, 1),
        delayMm: clamp(t?.delayMm, 0, 500, 0),
        reverse: t?.reverse === true,
      });
    });
    items.push({ index: i + 1, lines, data: { ...(row ?? {}) } });
  });

  const rawMode = String(config.triggerMode ?? '');
  const mode: TriggerMode = (TRIGGER_MODES as string[]).includes(rawMode) ? rawMode as TriggerMode : 'sensor';
  // 判定必须针对「原始值」而非回落后的 mode，否则 warning 永远不会触发
  if (config.triggerMode && !(TRIGGER_MODES as string[]).includes(rawMode)) {
    warnings.push('未知触发模式，已回落 sensor');
  }
  const dpi = Math.round(clamp(config.dpi, 100, 1200, 300));
  const direction: 0 | 180 = Number(config.direction) === 180 ? 180 : 0;
  const job: InkjetJob = {
    version: '1.0', jobKey: '', tenantId: Number(tenantId), jobId: Number(jobId),
    dpi, direction,
    trigger: {
      mode,
      pulsesPerMm: clamp(config.pulsesPerMm, 0.1, 1000, 10),
      debounceMs: clamp(config.debounceMs, 0, 5000, 50),
      intervalMm: clamp(config.intervalMm, 0, 5000, 100),
    },
    items, warnings,
  };
  job.jobKey = fingerprint({ t: tenantId, j: jobId, it: items.map((x) => x.lines) });
  return job;
}

/** 下发前终检：作业结构合法性（生成侧已夹取，这里是第二道 fail-closed） */
export function validateInkjetJob(job: InkjetJob): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!job || !Number.isInteger(job.tenantId) || job.tenantId <= 0) errors.push('tenant_id 非法');
  if (!job || !Number.isInteger(job.jobId) || job.jobId < 0) errors.push('jobId 非法');
  if (!job || !TRIGGER_MODES.includes(job.trigger?.mode)) errors.push('触发模式非法');
  if (!job || !Array.isArray(job.items) || !job.items.length) errors.push('作业没有可喷印内容');
  for (const it of job?.items ?? []) {
    if (it.lines.length > INKJET_MAX_LINES) errors.push(`第 ${it.index} 件行数超限`);
    for (const l of it.lines) {
      if (l.text.length > INKJET_MAX_CHARS_PER_LINE) errors.push(`第 ${it.index} 件存在超长行`);
      if (hasInkjetControlChars(l.text)) errors.push(`第 ${it.index} 件存在控制字符`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 厂商中立的下发载荷（纯文本）：
 *   # 头部声明版本/触发参数，随后每件一段 LINES。
 * 本地代理按具体品牌 SDK/串口协议翻译；本文件不产生任何厂商私有指令。
 */
export function inkjetPayload(job: InkjetJob): string {
  const head = [
    `#LABELFLOW-INKJET/${job.version}`,
    `#JOBKEY ${job.jobKey}`,
    `#DPI ${job.dpi} DIRECTION ${job.direction}`,
    `#TRIGGER ${job.trigger.mode} PULSES_PER_MM ${job.trigger.pulsesPerMm} DEBOUNCE_MS ${job.trigger.debounceMs} INTERVAL_MM ${job.trigger.intervalMm}`,
    `#ITEMS ${job.items.length}`,
  ];
  const body = job.items.flatMap((it) => [
    `ITEM ${it.index} LINES ${it.lines.length}`,
    ...it.lines.map((l) => `L|h=${l.fontHeightMm}|b=${l.boldMultiplier}|d=${l.delayMm}|r=${l.reverse ? 1 : 0}|${l.text}`),
  ]);
  return [...head, ...body].join('\n');
}
