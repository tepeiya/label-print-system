// =============================================================================
// external-channels.ts —— 邮件 / 飞书 / 短信三种外部通知通道（上线前技术债：通知通道扩展）
//
// 设计约束（沿用 notification.channel.ts 的分层）：
//   1. 三种通道都实现 NotificationChannel，失败只返回 ok:false，绝不影响站内信主流程；
//      NotificationService.publish 已对外部通道 try/catch，本文件内部也兜底不抛。
//   2. 零第三方 SDK 依赖：统一走可注入的 fetch（HTTP 网关协议）：
//      - 飞书：官方群机器人 webhook（msg_type=text/card），URL 从收件人或默认配置取；
//      - 邮件：HTTP 邮件网关（如 Resend/Mailgun 风格的 POST /emails），SMTP 需 SDK 故以网关抽象；
//      - 短信：HTTP 短信网关（通用 {phone,text} 载荷，密钥走 Header）。
//   3. 收件人优先取 msg.recipients，退化到 metadata；任一通道缺目标/缺配置 → ok:false 明确原因，
//      不猜测、不静默成功。配置缺省关闭（未配置网关时通道存在但不会误发）。
//   4. payload 构造是纯函数，发送函数接受 fetchImpl 注入，全部可单测（不触网）。
// =============================================================================
import { NotifyConfig } from './notify.config';
import {
  ChannelDelivery, NotificationChannel, NotificationMessage, NotificationRecipients,
} from './notification.channel';

/** 可注入的 fetch 签名（与 webhook.sender.ts 一致，便于 mock） */
export type FetchLike = (url: string, init: any) => Promise<{ status: number; text?: () => Promise<string> }>;

function resolveFetch(injected?: FetchLike): FetchLike | null {
  if (injected) return injected;
  const f = (globalThis as any).fetch;
  return typeof f === 'function' ? f : null;
}

/** 超时信号（Node 18+ AbortSignal.timeout；老环境降级为无超时） */
function timeoutSignal(ms: number): any {
  return (globalThis as any).AbortSignal?.timeout?.(ms);
}

/** 收件人：recipients 优先，metadata 兜底（兼容历史调用方只塞 metadata 的写法） */
export function recipientsOf(msg: NotificationMessage): NotificationRecipients {
  const md = msg.metadata ?? {};
  const r = msg.recipients ?? {};
  return {
    email: r.email ?? md.email ?? md.toEmail,
    feishuWebhook: r.feishuWebhook ?? md.feishuWebhook ?? md.feishuWebhookUrl,
    phone: r.phone ?? md.phone ?? md.mobile,
  };
}

// --------------------------------------------------------------------------- 飞书
/** 飞书文本消息载荷（纯函数） */
export function feishuTextPayload(msg: NotificationMessage): Record<string, any> {
  const link = msg.metadata?.link ? `\n${msg.metadata.link}` : '';
  return {
    msg_type: 'text',
    content: { text: `【${msg.category}】${msg.title}\n${msg.body}${link}` },
  };
}

/** 飞书卡片消息载荷（纯函数）——信息层级更清晰，失败可降级文本 */
export function feishuCardPayload(msg: NotificationMessage): Record<string, any> {
  const elements: any[] = [{ tag: 'div', text: { tag: 'lark_md', content: msg.body } }];
  if (msg.metadata?.link) {
    elements.push({
      tag: 'action',
      actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看详情' }, url: msg.metadata.link, type: 'primary' }],
    });
  }
  return {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: msg.title }, template: msg.category === 'alert' ? 'red' : 'blue' },
      elements,
    },
  };
}

export class FeishuChannel implements NotificationChannel {
  readonly kind = 'feishu';
  constructor(private cfg: NotifyConfig, private fetchImpl?: FetchLike) {}

  async send(msg: NotificationMessage, _savedId: number): Promise<ChannelDelivery> {
    const url = recipientsOf(msg).feishuWebhook || this.cfg.feishuWebhook;
    if (!url) return { channel: this.kind, ok: false, detail: '未配置飞书 webhook（recipients.feishuWebhook / FEISHU_WEBHOOK）' };
    if (!/^https:\/\//i.test(url)) return { channel: this.kind, ok: false, detail: '飞书 webhook 必须是 https 地址' };
    const fetchFn = resolveFetch(this.fetchImpl);
    if (!fetchFn) return { channel: this.kind, ok: false, detail: '运行环境不支持 fetch' };
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'LabelFlow-Notify/1.0' },
        body: JSON.stringify(msg.metadata?.feishuCard ? feishuCardPayload(msg) : feishuTextPayload(msg)),
        ...(timeoutSignal(this.cfg.timeoutMs) ? { signal: timeoutSignal(this.cfg.timeoutMs) } : {}),
      });
      const status = Number(res?.status ?? 0);
      // 飞书业务成功在 body 里也返回 StatusCode=0，但 webhook 2xx 已足够判定投递成功；
      // 读一次 body（若提供）以捕获飞书的业务错误，读失败不影响 2xx 判定。
      let detail: string | undefined;
      if (res?.text) {
        try {
          const parsed = JSON.parse(await res.text());
          if (parsed && parsed.StatusCode !== undefined && parsed.StatusCode !== 0) {
            return { channel: this.kind, ok: false, detail: `飞书业务错误 ${parsed.StatusCode}: ${parsed.StatusMessage ?? ''}` };
          }
        } catch { /* body 非 JSON（如 webhook 返回 ok）视为成功 */ }
      }
      return status >= 200 && status < 300
        ? { channel: this.kind, ok: true }
        : { channel: this.kind, ok: false, detail: `对端 HTTP ${status}` + (detail ? ` ${detail}` : '') };
    } catch (e: any) {
      return { channel: this.kind, ok: false, detail: String(e?.message ?? e).slice(0, 300) };
    }
  }
}

// --------------------------------------------------------------------------- 邮件
/** HTTP 邮件网关载荷（纯函数，Resend/Mailgun 风格：from/to/subject/text/html） */
export function emailGatewayPayload(msg: NotificationMessage, from: string, to: string[]): Record<string, any> {
  return {
    from,
    to,
    subject: `[${msg.category}] ${msg.title}`,
    text: msg.body,
    html: `<div><h3>${escapeHtml(msg.title)}</h3><pre style="white-space:pre-wrap">${escapeHtml(msg.body)}</pre></div>`,
  };
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

function normalizeEmails(v: string | string[] | undefined): string[] {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  return arr.map((s) => String(s).trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

export class EmailChannel implements NotificationChannel {
  readonly kind = 'email';
  constructor(private cfg: NotifyConfig, private fetchImpl?: FetchLike) {}

  async send(msg: NotificationMessage, _savedId: number): Promise<ChannelDelivery> {
    if (!this.cfg.emailGatewayUrl) {
      return { channel: this.kind, ok: false, detail: '未配置邮件网关（EMAIL_GATEWAY_URL）' };
    }
    const to = normalizeEmails(recipientsOf(msg).email);
    if (!to.length) return { channel: this.kind, ok: false, detail: '缺有效收件邮箱（recipients.email / metadata.email）' };
    const fetchFn = resolveFetch(this.fetchImpl);
    if (!fetchFn) return { channel: this.kind, ok: false, detail: '运行环境不支持 fetch' };
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'LabelFlow-Notify/1.0' };
      if (this.cfg.emailApiKey) headers.Authorization = `Bearer ${this.cfg.emailApiKey}`;
      const res = await fetchFn(this.cfg.emailGatewayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(emailGatewayPayload(msg, this.cfg.emailFrom, to)),
        ...(timeoutSignal(this.cfg.timeoutMs) ? { signal: timeoutSignal(this.cfg.timeoutMs) } : {}),
      });
      const status = Number(res?.status ?? 0);
      return status >= 200 && status < 300
        ? { channel: this.kind, ok: true }
        : { channel: this.kind, ok: false, detail: `邮件网关 HTTP ${status}` };
    } catch (e: any) {
      return { channel: this.kind, ok: false, detail: String(e?.message ?? e).slice(0, 300) };
    }
  }
}

// --------------------------------------------------------------------------- 短信
/** 短信网关载荷（纯函数，通用 {phone,text,signature}） */
export function smsGatewayPayload(msg: NotificationMessage, phone: string, signature: string): Record<string, any> {
  return {
    phone,
    text: `【${signature || 'LabelFlow'}】${msg.title}：${msg.body}`.slice(0, 500),
  };
}

function normalizePhone(v: string | undefined): string {
  const s = String(v ?? '').replace(/[\s-]/g, '');
  return /^1[3-9]\d{9}$|^\+?\d{7,15}$/.test(s) ? s : '';
}

export class SmsChannel implements NotificationChannel {
  readonly kind = 'sms';
  constructor(private cfg: NotifyConfig, private fetchImpl?: FetchLike) {}

  async send(msg: NotificationMessage, _savedId: number): Promise<ChannelDelivery> {
    if (!this.cfg.smsGatewayUrl) {
      return { channel: this.kind, ok: false, detail: '未配置短信网关（SMS_GATEWAY_URL）' };
    }
    const phone = normalizePhone(recipientsOf(msg).phone);
    if (!phone) return { channel: this.kind, ok: false, detail: '缺有效手机号（recipients.phone / metadata.phone）' };
    const fetchFn = resolveFetch(this.fetchImpl);
    if (!fetchFn) return { channel: this.kind, ok: false, detail: '运行环境不支持 fetch' };
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'LabelFlow-Notify/1.0' };
      if (this.cfg.smsApiKey) headers.Authorization = `Bearer ${this.cfg.smsApiKey}`;
      const res = await fetchFn(this.cfg.smsGatewayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(smsGatewayPayload(msg, phone, this.cfg.smsSignature)),
        ...(timeoutSignal(this.cfg.timeoutMs) ? { signal: timeoutSignal(this.cfg.timeoutMs) } : {}),
      });
      const status = Number(res?.status ?? 0);
      return status >= 200 && status < 300
        ? { channel: this.kind, ok: true }
        : { channel: this.kind, ok: false, detail: `短信网关 HTTP ${status}` };
    } catch (e: any) {
      return { channel: this.kind, ok: false, detail: String(e?.message ?? e).slice(0, 300) };
    }
  }
}

/** 按配置构建默认通道集合（NotifyModule.onModuleInit 注册；fetchImpl 供测试注入） */
export function buildExternalChannels(cfg: NotifyConfig, fetchImpl?: FetchLike): NotificationChannel[] {
  return [new FeishuChannel(cfg, fetchImpl), new EmailChannel(cfg, fetchImpl), new SmsChannel(cfg, fetchImpl)];
}
