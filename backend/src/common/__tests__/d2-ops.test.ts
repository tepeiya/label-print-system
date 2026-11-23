// D2 上线加固的纯函数单测：限流分档/分桶、traceId 复用、日志脱敏。
// 约束：不 import Nest 装饰器、不连 Redis（那些靠真库/HTTP 验收，见 test/integration/rls-enforce.int.test.ts）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateKey, rateLimitFor, rateScopeFor } from '../rate-limit.middleware';
import { maskFields, resolveTraceId } from '../trace.middleware';

test('rateScopeFor: 登录类进严档、健康探针不限流、其余走通用档', () => {
  assert.equal(rateScopeFor('/api/v1/auth/login'), 'login');
  assert.equal(rateScopeFor('/api/v1/auth/refresh'), 'login');
  assert.equal(rateScopeFor('/auth/register'), 'login');
  assert.equal(rateScopeFor('/api/v1/health'), 'skip');
  assert.equal(rateScopeFor('/health/live'), 'skip');
  assert.equal(rateScopeFor('/api/v1/templates'), 'global');
  assert.equal(rateScopeFor('/api/v1/print/jobs/123'), 'global');
});

test('rateScopeFor: 前缀不能误伤（login 子路径算严档，别把 authx 算进去）', () => {
  assert.equal(rateScopeFor('/api/v1/auth/login/wechat'), 'login');
  assert.equal(rateScopeFor('/api/v1/authx/list'), 'global');
  assert.equal(rateScopeFor('/api/v1/healthcheck'), 'global');   // 不是 /health 子路径
});

test('rateLimitFor: 严档恒 ≤ 通用档（防止有人把两个 env 配反）', () => {
  assert.ok(rateLimitFor('login') <= rateLimitFor('global'));
  assert.ok(rateLimitFor('login') > 0 && rateLimitFor('global') > 0);
});

test('rateKey: 同 IP 同分钟同 key，跨分钟/跨档/跨 IP 都必须不同', () => {
  const t = new Date('2026-11-23T08:00:10Z').getTime();
  const k = rateKey('global', '1.2.3.4', t);
  assert.equal(k, rateKey('global', '1.2.3.4', t + 1000));            // 同一分钟桶
  assert.notEqual(k, rateKey('global', '1.2.3.4', t + 60_000));       // 下一分钟
  assert.notEqual(k, rateKey('login', '1.2.3.4', t));                 // 跨档互不影响
  assert.notEqual(k, rateKey('global', '5.6.7.8', t));                // 跨 IP
  assert.match(k, /^lf:rl:global:1\.2\.3\.4:\d+$/);
});

test('resolveTraceId: 复用上游 id，超长/空 → 生成 16 位 hex', () => {
  assert.equal(resolveTraceId('abc-123'), 'abc-123');
  assert.match(resolveTraceId(''), /^[0-9a-f]{16}$/);                 // 空 → 生成
  const a = resolveTraceId(undefined);
  const b = resolveTraceId(null);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.match(b, /^[0-9a-f]{16}$/);
  assert.equal(resolveTraceId('x'.repeat(65)).length, 16);            // 超长不采信，重新生成
});

test('maskFields: 凭证类字段一律 ***，其余原样', () => {
  const out = maskFields({
    authorization: 'Bearer secret', cookie: 'sid=1', PassWord: 'p', access_token: 't',
    refresh_token: 'r', client_secret: 's', x_api_token: 'a', oldPassword: 'o',
    path: '/api/v1/x', status: 200,
  })!;
  for (const k of ['authorization', 'cookie', 'PassWord', 'access_token', 'refresh_token', 'client_secret', 'x_api_token', 'oldPassword']) {
    assert.equal(out[k], '***', `${k} 必须脱敏`);
  }
  assert.equal(out.path, '/api/v1/x');
  assert.equal(out.status, 200);
  assert.equal(out.path, '/api/v1/x');              // 非敏感字段不能被误伤
  assert.equal(maskFields(undefined), undefined);
});
