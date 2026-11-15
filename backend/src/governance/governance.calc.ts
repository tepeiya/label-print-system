// =============================================================================
// governance.calc.ts —— P8.3 企业治理「判定层」单一真源
//
// 【为什么抽这一层】模板发布审批、防重打印、数量策略、水印、发布锁定这五件事，
// 最终都要回答同一组问题：这个状态能不能迁到那个状态？这次打印和上次是不是同一批？
// 数量有没有超？水印画在哪里？判定若散在 Controller / Service / 渲染器里必然漂移，
// 出现「后台显示已发布但还能改」「防重只在单入口生效」这类企业版最忌讳的事故。
// 本文件零 Nest / TypeORM 依赖，node --test + tsx 直接覆盖。
//
// 【默认宽松（重要）】所有策略默认关闭。存量租户没有配置行 → 行为与 P8.2 完全一致：
// 模板照常编辑、照常打印、无水印、无防重。治理能力按租户灰度开启，
// 绝不因为上线一个新功能把现有打印链路挡住（与 P8.1 新维度限流默认关闭同一口径）。
//
// 【多租户红线】所有指纹都显式带 tenantId；审批候选集在 Service 层按 tenant_id 过滤，
// 且状态迁移前再次比对 governance 行的 tenantId，禁止「查出来就当作本租户的」。
// =============================================================================
import { fingerprint } from '../jobs/trigger.calc';

// -----------------------------------------------------------------------------
// 一、模板发布状态机（模板审批流程 / 发布锁定）
// -----------------------------------------------------------------------------

export const TEMPLATE_STATUSES = ['draft', 'in_review', 'published', 'rejected', 'archived'] as const;
export type TemplateStatus = typeof TEMPLATE_STATUSES[number];

export const STATUS_LABEL: Record<TemplateStatus, string> = {
  draft: '草稿', in_review: '待审批', published: '已发布',
  rejected: '已驳回', archived: '已归档',
};

/** 现有系统角色（docs/10 §10.4）：admin / operator / viewer / sql，不另造 designer */
export const GOV_WRITERS = ['admin', 'operator'] as const;
export const GOV_APPROVERS = ['admin'] as const;

export const GOVERNANCE_ACTIONS = [
  'submit', 'approve', 'reject', 'request_change', 'archive', 'publish',
] as const;
export type GovernanceAction = typeof GOVERNANCE_ACTIONS[number];

export interface Transition {
  from: TemplateStatus[];
  to: TemplateStatus;
  /** 允许执行该迁移的角色（任一命中即可） */
  roles: readonly string[];
  auditAction: string;
  /** 强制填写理由（驳回 / 应急直发必须留痕，便于事后追责） */
  needComment?: boolean;
}

/**
 * 合法迁移表。注意「发布后不可直接编辑」不是靠一个 if 挡住 update，
 * 而是状态机层面要求先 request_change 退回 draft —— 这样每次改动都有对应的审批记录。
 * publish 是应急通道（跳过评审），强制写理由并单独打审计 action，便于审计筛出「谁绕过流程」。
 */
export const TRANSITIONS: Record<GovernanceAction, Transition> = {
  submit:         { from: ['draft'], to: 'in_review', roles: GOV_WRITERS, auditAction: 'template.review.submit' },
  approve:        { from: ['in_review'], to: 'published', roles: GOV_APPROVERS, auditAction: 'template.review.approve' },
  reject:         { from: ['in_review'], to: 'rejected', roles: GOV_APPROVERS, auditAction: 'template.review.reject', needComment: true },
  // 发布锁定核心：published 要改，必须先退回草稿再走完整评审
  request_change: { from: ['in_review', 'published', 'rejected', 'archived'], to: 'draft', roles: GOV_WRITERS, auditAction: 'template.review.request_change' },
  archive:        { from: ['draft', 'published'], to: 'archived', roles: GOV_APPROVERS, auditAction: 'template.review.archive' },
  publish:        { from: ['draft', 'in_review', 'rejected'], to: 'published', roles: GOV_APPROVERS, auditAction: 'template.review.publish_emergency', needComment: true },
};

export interface TransitionVerdict {
  allowed: boolean;
  to?: TemplateStatus;
  reason: string;
  auditAction?: string;
}

/** 状态迁移判定（纯函数，不改库）。Service 负责事务内落库 + 审计 + 通知 */
export function transitionVerdict(
  from: TemplateStatus | null | undefined,
  action: string,
  roles: string[] = [],
  comment?: string | null,
): TransitionVerdict {
  if (!GOVERNANCE_ACTIONS.includes(action as GovernanceAction)) {
    return { allowed: false, reason: `未知的审批动作 "${action}"` };
  }
  const t = TRANSITIONS[action as GovernanceAction];
  const current: TemplateStatus = from && TEMPLATE_STATUSES.includes(from) ? from : 'draft';
  if (!t.from.includes(current)) {
    return {
      allowed: false,
      reason: `当前状态「${STATUS_LABEL[current]}」不允许执行「${action}」；合法来源：${t.from.map((s) => STATUS_LABEL[s]).join('、')}`,
    };
  }
  if (!roles.some((r) => t.roles.includes(r))) {
    return { allowed: false, reason: `当前角色无权限执行「${action}」（需要 ${t.roles.join(' 或 ')}）` };
  }
  if (t.needComment && !String(comment ?? '').trim()) {
    return { allowed: false, reason: `「${action}」必须填写理由（审计留痕要求）` };
  }
  return {
    allowed: true, to: t.to,
    reason: `${STATUS_LABEL[current]} → ${STATUS_LABEL[t.to]}`,
    auditAction: t.auditAction,
  };
}

/** 编辑准入。strict=false 或 无治理记录（存量模板）一律放行 */
export function editVerdict(status: TemplateStatus | null | undefined, strict: boolean): { allowed: boolean; reason: string } {
  if (!strict) return { allowed: true, reason: '治理未开启严格发布模式' };
  if (!status) return { allowed: true, reason: '该模板尚无治理记录（存量模板放行）' };
  if (status === 'draft' || status === 'rejected') return { allowed: true, reason: '草稿 / 驳回状态可编辑' };
  return {
    allowed: false,
    reason: `模板处于「${STATUS_LABEL[status]}」，发布锁定生效；请先执行 request_change 退回草稿再修改`,
  };
}

/** 打印准入。strict=true 时只有 published 可打印；无治理记录放行，避免存量租户被挡 */
export function printVerdict(status: TemplateStatus | null | undefined, strict: boolean): { allowed: boolean; reason: string } {
  if (!strict) return { allowed: true, reason: '治理未开启严格发布模式' };
  if (!status) return { allowed: true, reason: '该模板尚无治理记录（存量模板放行）' };
  if (status === 'published') return { allowed: true, reason: '已发布模板允许打印' };
  return {
    allowed: false,
    reason: `模板处于「${STATUS_LABEL[status]}」，仅「已发布」模板允许打印`,
  };
}

// -----------------------------------------------------------------------------
// 二、防重打印（dedupe）
// -----------------------------------------------------------------------------

export type DuplicateAction = 'block' | 'warn' | 'allow';
export type DedupeScope = 'template' | 'tenant';

export interface DedupePolicy {
  enabled: boolean;
  /** 同一指纹在窗口内视为重复（秒） */
  windowSec: number;
  onDuplicate: DuplicateAction;
  /** template=按模板隔离；tenant=同租户跨模板也判重（更严） */
  scope: DedupeScope;
}

export interface DedupeRecord {
  firstPrintedAt: number;
  lastPrintedAt: number;
  count: number;
  jobId: number;
}

export type DedupeDecision = 'allow' | 'block' | 'warn';

/**
 * 打印批次指纹：显式带 tenantId（跨租户绝不共享指纹空间），
 * 行数据做稳定排序后哈希（复用 P8.1 trigger.calc.fingerprint，避免两套 dedupe 口径）。
 * 不包含 copies —— 补打同一批数据时「份数不同」不应被当成新批次。
 */
export function printFingerprint(
  tenantId: number, templateId: number, rows: any[], scope: DedupeScope = 'template',
): string {
  const stableRows = (Array.isArray(rows) ? rows : [rows ?? {}]).map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
    const out: Record<string, any> = {};
    for (const k of Object.keys(r).sort()) out[k] = r[k];
    return out;
  });
  return fingerprint({
    t: tenantId,
    ...(scope === 'template' ? { tpl: templateId } : {}),
    rows: stableRows,
  });
}

/** 判定结果：block 直接拒绝；warn 放行但回警示；allow 放行 */
export function dedupeVerdict(
  rec: DedupeRecord | null | undefined,
  policy: DedupePolicy,
  nowMs: number,
): { decision: DedupeDecision; reason: string; windowEndsAt?: number; previousJobId?: number; previousCount?: number } {
  if (!policy.enabled) return { decision: 'allow', reason: '防重打印未开启' };
  if (!rec) return { decision: 'allow', reason: '该批次首次打印' };

  const windowMs = policy.windowSec * 1000;
  const endsAt = rec.lastPrintedAt + windowMs;
  if (nowMs >= endsAt) {
    return { decision: 'allow', reason: `距上次打印已超过 ${policy.windowSec} 秒窗口，视为新批次`, previousJobId: rec.jobId };
  }

  const detail = `与任务 #${rec.jobId} 的打印数据指纹相同（窗口内已打印 ${rec.count} 次）`;
  return {
    decision: policy.onDuplicate,
    reason: policy.onDuplicate === 'block'
      ? `${detail}，策略为 block，已拒绝重复打印`
      : policy.onDuplicate === 'warn'
        ? `${detail}，已放行但记录警示（策略为 warn）`
        : `${detail}，策略为 allow，仅记录`,
    windowEndsAt: endsAt,
    previousJobId: rec.jobId,
    previousCount: rec.count,
  };
}

// -----------------------------------------------------------------------------
// 三、数量策略（打印数量限制）
// -----------------------------------------------------------------------------

export interface PrintQuotaPolicy {
  enabled: boolean;
  /** 单任务上限（张）；0 = 不限 */
  maxPerJob: number;
  /** 租户每日上限（张）；0 = 不限 */
  maxPerDay: number;
  /** 单模板每日上限（张）；0 = 不限 */
  maxPerTemplatePerDay: number;
}

export interface QuotaUsage { day?: number; templateDay?: number }

export function quotaVerdict(
  count: number,
  policy: PrintQuotaPolicy,
  usage: QuotaUsage = {},
  _nowMs = Date.now(),
): { allowed: boolean; reason: string; limit?: string; remaining?: number } {
  if (!policy.enabled) return { allowed: true, reason: '数量策略未开启' };
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const checks: Array<{ key: string; label: string; max: number; used: number }> = [
    { key: 'maxPerJob', label: '单任务', max: policy.maxPerJob, used: 0 },
    { key: 'maxPerDay', label: '租户每日', max: policy.maxPerDay, used: Number(usage.day ?? 0) },
    { key: 'maxPerTemplatePerDay', label: '单模板每日', max: policy.maxPerTemplatePerDay, used: Number(usage.templateDay ?? 0) },
  ];
  for (const c of checks) {
    if (c.max > 0 && c.used + n > c.max) {
      return {
        allowed: false,
        reason: `${c.label}数量超限：已用 ${c.used} + 本次 ${n} > 上限 ${c.max}`,
        limit: c.key,
        remaining: Math.max(0, c.max - c.used),
      };
    }
  }
  return { allowed: true, reason: `本次 ${n} 张在配额内` };
}

// -----------------------------------------------------------------------------
// 四、水印（防拷贝 / 溯源）
// -----------------------------------------------------------------------------

export type WatermarkMode = 'diagonal' | 'center' | 'tiled';

export interface WatermarkSpec {
  enabled: boolean;
  /** 支持 {{printUser}} {{printDate}} {{printTime}} {{tenantId}} {{jobId}} {{templateName}} 占位 */
  text: string;
  mode: WatermarkMode;
  opacity: number;
  fontSizeMm: number;
  color: string;
  rotationDeg: number;
}

export interface WatermarkPlacement {
  xMm: number; yMm: number; rotationDeg: number;
  opacity: number; fontSizeMm: number; color: string; text: string;
}

export const WM_VARS = ['printUser', 'printDate', 'printTime', 'tenantId', 'jobId', 'templateName'] as const;
const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;

/** SVG/HTML 文本转义：水印文本来自租户配置，必须防 XML/HTML 注入 */
export function escapeXml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 占位符展开：与模板变量语法 {{name}} 同源；未提供的变量替换为空串，不残留花括号 */
export function expandWatermarkText(text: string, vars: Record<string, any> = {}): string {
  return String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => {
    if (!WM_VARS.includes(k as any)) return '';     // 非法变量名不回显，防注入
    const v = vars[k];
    return v === null || v === undefined ? '' : String(v);
  }).slice(0, 200);
}

function clamp(v: any, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * 水印坐标（纯函数，供 SVG 与浏览器 HTML 两个渲染器共用，保证预览/导出/打印不漂移）。
 *  - center：正中一条；
 *  - diagonal：居中一条，默认 -30°（视觉上不遮挡条码主体，且难以裁掉）；
 *  - tiled：3×3 平铺，整页覆盖，防拍照泄露。
 * 所有坐标夹在页面内，数值做上下限夹取，避免脏配置把水印画到页外或透明度为负。
 */
export function watermarkPlacements(
  spec: WatermarkSpec,
  page: { widthMm: number; heightMm: number },
): WatermarkPlacement[] {
  if (!spec.enabled) return [];
  const w = clamp(page.widthMm, 1, 2000, 40);
  const h = clamp(page.heightMm, 1, 2000, 30);
  const opacity = clamp(spec.opacity, 0.02, 0.8, 0.15);
  const size = clamp(spec.fontSizeMm, 1, 40, 5);
  const color = SAFE_COLOR.test(String(spec.color ?? '')) ? spec.color : '#888888';
  const rotation = clamp(spec.rotationDeg, -90, 90, -30);
  const text = String(spec.text ?? '').slice(0, 200);
  if (!text.trim()) return [];

  const base = { opacity, fontSizeMm: size, color, text, rotationDeg: rotation };
  if (spec.mode === 'center') return [{ ...base, rotationDeg: 0, xMm: w / 2, yMm: h / 2 }];
  if (spec.mode === 'diagonal') return [{ ...base, xMm: w / 2, yMm: h / 2 }];
  const out: WatermarkPlacement[] = [];
  for (let r = 1; r <= 3; r++) {
    for (let c = 1; c <= 3; c++) {
      out.push({ ...base, xMm: (w * c) / 4, yMm: (h * r) / 4 });
    }
  }
  return out;
}

/** 生成 SVG <g> 水印层（叠加在标签内容之上；pointer-events:none 不影响交互） */
export function watermarkSvgLayer(
  spec: WatermarkSpec, page: { widthMm: number; heightMm: number }, vars: Record<string, any> = {},
): string {
  const text = escapeXml(expandWatermarkText(spec.text, vars));
  if (!text) return '';
  const items = watermarkPlacements(spec, page);
  if (!items.length) return '';
  const body = items.map((p) =>
    `<text x="${p.xMm}" y="${p.yMm}" font-size="${p.fontSizeMm}" fill="${p.color}" `
    + `fill-opacity="${p.opacity}" text-anchor="middle" dominant-baseline="middle" `
    + `transform="rotate(${p.rotationDeg} ${p.xMm} ${p.yMm})" `
    + `font-family="sans-serif" pointer-events="none">${text}</text>`,
  ).join('');
  return `<g data-layer="watermark">${body}</g>`;
}

/** 生成浏览器打印 HTML 水印层（绝对定位 mm，与 SVG 同一套坐标） */
export function watermarkHtmlLayer(
  spec: WatermarkSpec, page: { widthMm: number; heightMm: number }, vars: Record<string, any> = {},
): string {
  const text = escapeXml(expandWatermarkText(spec.text, vars));
  if (!text) return '';
  const items = watermarkPlacements(spec, page);
  if (!items.length) return '';
  const body = items.map((p) =>
    `<div style="position:absolute;left:${p.xMm}mm;top:${p.yMm}mm;`
    + `transform:translate(-50%,-50%) rotate(${p.rotationDeg}deg);`
    + `font-size:${p.fontSizeMm}mm;color:${p.color};opacity:${p.opacity};`
    + `white-space:nowrap;pointer-events:none;user-select:none">${text}</div>`,
  ).join('');
  return `<div class="lf-watermark" style="position:absolute;inset:0;pointer-events:none">${body}</div>`;
}

// -----------------------------------------------------------------------------
// 五、租户级策略归一化（DB JSONB 脏数据一律夹到合法域，缺省回填默认）
// -----------------------------------------------------------------------------

export interface GovernancePolicy {
  /** 严格发布模式：开启后仅 published 可打印、发布后不可直接编辑 */
  strictPublish: boolean;
  dedupe: DedupePolicy;
  quota: PrintQuotaPolicy;
  watermark: WatermarkSpec;
}

export const DEFAULT_POLICY: GovernancePolicy = {
  strictPublish: false,
  dedupe: { enabled: false, windowSec: 3600, onDuplicate: 'warn', scope: 'template' },
  quota: { enabled: false, maxPerJob: 0, maxPerDay: 0, maxPerTemplatePerDay: 0 },
  watermark: { enabled: false, text: '{{tenantId}} {{printDate}} {{printUser}}', mode: 'diagonal', opacity: 0.15, fontSizeMm: 5, color: '#888888', rotationDeg: -30 },
};

const DUP_ACTIONS: DuplicateAction[] = ['block', 'warn', 'allow'];
const WM_MODES: WatermarkMode[] = ['diagonal', 'center', 'tiled'];

/** 从任意输入构造合法策略：字段缺失/类型错误/超界都收敛到默认值，绝不因脏配置绕过治理 */
export function normalizePolicy(raw: any): GovernancePolicy {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = r.dedupe && typeof r.dedupe === 'object' ? r.dedupe : {};
  const q = r.quota && typeof r.quota === 'object' ? r.quota : {};
  const w = r.watermark && typeof r.watermark === 'object' ? r.watermark : {};
  return {
    strictPublish: r.strictPublish === true,
    dedupe: {
      enabled: d.enabled === true,
      windowSec: Math.floor(clamp(d.windowSec, 1, 30 * 24 * 3600, DEFAULT_POLICY.dedupe.windowSec)),
      onDuplicate: DUP_ACTIONS.includes(d.onDuplicate) ? d.onDuplicate : DEFAULT_POLICY.dedupe.onDuplicate,
      scope: d.scope === 'tenant' ? 'tenant' : 'template',
    },
    quota: {
      enabled: q.enabled === true,
      maxPerJob: Math.floor(clamp(q.maxPerJob, 0, 1_000_000, 0)),
      maxPerDay: Math.floor(clamp(q.maxPerDay, 0, 1_000_000, 0)),
      maxPerTemplatePerDay: Math.floor(clamp(q.maxPerTemplatePerDay, 0, 1_000_000, 0)),
    },
    watermark: {
      enabled: w.enabled === true,
      text: typeof w.text === 'string' ? w.text.slice(0, 200) : DEFAULT_POLICY.watermark.text,
      mode: WM_MODES.includes(w.mode) ? w.mode : DEFAULT_POLICY.watermark.mode,
      opacity: clamp(w.opacity, 0.02, 0.8, DEFAULT_POLICY.watermark.opacity),
      fontSizeMm: clamp(w.fontSizeMm, 1, 40, DEFAULT_POLICY.watermark.fontSizeMm),
      color: SAFE_COLOR.test(String(w.color ?? '')) ? w.color : DEFAULT_POLICY.watermark.color,
      rotationDeg: clamp(w.rotationDeg, -90, 90, DEFAULT_POLICY.watermark.rotationDeg),
    },
  };
}
