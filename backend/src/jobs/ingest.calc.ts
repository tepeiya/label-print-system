// =============================================================================
// ingest.calc.ts —— 外部业务事件入站「判定层」单一真源（扫码即打）
//
// 【为什么单独一层】MES/ERP 扫码入库后推一个语义化业务事件（stock.in + rows），
//   经触发器规则引擎判定命中 action=print → 自动打印。这是对 HotFolder（落文件）
//   与直调 print API 之外的第三条路径：业务方只发「发生了什么」，打印模板/条件/份数
//   全在规则里配置，解耦且可审计。
//
// 【安全红线】
//   1. 外部事件必须 HMAC 验签（复用 P8.1 Webhook 的 verifySignature 真源），
//      无签名/签名错/超时/重放一律拒绝——否则任何人都能 POST 一个 print 事件刷打印。
//   2. 租户只从 Agent Token（服务端注入 ctx.tenantId），请求体里的 tenantId 一律忽略并警告；
//      与 planDeliveries 的跨租户硬拦截形成双保险。
//   3. 只有 INGEST_SOURCES 子集可从外部推入；内部事件 print.*/template.*/hotfolder.*
//      不接受外部伪造（它们是服务端进程的产物）。
//   4. rows 数量上限复用 MAX_DROP_ROWS，防止一次事件塞爆打印队列。
//
// 纯函数、零 Nest/TypeORM 依赖，tsx 单测直接覆盖。
// =============================================================================
import {
  fingerprint, INGEST_SOURCES, MAX_DROP_ROWS, verifySignature,
  type IngestSource, type TriggerEvent, type ValidationResult,
} from './trigger.calc';

export interface IngestCtx {
  /** 租户 ID，只由服务端从 Agent Token 解析后注入，绝不信请求体 */
  tenantId: number;
  /** HMAC 共享密钥（租户/集成配置，AES 密文由上层解密后传入） */
  secret: string;
  /** X-LabelFlow-Timestamp */
  tsHeader: string;
  /** X-LabelFlow-Signature */
  sigHeader: string;
  /** 验签用的请求体规范串：与签名方口径一致（JSON.stringify(body)） */
  rawBodyJson: string;
  nowMs?: number;
}

export interface IngestNormalized {
  event: TriggerEvent;
  /** 请求体里被忽略/裁剪的字段说明，回填到响应 warnings 让调用方知情 */
  warnings: string[];
}

/** 单次入站事件请求体大小上限（字符数），防超大 payload 拖垮验签与队列 */
export const MAX_INGEST_BODY_CHARS = 200_000;
/** 业务事件流水号（eventId）长度上限 */
export const MAX_EVENT_ID_LEN = 160;

/**
 * 归一化并校验外部入站事件。任何失败都 fail-closed（返回 ok:false + errors），不抛异常，
 * 由上层映射为 400/401。顺序：体积 → 验签 → 事件源 → 租户隔离 → payload 边界。
 */
export function normalizeIngest(body: any, ctx: IngestCtx): ValidationResult<IngestNormalized> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nowMs = ctx?.nowMs ?? Date.now();

  // 0) 上下文完整性（服务端注入，缺一即视为配置错误）
  const tenantId = Number(ctx?.tenantId);
  if (!Number.isInteger(tenantId) || tenantId <= 0) errors.push('入站上下文缺少合法 tenantId');

  // 1) 体积上限（先挡超大 body，避免后续 HMAC/序列化开销）
  const raw = String(ctx?.rawBodyJson ?? '');
  if (!raw) errors.push('请求体为空');
  else if (raw.length > MAX_INGEST_BODY_CHARS) {
    errors.push(`请求体过大（${raw.length} > ${MAX_INGEST_BODY_CHARS} 字符）`);
  }

  // 2) HMAC 验签：防伪造打印的第一道闸（可选增强）。
  //    配了 INGEST_HMAC_SECRET 就强制校验；未配置则仅靠 Agent Token 鉴权，并显式警告调用方。
  if (!ctx?.secret) {
    warnings.push('租户未启用入站 HMAC 验签（仅 Agent Token 鉴权）；建议配置 INGEST_HMAC_SECRET');
  } else if (!verifySignature(raw, ctx.secret, String(ctx.tsHeader ?? ''), String(ctx.sigHeader ?? ''), nowMs)) {
    errors.push('入站签名校验失败（缺失/错误/超时/重放）');
  }

  // 3) body 形态与事件源白名单
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    errors.push('请求体必须是 JSON 对象');
    return { ok: false, errors };
  }
  const source = String(body.source ?? '');
  if (!(INGEST_SOURCES as readonly string[]).includes(source)) {
    errors.push(`外部事件源非法：${source || '(空)'}（允许：${INGEST_SOURCES.join(', ')}）`);
  }

  // 4) 租户隔离：请求体禁止携带 tenantId；带了就忽略并警告（租户只认 token）
  if (body.tenantId !== undefined || body.tenant_id !== undefined) {
    warnings.push('请求体中的 tenantId 已被忽略（租户身份只从 Agent Token 解析）');
  }

  // 5) payload 边界
  const payload = body.payload;
  if (payload === undefined || payload === null) {
    errors.push('payload 必填');
  } else if (typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('payload 必须是 JSON 对象');
  } else {
    if (Object.keys(payload).length > 200) errors.push('payload 字段数过多（上限 200）');
    if (payload.rows !== undefined) {
      if (!Array.isArray(payload.rows)) {
        errors.push('payload.rows 必须是数组');
      } else if (payload.rows.length > MAX_DROP_ROWS) {
        errors.push(`payload.rows 过多（${payload.rows.length} > ${MAX_DROP_ROWS}）`);
      } else if (payload.rows.some((r: any) => !r || typeof r !== 'object' || Array.isArray(r))) {
        errors.push('payload.rows 的每一项必须是对象');
      }
    }
  }

  // 6) eventId（业务流水号，作幂等键；不传则由 enqueue 用 payload 指纹兜底）
  let eventId: string | undefined;
  if (body.eventId !== undefined && body.eventId !== null) {
    eventId = String(body.eventId).trim().slice(0, MAX_EVENT_ID_LEN);
    if (!eventId) { eventId = undefined; warnings.push('eventId 为空，已改用内容指纹去重'); }
  }

  if (errors.length) return { ok: false, errors };

  // 7) 组装规范事件：tenantId 来自 ctx；剥离请求体任何租户/控制字段
  const cleanPayload: Record<string, any> = { ...(payload as Record<string, any>) };
  delete cleanPayload.tenantId;
  delete cleanPayload.tenant_id;
  const event: TriggerEvent = {
    source: source as IngestSource,
    tenantId,
    payload: cleanPayload,
    eventId: eventId ?? `ingest:${fingerprint({ source, tenantId, payload: cleanPayload })}`,
    depth: 0,
  };
  return { ok: true, errors: [], value: { event, warnings } };
}
