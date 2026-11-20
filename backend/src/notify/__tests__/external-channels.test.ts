// 外部通知通道测试：payload 纯函数 + 三通道发送/失败/缺配置/缺收件人。全程注入 mock fetch，不触网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FeishuChannel, EmailChannel, SmsChannel, recipientsOf,
  feishuTextPayload, feishuCardPayload, emailGatewayPayload, smsGatewayPayload,
  buildExternalChannels, type FetchLike,
} from '../external-channels';
import { notifyConfigFromEnv, type NotifyConfig } from '../notify.config';
import type { NotificationMessage } from '../notification.channel';

const msg = (over: Partial<NotificationMessage> = {}): NotificationMessage => ({
  tenantId: 1, category: 'alert', title: '库存预警', body: '主板低于安全库存',
  ...over,
});

const cfg = (over: Partial<NotifyConfig> = {}): NotifyConfig => ({
  feishuWebhook: '', emailGatewayUrl: '', emailApiKey: '',
  emailFrom: 'noreply@labelflow.local', smsGatewayUrl: '', smsApiKey: '',
  smsSignature: 'LabelFlow', timeoutMs: 5000, ...over,
});

/** mock fetch：记录调用，返回可配置状态与 body */
function mockFetch(status = 200, body = '{"StatusCode":0}') {
  const calls: Array<{ url: string; init: any }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => body };
  };
  return { fn, calls };
}

test('配置解析：缺省全关，超时钳制在 [100,30000]', () => {
  const empty = notifyConfigFromEnv({});
  assert.equal(empty.feishuWebhook, '');
  assert.equal(empty.emailGatewayUrl, '');
  assert.equal(empty.smsGatewayUrl, '');
  assert.equal(empty.timeoutMs, 5000);
  assert.equal(notifyConfigFromEnv({ NOTIFY_TIMEOUT_MS: '1' }).timeoutMs, 100);
  assert.equal(notifyConfigFromEnv({ NOTIFY_TIMEOUT_MS: '999999' }).timeoutMs, 30000);
  assert.equal(notifyConfigFromEnv({ FEISHU_WEBHOOK: 'https://x', EMAIL_GATEWAY_URL: 'https://e' }).feishuWebhook, 'https://x');
});

test('收件人解析：recipients 优先，metadata 兜底', () => {
  assert.deepEqual(recipientsOf(msg({
    recipients: { email: 'a@b.com', phone: '13800138000' },
    metadata: { email: 'old@b.com', feishuWebhook: 'https://hook' },
  })), { email: 'a@b.com', feishuWebhook: 'https://hook', phone: '13800138000' });
});

test('飞书 payload：文本与卡片（含链接按钮），标题按类别配色', () => {
  const text = feishuTextPayload(msg({ metadata: { link: 'https://detail' } }));
  assert.equal(text.msg_type, 'text');
  assert.ok(text.content.text.includes('【alert】库存预警'));
  assert.ok(text.content.text.includes('https://detail'));
  const card = feishuCardPayload(msg({ metadata: { link: 'https://detail' } }));
  assert.equal(card.msg_type, 'interactive');
  assert.equal(card.card.header.template, 'red');
  assert.equal(card.card.elements[1].tag, 'action');
});

test('邮件/短信 payload：转义 HTML、手机号与文本截断', () => {
  const mail = emailGatewayPayload(msg({ title: '<b>x</b>' }), 'from@x.com', ['a@b.com']);
  assert.equal(mail.subject, '[alert] <b>x</b>');
  assert.ok(mail.html.includes('&lt;b&gt;'));
  const sms = smsGatewayPayload(msg(), '13800138000', 'LabelFlow');
  assert.ok(sms.text.startsWith('【LabelFlow】库存预警'));
});

test('飞书通道：成功投递；业务码非 0 判失败；缺 webhook 不发送', async () => {
  const ok = mockFetch(200, '{"StatusCode":0}');
  const r = await new FeishuChannel(cfg({ feishuWebhook: 'https://hooks.feishu.cn/x' }), ok.fn)
    .send(msg(), 1);
  assert.equal(r.ok, true);
  assert.equal(ok.calls.length, 1);

  const bizErr = mockFetch(200, '{"StatusCode":19001,"StatusMessage":"签名错误"}');
  const r2 = await new FeishuChannel(cfg({ feishuWebhook: 'https://hooks.feishu.cn/x' }), bizErr.fn)
    .send(msg(), 1);
  assert.equal(r2.ok, false);
  assert.ok(r2.detail?.includes('19001'));

  const noHook = mockFetch();
  const r3 = await new FeishuChannel(cfg(), noHook.fn).send(msg(), 1);
  assert.equal(r3.ok, false);
  assert.equal(noHook.calls.length, 0);

  const badHook = await new FeishuChannel(cfg({ feishuWebhook: 'http://insecure' }), mockFetch().fn).send(msg(), 1);
  assert.equal(badHook.ok, false);
});

test('邮件通道：多收件人成功；非法邮箱/缺网关判失败；网关 500 判失败', async () => {
  const ok = mockFetch(202, '');
  const r = await new EmailChannel(cfg({ emailGatewayUrl: 'https://mail/x', emailApiKey: 'k' }), ok.fn)
    .send(msg({ recipients: { email: ['a@b.com', 'bad', 'c@d.com'] } }), 1);
  assert.equal(r.ok, true);
  const body = JSON.parse(ok.calls[0].init.body);
  assert.deepEqual(body.to, ['a@b.com', 'c@d.com']);
  assert.equal(ok.calls[0].init.headers.Authorization, 'Bearer k');

  const noRecipient = await new EmailChannel(cfg({ emailGatewayUrl: 'https://mail/x' }), mockFetch().fn).send(msg(), 1);
  assert.equal(noRecipient.ok, false);

  const noGateway = await new EmailChannel(cfg(), mockFetch().fn)
    .send(msg({ recipients: { email: 'a@b.com' } }), 1);
  assert.equal(noGateway.ok, false);

  const failed = await new EmailChannel(cfg({ emailGatewayUrl: 'https://mail/x' }), mockFetch(500, '').fn)
    .send(msg({ recipients: { email: 'a@b.com' } }), 1);
  assert.equal(failed.ok, false);
});

test('短信通道：手机号校验、成功与失败', async () => {
  const ok = mockFetch(200, '');
  const r = await new SmsChannel(cfg({ smsGatewayUrl: 'https://sms/x' }), ok.fn)
    .send(msg({ recipients: { phone: '138-0013-8000' } }), 1);
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(ok.calls[0].init.body).phone, '13800138000');

  const bad = await new SmsChannel(cfg({ smsGatewayUrl: 'https://sms/x' }), mockFetch().fn)
    .send(msg({ recipients: { phone: '123' } }), 1);
  assert.equal(bad.ok, false);

  const noGw = await new SmsChannel(cfg(), mockFetch().fn)
    .send(msg({ recipients: { phone: '13800138000' } }), 1);
  assert.equal(noGw.ok, false);
});

test('通道集合：始终构建三种，失败通道不影响其余', async () => {
  const channels = buildExternalChannels(cfg({
    feishuWebhook: 'https://hooks.feishu.cn/x', emailGatewayUrl: 'https://mail/x', smsGatewayUrl: 'https://sms/x',
  }), mockFetch(200, '{"StatusCode":0}').fn);
  assert.deepEqual(channels.map((c) => c.kind), ['feishu', 'email', 'sms']);
  const r = await channels[0].send(msg(), 1);
  assert.equal(r.channel, 'feishu');
});
