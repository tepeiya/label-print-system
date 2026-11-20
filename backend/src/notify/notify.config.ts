// 通知通道配置：从环境变量解析，纯函数便于测试。
// 全部缺省关闭（空串/null），不会因未配置而误发外部通知。
export const NOTIFY_CONFIG = 'NOTIFY_CONFIG';

export interface NotifyConfig {
  /** 飞书默认群 webhook（消息未带 recipients.feishuWebhook 时用） */
  feishuWebhook: string;
  /** HTTP 邮件网关地址（POST from/to/subject/text/html）；留空则不发邮件 */
  emailGatewayUrl: string;
  emailApiKey: string;
  emailFrom: string;
  /** HTTP 短信网关地址（POST phone/text）；留空则不发短信 */
  smsGatewayUrl: string;
  smsApiKey: string;
  smsSignature: string;
  /** 外部通道超时（毫秒） */
  timeoutMs: number;
}

export function notifyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  return {
    feishuWebhook: env.FEISHU_WEBHOOK || '',
    emailGatewayUrl: env.EMAIL_GATEWAY_URL || '',
    emailApiKey: env.EMAIL_API_KEY || '',
    emailFrom: env.EMAIL_FROM || 'LabelFlow <noreply@labelflow.local>',
    smsGatewayUrl: env.SMS_GATEWAY_URL || '',
    smsApiKey: env.SMS_API_KEY || '',
    smsSignature: env.SMS_SIGNATURE || 'LabelFlow',
    timeoutMs: Math.max(100, Math.min(30_000, Number(env.NOTIFY_TIMEOUT_MS) || 5_000)),
  };
}
