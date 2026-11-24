// =============================================================================
// agent-protocol.calc.ts —— P8.5 本地打印代理协议「判定层单一真源」
//
// 【为什么需要本地代理】Web 服务端在 Linux 容器里，看不到用户 Windows 机器上的
// 驱动打印机、USB 口、串口。唯一正确形态是：用户在本机装一个轻量代理，
// 由代理**主动出站**连服务端（不需要公网 IP / 不需要开入站端口 / 穿透 NAT），
// 心跳保活 → 拉取待打任务 → 调本地驱动打印 → 回执上报。
//
// 【协议不变式】
//   1. 所有判定不依赖 Nest / TypeORM / Redis，node:test 可直接跑；
//   2. 时间判定显式接收 now，绝不读系统时钟（测试可冻时间）；
//   3. 任务信封做**字段白名单脱敏**：connection 里的 host/port/账号/密码/DSN
//      一律不下发到本地，只给驱动名 + 指令流，避免凭证落到用户机器；
//   4. 签名与 P8.1 Webhook 复用同一个 HMAC 真源（verifySignature），
//      不另造一套 HMAC 实现，防止两端算法漂移；
//   5. jobKey 用稳定哈希（fingerprint）保证重试/重复拉取幂等。
//
// 【验收边界】本文件与 service 提供完整的协议与 API 链路，但「代理进程真调
// Windows 驱动」「USB/串口真写」「RFID 读写器真写 EPC」必须在真机验证，
// 沙盒（Linux，无驱动/无设备）无法覆盖，清单见 docs/10 §10.30。
// =============================================================================
import { fingerprint, verifySignature } from '../jobs/trigger.calc';

export const AGENT_PROTOCOL_VERSION = '1.0';
/** 超过该秒数没心跳即视为离线，不再派发新任务 */
export const AGENT_HEARTBEAT_TIMEOUT_SEC = 90;
/** 单次拉取最多下发多少个任务，防止代理被一次压垮（默认值，可用 AGENT_MAX_PULL 覆盖） */
export const AGENT_MAX_PULL = 10;
/** 任务被认领后多久未完成可回收重派（默认值，可用 AGENT_CLAIM_TTL_SEC 覆盖） */
export const AGENT_CLAIM_TTL_SEC = 300;

/** 环境变量读取（非数字/越界一律落回默认，绝不因为配置脏了就放宽约束） */
function envInt(name: string, dflt: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 实际生效的认领租约（秒）：默认 300s，可 60–3600 调。
 * 客户现场若一张标签在队列里排队很久（老旧 USB 打印机 + 大批量），把这里调大，
 * 否则任务会在打印途中被回收重派，出现"同一张打两遍"。
 */
export function claimTtlSec(): number {
  return envInt('AGENT_CLAIM_TTL_SEC', AGENT_CLAIM_TTL_SEC, 60, 3600);
}

/** 实际生效的单次拉取上限：默认 10，可 1–50 调；代理侧并发打不过来就调小 */
export function maxPullLimit(): number {
  return envInt('AGENT_MAX_PULL', AGENT_MAX_PULL, 1, 50);
}
/** 单任务最大重试次数 */
export const AGENT_JOB_MAX_ATTEMPTS = 3;
/** 签名时间窗（秒），与 Webhook 同口径 */
export const AGENT_SIGNATURE_TOLERANCE_SEC = 300;

export const AGENT_CAPABILITIES = [
  'windows_spooler', 'usb', 'raw_tcp', 'serial', 'rfid', 'inkjet', 'pdf',
] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];

export const AGENT_JOB_STATUSES = ['pending', 'claimed', 'printing', 'succeeded', 'failed', 'expired'] as const;
export type AgentJobStatus = typeof AGENT_JOB_STATUSES[number];

/** 合法的回执状态迁移（防止 succeeded 之后又来一条 failed 把结果改掉） */
export const RECEIPT_TRANSITIONS: Record<AgentJobStatus, AgentJobStatus[]> = {
  pending: ['claimed', 'expired'],
  claimed: ['printing', 'succeeded', 'failed', 'expired', 'pending'],
  printing: ['succeeded', 'failed', 'expired', 'pending'],
  succeeded: [],
  failed: ['pending'],       // 允许显式重派
  expired: ['pending'],      // 允许显式重派
};

export interface AgentView {
  agentId: string;
  tenantId: number;
  capabilities: AgentCapability[];
  driverNames: string[];
  status: 'online' | 'offline' | 'draining';
  load: number;
  lastHeartbeatAt: string | null;
}

export interface AgentRegistration {
  tenantId: number;
  agentId: string;
  name: string;
  capabilities: AgentCapability[];
  driverNames: string[];
  metadata: Record<string, any>;
}

export interface RegistrationVerdict {
  ok: boolean;
  errors: string[];
  registration: AgentRegistration | null;
  warnings: string[];
}

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

/**
 * 注册归一化：能力白名单 + agentId 格式 + 显式 tenant_id。
 * 未知能力不直接拒绝（代理可能比服务端新），而是丢弃并给 warning —— 向前兼容；
 * 但 agentId / tenantId 非法直接 fail-closed，防止跨租户注册串号。
 */
export function normalizeAgentRegistration(raw: any): RegistrationVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tenantId = Number(raw?.tenantId);
  if (!Number.isInteger(tenantId) || tenantId <= 0) errors.push('tenant_id 非法');
  const agentId = String(raw?.agentId ?? '').trim();
  if (!AGENT_ID_RE.test(agentId)) errors.push('agentId 需 3~64 位字母数字/._:-，且以字母数字开头');
  if (errors.length) return { ok: false, errors, registration: null, warnings };

  const capsRaw = Array.isArray(raw?.capabilities) ? raw.capabilities : [];
  const capabilities: AgentCapability[] = [];
  for (const c of capsRaw) {
    const v = String(c ?? '').trim();
    if ((AGENT_CAPABILITIES as readonly string[]).includes(v)) {
      if (!capabilities.includes(v as AgentCapability)) capabilities.push(v as AgentCapability);
    } else if (v) warnings.push(`未知能力 "${v}" 已忽略（代理版本可能更新）`);
  }
  if (!capabilities.length) warnings.push('代理未声明任何能力，将不会收到任务');

  const driverNames = (Array.isArray(raw?.driverNames) ? raw.driverNames : [])
    .map((d: any) => String(d ?? '').trim()).filter(Boolean).slice(0, 32);
  const name = String(raw?.name ?? '').trim().slice(0, 120) || agentId;
  const metadata = raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
  return {
    ok: true, errors: [], warnings,
    registration: { tenantId, agentId, name, capabilities, driverNames, metadata },
  };
}

/** 心跳存活：无心跳 / 脏时间一律离线，绝不按「宽松兜底在线」派发任务 */
export function agentOnline(lastHeartbeatAt: string | number | Date | null | undefined, now: Date, timeoutSec = AGENT_HEARTBEAT_TIMEOUT_SEC): boolean {
  if (!lastHeartbeatAt) return false;
  const t = new Date(lastHeartbeatAt as any).getTime();
  if (!Number.isFinite(t)) return false;
  const limit = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : AGENT_HEARTBEAT_TIMEOUT_SEC;
  const ageSec = (now.getTime() - t) / 1000;
  return ageSec >= -AGENT_SIGNATURE_TOLERANCE_SEC && ageSec <= limit;
}

/** 在线状态：draining 表示代理主动排空（不再接新任务，但允许完成手上任务） */
export function agentStatus(
  lastHeartbeatAt: string | number | Date | null | undefined,
  now: Date, draining = false,
): AgentView['status'] {
  if (!agentOnline(lastHeartbeatAt, now)) return 'offline';
  return draining ? 'draining' : 'online';
}

export interface HeartbeatVerdict {
  ok: boolean;
  errors: string[];
  heartbeat: { agentId: string; version: string; load: number; capabilities: AgentCapability[]; draining: boolean; at: string } | null;
}

export function normalizeHeartbeat(raw: any, now: Date): HeartbeatVerdict {
  const agentId = String(raw?.agentId ?? '').trim();
  if (!AGENT_ID_RE.test(agentId)) return { ok: false, errors: ['agentId 非法'], heartbeat: null };
  const load = Math.max(0, Math.min(1000, Math.floor(Number(raw?.load) || 0)));
  const caps = (Array.isArray(raw?.capabilities) ? raw.capabilities : [])
    .map((c: any) => String(c ?? '').trim())
    .filter((c: string) => (AGENT_CAPABILITIES as readonly string[]).includes(c)) as AgentCapability[];
  return {
    ok: true, errors: [],
    heartbeat: {
      agentId, version: String(raw?.version ?? AGENT_PROTOCOL_VERSION).slice(0, 20),
      load, capabilities: caps, draining: raw?.draining === true, at: now.toISOString(),
    },
  };
}

export interface AgentJobRequest {
  tenantId: number;
  capability: AgentCapability;
  driverName?: string;
}

/**
 * 选代理：能力匹配 → 在线且非 draining → 同租户 → 负载最小 → agentId 字典序。
 * 最后一级排序保证多实例/多次调用结果确定（可单测、可复现），不会随机抖。
 */
export function selectAgentForJob(agents: AgentView[], req: AgentJobRequest): AgentView | null {
  const pool = (agents ?? []).filter((a) =>
    a && Number(a.tenantId) === Number(req.tenantId)
    && a.status !== 'offline' && a.status !== 'draining'
    && Array.isArray(a.capabilities) && a.capabilities.includes(req.capability)
    && (!req.driverName || (a.driverNames ?? []).includes(req.driverName)),
  );
  if (!pool.length) return null;
  return pool.sort((a, b) => (a.load - b.load) || String(a.agentId).localeCompare(String(b.agentId)))[0];
}

// ---------------------------------------------------------------- 任务信封

export interface AgentJobSource {
  tenantId: number;
  jobId: number;
  printerId?: number;
  templateId?: number;
  capability: AgentCapability;
  driverName?: string;
  /** 已渲染好的帧（每条只取一个白名单格式） */
  labels: Array<{
    zpl?: string; tspl?: string; epl?: string; pngBase64?: string; pdfBase64?: string;
    copies?: number;
  }>;
  settings: {
    dpi: number; widthMm: number; heightMm: number;
    offsetXMm?: number; offsetYMm?: number; orientation?: 0 | 90 | 180 | 270;
    density?: number; speed?: number; gapMm?: number;
  };
  /** 原始 connection —— 会被白名单脱敏，绝不下发凭证 */
  connection?: Record<string, any>;
}

export interface AgentJobEnvelope {
  version: string;
  jobKey: string;
  tenantId: number;
  jobId: number;
  printerId: number | null;
  templateId: number | null;
  capability: AgentCapability;
  driverName: string | null;
  labels: Array<{ format: 'zpl' | 'tspl' | 'epl' | 'png-base64' | 'pdf-base64'; data: string; copies: number }>;
  settings: Record<string, number>;
  createdAt: string;
  /** 明示哪些字段被剔除，便于审计「凭证没出域」 */
  redactedFields: string[];
}

const LABEL_FORMAT_FIELDS = ['zpl', 'tspl', 'epl', 'pngBase64', 'pdfBase64'] as const;
const LABEL_FORMAT_NAME: Record<string, AgentJobEnvelope['labels'][number]['format']> = {
  zpl: 'zpl', tspl: 'tspl', epl: 'epl', pngBase64: 'png-base64', pdfBase64: 'pdf-base64',
};

/** 稳定 jobKey：同租户 + 同 jobId + 同内容只算一次，重复拉取/重试幂等 */
export function agentJobKey(src: Pick<AgentJobSource, 'tenantId' | 'jobId' | 'labels'>): string {
  return fingerprint({ t: src.tenantId, j: src.jobId, l: src.labels });
}

/**
 * 生成下发信封。核心安全点：connection 只允许 driverName 出域，
 * host / port / user / password / dsn / token / secret 等一律剔除并记入 redactedFields。
 * 服务端连库 DSN 属于最高敏感字段，落到用户本机等于泄漏，必须 fail-closed。
 */
export function agentJobEnvelope(src: AgentJobSource, now: Date): AgentJobEnvelope {
  const labels: AgentJobEnvelope['labels'] = [];
  for (const l of src.labels ?? []) {
    for (const f of LABEL_FORMAT_FIELDS) {
      const v = (l as any)?.[f];
      if (typeof v === 'string' && v.length) {
        labels.push({ format: LABEL_FORMAT_NAME[f], data: v, copies: Math.max(1, Math.floor(Number(l.copies) || 1)) });
        break;
      }
    }
  }
  const conn = src.connection ?? {};
  const redactedFields = Object.keys(conn).filter((k) => k !== 'driverName');
  const s = src.settings ?? ({} as any);
  const settings: Record<string, number> = {
    dpi: Number(s.dpi) || 203,
    widthMm: Number(s.widthMm) || 0,
    heightMm: Number(s.heightMm) || 0,
    offsetXMm: Number(s.offsetXMm) || 0,
    offsetYMm: Number(s.offsetYMm) || 0,
    orientation: Number(s.orientation) || 0,
    gapMm: Number(s.gapMm) || 2,
  };
  if (s.density !== undefined && s.density !== null) settings.density = Number(s.density);
  if (s.speed !== undefined && s.speed !== null) settings.speed = Number(s.speed);
  return {
    version: AGENT_PROTOCOL_VERSION,
    jobKey: agentJobKey(src),
    tenantId: Number(src.tenantId), jobId: Number(src.jobId),
    printerId: src.printerId ?? null, templateId: src.templateId ?? null,
    capability: src.capability,
    driverName: typeof conn.driverName === 'string' ? conn.driverName.slice(0, 200) : (src.driverName ?? null),
    labels, settings, createdAt: now.toISOString(), redactedFields,
  };
}

// ---------------------------------------------------------------- 回执与签名

export interface AgentReceipt {
  jobKey: string;
  agentId: string;
  tenantId: number;
  status: AgentJobStatus;
  printedCount?: number;
  error?: string;
  at?: string;
}

export function transitionReceipt(prev: AgentJobStatus, next: AgentJobStatus): { ok: boolean; reason: string } {
  if (!AGENT_JOB_STATUSES.includes(next)) return { ok: false, reason: `非法状态 ${next}` };
  const allowed = RECEIPT_TRANSITIONS[prev] ?? [];
  if (!allowed.includes(next)) {
    return { ok: false, reason: `状态 ${prev} → ${next} 不允许（终态不可改写）` };
  }
  return { ok: true, reason: '状态迁移合法' };
}

/** 回执校验：jobKey / tenantId / agentId 三者必须与服务端记录一致，防跨租户伪造 */
export function verifyReceipt(
  receipt: any, expected: { jobKey: string; agentId: string; tenantId: number; currentStatus: AgentJobStatus },
): { ok: boolean; errors: string[]; normalized: AgentReceipt | null } {
  const errors: string[] = [];
  if (String(receipt?.jobKey ?? '') !== expected.jobKey) errors.push('jobKey 不匹配');
  if (String(receipt?.agentId ?? '') !== expected.agentId) errors.push('agentId 不匹配');
  if (Number(receipt?.tenantId) !== Number(expected.tenantId)) errors.push('tenant_id 不匹配');
  const status = String(receipt?.status ?? '') as AgentJobStatus;
  const t = transitionReceipt(expected.currentStatus, status);
  if (!t.ok) errors.push(t.reason);
  const printedCount = receipt?.printedCount === undefined || receipt?.printedCount === null
    ? undefined : Number(receipt.printedCount);
  if (printedCount !== undefined && (!Number.isInteger(printedCount) || printedCount < 0)) {
    errors.push('printedCount 必须是非负整数');
  }
  if (errors.length) return { ok: false, errors, normalized: null };
  return {
    ok: true, errors: [],
    normalized: {
      jobKey: expected.jobKey, agentId: expected.agentId, tenantId: Number(expected.tenantId),
      status, printedCount,
      error: receipt?.error ? String(receipt.error).slice(0, 500) : undefined,
      at: receipt?.at ? String(receipt.at).slice(0, 40) : undefined,
    },
  };
}

/**
 * 入站签名校验：复用 P8.1 Webhook 的 verifySignature（HMAC-SHA256 + 时间窗 +
 * 常量时间比较），不另造实现。代理注册时下发的 secret 只存哈希，校验时用明文。
 */
export function verifyAgentSignature(body: string, secret: string, tsHeader: string, sigHeader: string, nowMs: number): boolean {
  return verifySignature(body, secret, tsHeader, sigHeader, nowMs, AGENT_SIGNATURE_TOLERANCE_SEC);
}

/** 任务是否可回收重派：被认领超过 TTL 且未到终态、未超最大重试 */
export function claimExpired(
  claimedAt: string | number | Date | null | undefined, status: AgentJobStatus, attempts: number, now: Date,
  ttlSec = claimTtlSec(),
): boolean {
  if (status === 'succeeded' || status === 'failed' || status === 'expired') return false;
  if (Number(attempts) >= AGENT_JOB_MAX_ATTEMPTS) return false;
  if (!claimedAt) return false;
  const t = new Date(claimedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t >= ttlSec * 1000;
}
