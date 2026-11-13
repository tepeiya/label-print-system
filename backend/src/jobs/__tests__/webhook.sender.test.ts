// P8.1 出站 Webhook 单测：签名、二次 SSRF 拦截、状态码、异常不抛出
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWebhook, webhookEnvelope } from '../webhook.sender';
import { verifySignature } from '../trigger.calc';

const event = {
  source: 'print.job.completed', tenantId: 7,
  payload: { jobId: 12, done: 3, failed: 0, status: 'success' },
  eventId: 'print:12:1', depth: 0,
};

test('webhookEnvelope：受控结构，只带事件数据不带内部对象', () => {
  const e = webhookEnvelope(event, new Date('2026-11-13T00:00:00Z'));
  assert.equal(e.type, 'labelflow.trigger');
  assert.equal(e.source, 'print.job.completed');
  assert.equal(e.tenantId, 7);
  assert.equal(e.data.jobId, 12);
  assert.equal(e.at, '2026-11-13T00:00:00.000Z');
});

test('sendWebhook：2xx 成功，签名头可被 verifySignature 校验', async () => {
  let captured: any = null;
  const now = 1_700_000_000_000;
  const out = await sendWebhook('https://hooks.example.com/x', 's3cr3t', webhookEnvelope(event), {
    nowMs: now,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { status: 204 };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.httpStatus, 204);
  assert.equal(captured.url, 'https://hooks.example.com/x');
  assert.equal(captured.init.method, 'POST');
  assert.equal(
    verifySignature(captured.init.body, 's3cr3t',
      captured.init.headers['X-LabelFlow-Timestamp'],
      captured.init.headers['X-LabelFlow-Signature'], now),
    true,
  );
  assert.match(captured.init.headers['X-LabelFlow-Signature'], /^sha256=[0-9a-f]{64}$/);
});

test('sendWebhook：非 2xx 返回失败并带状态码', async () => {
  const out = await sendWebhook('https://hooks.example.com/x', 'k', webhookEnvelope(event), {
    fetchImpl: async () => ({ status: 503 }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.httpStatus, 503);
  assert.match(out.error ?? '', /503/);
});

test('sendWebhook：fetch 异常不外抛，返回可读错误', async () => {
  const out = await sendWebhook('https://hooks.example.com/x', 'k', webhookEnvelope(event), {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /ECONNREFUSED/);
});

test('sendWebhook：投递前二次校验 URL，内网地址不发请求', async () => {
  let called = false;
  const out = await sendWebhook('https://169.254.169.254/latest/meta-data', 'k', webhookEnvelope(event), {
    fetchImpl: async () => { called = true; return { status: 200 }; },
  });
  assert.equal(out.ok, false);
  assert.equal(called, false, 'SSRF 目标绝不能发起请求');
  assert.match(out.error ?? '', /URL 校验失败/);
});

test('sendWebhook：http 非 loopback 默认拒绝，显式开启本机调试才放行', async () => {
  const bad = await sendWebhook('http://example.com/h', 'k', webhookEnvelope(event), {
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(bad.ok, false);
  const ok = await sendWebhook('http://localhost:9000/h', 'k', webhookEnvelope(event), {
    allowHttpLoopback: true,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(ok.ok, true);
});
