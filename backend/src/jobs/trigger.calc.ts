// =============================================================================
// trigger.calc.ts —— P8.1 自动化触发器「判定层」单一真源
//
// 【为什么要抽这一层】HotFolder / 打印完成事件 / 手动测试三个入口最终都要回答同一组问题：
//   哪条规则命中？条件是否为真？会不会级联成无限循环？这次投递和上次是不是同一件事？
//   如果判定散在 fs.watch 回调、Processor 和 Controller 里，一定会出现「文件被打印两次」
//   或「打印完成又触发打印」这类生产事故。这里全部做成纯函数，单测直接覆盖。
//
// 【分层】
//   - 本文件：规则归一化、SSRF 拦截、条件求值、循环防护、去重键、签名、稳定化、计划编排；
//   - trigger.service / trigger.processor / hotfolder.service：只做 IO，判定一律调这里。
//
// 【多租户红线】planDeliveries 里显式比较 rule.tenantId === event.tenantId，
//   绝不依赖「查出来的规则天然属于本租户」这种隐式假设（跨租户候选集是平台级扫描）。
// =============================================================================
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { safeEval } from '../../core/formula-engine';

/** 触发队列名：HotFolder 与打印完成事件统一入这个队列，避免进程内 EventEmitter 跨 worker 失效 */
export const TRIGGER_QUEUE = 'trigger';
export const TRIGGER_JOB = 'dispatch';

export const MAX_TRIGGER_DEPTH = 3;       // 触发链最大深度，防止 A→B→A 级联
export const STABLE_MS = 500;             // 文件稳定窗口（大小/mtime 连续两次一致）
export const MAX_DROP_ROWS = 5000;        // 单个落盘文件最多解析行数
export const WEBHOOK_TIMEOUT_MS = 5000;
export const MAX_CONDITION_LEN = 400;

export const TRIGGER_SOURCES = [
  'print.job.completed',
  'print.job.failed',
  'template.updated',
  'hotfolder.file',
  'subscription.expiring',
] as const;
export type TriggerSource = typeof TRIGGER_SOURCES[number];

export const TRIGGER_ACTIONS = ['webhook', 'notification', 'print'] as const;
export type TriggerAction = typeof TRIGGER_ACTIONS[number];

export interface TriggerRule {
  id: number;
  tenantId: number;
  name: string;
  source: TriggerSource;
  /** 条件表达式（公式引擎语法，变量用 {{name}} 占位，与模板 printIf 同源）；空 = 恒真 */
  conditionExpr: string | null;
  action: TriggerAction;
  config: Record<string, any>;
  enabled: boolean;
}

export interface TriggerEvent {
  source: TriggerSource | string;
  tenantId: number;
  payload: Record<string, any>;
  /** 稳定事件 id；同一事件重复投递靠它去重 */
  eventId?: string;
  /** 触发链深度，0 = 原始事件 */
  depth?: number;
}

export interface RuleDraft {
  name?: string;
  source?: string;
  conditionExpr?: string | null;
  action?: string;
  config?: Record<string, any>;
  enabled?: boolean;
}

export interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  value?: T;
}

// -----------------------------------------------------------------------------
// 1. Webhook URL 校验（SSRF 防线）
//    出站 Webhook 是典型的 SSRF 入口：用户若能填 http://169.254.169.254/ 就能读云元数据。
//    规则创建时校验一次，真实投递前再校验一次（防止配置被绕过/历史脏数据）。
// -----------------------------------------------------------------------------

const FORBIDDEN_HOST_RE = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:|localhost$|.*\.localhost$|.*\.local$|metadata\.google\.internal$|.*\.internal$)/i;

function isLoopback(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(host);
}

export function validateWebhookUrl(
  raw: string,
  opts: { allowHttpLoopback?: boolean } = {},
): { ok: boolean; reason?: string; url?: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: 'webhook url 不能为空' };
  if (s.length > 2000) return { ok: false, reason: 'webhook url 过长（上限 2000）' };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, reason: 'webhook url 格式非法' }; }
  if (u.username || u.password) return { ok: false, reason: 'webhook url 禁止内嵌用户名/密码' };
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: '仅允许 http/https 协议' };
  if (u.protocol === 'http:' && !(opts.allowHttpLoopback && isLoopback(u.hostname))) {
    return { ok: false, reason: '生产仅允许 https；http 仅在本机调试且显式开启时放行' };
  }
  // https 也要挡内网：协议合法不代表目标安全
  if (FORBIDDEN_HOST_RE.test(u.hostname) && !(opts.allowHttpLoopback && isLoopback(u.hostname))) {
    return { ok: false, reason: `禁止指向内网/回环/元数据地址：${u.hostname}` };
  }
  if (u.port && (Number(u.port) < 1 || Number(u.port) > 65535)) {
    return { ok: false, reason: '端口非法' };
  }
  return { ok: true, url: u.toString() };
}

// -----------------------------------------------------------------------------
// 2. 规则归一化与校验（写入前的唯一入口）
// -----------------------------------------------------------------------------

/** 条件表达式只做静态风控：真正的求值在事件到达时进行（那时才有 payload）。
 *  变量必须用 {{name}} 占位（core/formula-engine 的 tokenize 规则），与模板公式、printIf 同源；
 *  未定义变量/语法错一律 fail-closed 不匹配，不会误触发。 */
export function validateConditionExpr(expr: string | null | undefined): string[] {
  if (expr === null || expr === undefined || String(expr).trim() === '') return [];
  const s = String(expr);
  const errs: string[] = [];
  if (s.length > MAX_CONDITION_LEN) errs.push(`条件表达式过长（上限 ${MAX_CONDITION_LEN}）`);
  if (/[;`]/.test(s)) errs.push('条件表达式禁止分号与反引号');
  if (/\b(process|require|global|constructor|__proto__|eval)\b/i.test(s)) {
    errs.push('条件表达式含禁用标识符');
  }
  return errs;
}

export function normalizeRule(
  draft: RuleDraft,
  ctx: { tenantId: number; id?: number },
): ValidationResult<Omit<TriggerRule, 'id'> & { id: number }> {
  const errors: string[] = [];
  const name = String(draft.name ?? '').trim();
  if (!name) errors.push('name 必填');
  if (name.length > 80) errors.push('name 过长（上限 80）');

  const source = String(draft.source ?? '') as TriggerSource;
  if (!TRIGGER_SOURCES.includes(source)) errors.push(`未知事件源：${draft.source}`);

  const action = String(draft.action ?? '') as TriggerAction;
  if (!TRIGGER_ACTIONS.includes(action)) errors.push(`未知动作：${draft.action}`);

  errors.push(...validateConditionExpr(draft.conditionExpr));

  const config = (draft.config && typeof draft.config === 'object') ? { ...draft.config } : {};
  if (action === 'webhook') {
    const v = validateWebhookUrl(String(config.url ?? ''), {
      // 只有显式声明调试意图才允许 http://localhost，且仅在本机单测/开发环境
      allowHttpLoopback: config.allowHttpLoopback === true,
    });
    if (!v.ok) errors.push(`webhook: ${v.reason}`);
    else config.url = v.url;
    if (config.secret !== undefined && String(config.secret).length > 128) errors.push('webhook secret 过长');
  } else if (action === 'notification') {
    if (!String(config.title ?? '').trim()) errors.push('notification.title 必填');
    if (!String(config.body ?? '').trim()) errors.push('notification.body 必填');
    if (String(config.title ?? '').length > 200) errors.push('notification.title 过长');
    if (String(config.body ?? '').length > 2000) errors.push('notification.body 过长');
  } else if (action === 'print') {
    const tpl = Number(config.templateId);
    if (!Number.isInteger(tpl) || tpl <= 0) errors.push('print.templateId 必须为正整数');
    const copies = Number(config.copies ?? 1);
    if (!Number.isInteger(copies) || copies < 1 || copies > 500) errors.push('print.copies 必须在 1..500');
    if (config.printerId !== undefined && config.printerId !== null && String(config.printerId) !== '') {
      const p = Number(config.printerId);
      if (!Number.isInteger(p) || p <= 0) errors.push('print.printerId 必须为正整数');
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      id: ctx.id ?? 0,
      tenantId: ctx.tenantId,
      name,
      source,
      conditionExpr: draft.conditionExpr ? String(draft.conditionExpr).trim() : null,
      action,
      config,
      enabled: draft.enabled !== false,
    },
  };
}

// -----------------------------------------------------------------------------
// 3. 条件求值（fail-closed）
// -----------------------------------------------------------------------------

/** payload 扁平化：只把标量放进公式上下文，嵌套对象不暴露（避免表达式摸到内部对象） */
export function conditionContext(payload: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

export function matchCondition(
  expr: string | null | undefined,
  payload: Record<string, any>,
): { matched: boolean; reason: string } {
  if (!expr || !String(expr).trim()) return { matched: true, reason: '无条件（恒真）' };
  const r = safeEval(String(expr), conditionContext(payload));
  if (!r.ok) return { matched: false, reason: `条件求值失败，fail-closed 不匹配：${r.error}` };
  return { matched: !!r.value, reason: r.value ? '条件为真' : '条件为假' };
}

// -----------------------------------------------------------------------------
// 4. 循环防护
// -----------------------------------------------------------------------------

export function guardLoop(event: TriggerEvent, rule: TriggerRule): { allowed: boolean; reason: string } {
  const depth = Number(event.depth ?? 0);
  if (!Number.isFinite(depth) || depth < 0 || depth >= MAX_TRIGGER_DEPTH) {
    return { allowed: false, reason: `触发深度 ${depth} 达上限 ${MAX_TRIGGER_DEPTH}，丢弃以防级联` };
  }
  // 打印完成/失败 → 再打印是最经典的无限循环：completed → print → completed → ...
  if (String(event.source).startsWith('print.') && rule.action === 'print') {
    return { allowed: false, reason: '禁止「打印事件 → 再打印」直连；补打请用人工重打或显式队列' };
  }
  return { allowed: true, reason: 'ok' };
}

// -----------------------------------------------------------------------------
// 5. 去重 / 签名 / 稳定化 / 退避
// -----------------------------------------------------------------------------

/** 确定性序列化：键排序，避免对象键顺序不同导致 dedupe 失效 */
function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

export function fingerprint(v: any): string {
  return createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, 32);
}

export function dedupeKey(ruleId: number, event: TriggerEvent): string {
  const stable = event.eventId ? String(event.eventId) : fingerprint({ source: event.source, payload: event.payload });
  return `trig:${ruleId}:${stable}`.slice(0, 160);
}

/** 落盘文件去重键：路径 + 大小 + mtime，内容变化会重新触发（覆盖「同名覆盖」场景） */
export function dropFileKey(ruleId: number, filePath: string, stat: { size: number; mtimeMs: number }): string {
  return `drop:${ruleId}:${fingerprint({ filePath, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) })}`.slice(0, 160);
}

export function signatureHeaders(body: string, secret: string, nowMs: number): Record<string, string> {
  const ts = Math.floor(nowMs / 1000);
  const mac = createHmac('sha256', String(secret ?? '')).update(`${ts}.${body}`).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-LabelFlow-Timestamp': String(ts),
    'X-LabelFlow-Signature': `sha256=${mac}`,
  };
}

/** 供接收方/单测校验；toleranceSec 防重放窗口 */
export function verifySignature(
  body: string, secret: string, tsHeader: string, sigHeader: string,
  nowMs: number, toleranceSec = 300,
): boolean {
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(nowMs / 1000) - ts) > toleranceSec) return false;
  const expected = createHmac('sha256', String(secret ?? '')).update(`${ts}.${body}`).digest();
  const got = String(sigHeader ?? '').replace(/^sha256=/, '');
  if (!/^[0-9a-f]{64}$/i.test(got)) return false;
  try { return timingSafeEqual(expected, Buffer.from(got, 'hex')); } catch { return false; }
}

export interface FileStat { size: number; mtimeMs: number; seenAt: number }

/** 文件稳定化：写入中的文件不能读（否则解析到半截 CSV）。连续两次 stat 一致且过了稳定窗口才处理。 */
export function fileStable(prev: FileStat | null, curr: FileStat, nowMs = Date.now()): { stable: boolean; reason: string } {
  if (!prev) return { stable: false, reason: '首次观测，等待下一次采样' };
  if (prev.size !== curr.size || prev.mtimeMs !== curr.mtimeMs) return { stable: false, reason: '文件仍在写入（size/mtime 变化）' };
  if (nowMs - prev.seenAt < STABLE_MS) return { stable: false, reason: '稳定窗口未到' };
  return { stable: true, reason: 'size/mtime 连续两次一致且已过稳定窗口' };
}

export function backoffDelay(attempt: number, baseMs = 1000, capMs = 30_000): number {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(capMs, baseMs * Math.pow(2, n));
}

// -----------------------------------------------------------------------------
// 6. 事件编排（核心可测函数）
// -----------------------------------------------------------------------------

export interface PlannedDelivery { rule: TriggerRule; dedupeKey: string; reason: string }
export interface PlanResult {
  deliveries: PlannedDelivery[];
  skipped: Array<{ ruleId: number; reason: string }>;
}

export function planDeliveries(rules: TriggerRule[], event: TriggerEvent): PlanResult {
  const deliveries: PlannedDelivery[] = [];
  const skipped: Array<{ ruleId: number; reason: string }> = [];
  for (const rule of rules ?? []) {
    // 多租户红线：候选集可能来自跨租户扫描，必须显式比较 tenant_id
    if (Number(rule.tenantId) !== Number(event.tenantId)) {
      skipped.push({ ruleId: rule.id, reason: '跨租户规则，硬拦截' });
      continue;
    }
    if (!rule.enabled) { skipped.push({ ruleId: rule.id, reason: '规则已停用' }); continue; }
    if (rule.source !== event.source) { skipped.push({ ruleId: rule.id, reason: '事件源不匹配' }); continue; }
    const cond = matchCondition(rule.conditionExpr, event.payload);
    if (!cond.matched) { skipped.push({ ruleId: rule.id, reason: cond.reason }); continue; }
    const loop = guardLoop(event, rule);
    if (!loop.allowed) { skipped.push({ ruleId: rule.id, reason: loop.reason }); continue; }
    deliveries.push({ rule, dedupeKey: dedupeKey(rule.id, event), reason: cond.reason });
  }
  return { deliveries, skipped };
}

/** 返回给前端的配置：剔除密钥类字段，webhook secret 绝不出域 */
export function publicConfig(config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config ?? {})) {
    if (/^(secret|secretenc|password|token|apikey)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 打印 Processor 的进度事件 → 触发器事件（只认 completed，其余进度事件不触发） */
export function printProgressToTrigger(ev: any): TriggerEvent | null {
  if (!ev || ev.type !== 'completed') return null;
  const tenantId = Number(ev.tenantId);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return null;
  const status = String(ev.status ?? '');
  return {
    source: status === 'success' ? 'print.job.completed' : 'print.job.failed',
    tenantId,
    payload: {
      jobId: ev.jobId, status,
      done: Number(ev.done ?? 0), failed: Number(ev.failed ?? 0), total: Number(ev.total ?? 0),
    },
    eventId: `print:${ev.jobId}:${ev.at ?? ''}`,
    depth: 0,
  };
}
