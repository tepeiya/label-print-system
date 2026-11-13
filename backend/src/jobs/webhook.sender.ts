// =============================================================================
// webhook.sender.ts —— P8.1 出站 Webhook 执行器
//
// 安全约束：
//   1. 投递前二次校验 URL（规则创建时已校验一次，这里防历史脏数据/配置被绕过）；
//   2. 带 HMAC-SHA256 签名与时间戳，接收方可验签并防重放（verifySignature）；
//   3. 5s 超时，失败只返回 outcome，不抛异常打断触发器主流程；
//   4. body 是受控 envelope，不把内部对象（Repository/ctx）透传出去。
// =============================================================================
import {
  WEBHOOK_TIMEOUT_MS, signatureHeaders, validateWebhookUrl, type TriggerEvent,
} from './trigger.calc';

export interface WebhookEnvelope {
  type: 'labelflow.trigger';
  at: string;
  source: string;
  tenantId: number;
  data: Record<string, any>;
}

export interface WebhookOutcome {
  ok: boolean;
  httpStatus?: number;
  error?: string;
}

export function webhookEnvelope(event: TriggerEvent, now: Date = new Date()): WebhookEnvelope {
  return {
    type: 'labelflow.trigger',
    at: now.toISOString(),
    source: String(event.source),
    tenantId: Number(event.tenantId),
    // 只带标量/数组数据行，不带函数与内部对象
    data: JSON.parse(JSON.stringify(event.payload ?? {})),
  };
}

export interface SendOptions {
  allowHttpLoopback?: boolean;
  fetchImpl?: (url: string, init: any) => Promise<{ status: number }>;
  nowMs?: number;
  timeoutMs?: number;
}

export async function sendWebhook(
  rawUrl: string,
  secret: string,
  envelope: WebhookEnvelope,
  opts: SendOptions = {},
): Promise<WebhookOutcome> {
  const check = validateWebhookUrl(rawUrl, { allowHttpLoopback: opts.allowHttpLoopback === true });
  if (!check.ok) return { ok: false, error: `投递前 URL 校验失败：${check.reason}` };

  const body = JSON.stringify(envelope);
  const nowMs = opts.nowMs ?? Date.now();
  const headers = signatureHeaders(body, secret, nowMs);
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const signal = (globalThis as any).AbortSignal?.timeout?.(timeoutMs);
  const fetchFn: any = opts.fetchImpl ?? (globalThis as any).fetch;
  if (typeof fetchFn !== 'function') return { ok: false, error: '运行环境不支持 fetch' };

  try {
    const res = await fetchFn(check.url, {
      method: 'POST',
      headers: { ...headers, 'User-Agent': 'LabelFlow-Trigger/1.0' },
      body,
      ...(signal ? { signal } : {}),
    });
    const status = Number(res?.status ?? 0);
    return status >= 200 && status < 300
      ? { ok: true, httpStatus: status }
      : { ok: false, httpStatus: status, error: `对端返回 HTTP ${status}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}
