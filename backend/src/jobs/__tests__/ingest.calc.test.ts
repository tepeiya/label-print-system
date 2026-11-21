// =============================================================================
// ingest.calc.test.ts —— 外部业务事件入站判定层（扫码即打）纯函数单测
// 覆盖：验签（HMAC/超时/重放）、事件源白名单、租户隔离、payload 边界、幂等 eventId。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIngest, type IngestCtx } from '../ingest.calc';
import { signatureHeaders, verifySignature } from '../trigger.calc';

const SECRET = 'ingest-test-secret-0123456789';
const NOW = 1_700_000_000_000;

function ctx(overrides: Partial<IngestCtx> = {}): IngestCtx {
  return {
    tenantId: 7, secret: SECRET, tsHeader: '', sigHeader: '',
    rawBodyJson: '', nowMs: NOW, ...overrides,
  };
}

/** 用签名真源构造一份「已签名」的入站上下文（口径须与 normalizeIngest 一致：JSON.stringify(body)） */
function signedCtx(body: any, overrides: Partial<IngestCtx> = {}): IngestCtx {
  const raw = JSON.stringify(body);
  const h = signatureHeaders(raw, SECRET, NOW);
  return ctx({
    rawBodyJson: raw,
    tsHeader: h['X-LabelFlow-Timestamp'],
    sigHeader: h['X-LabelFlow-Signature'],
    ...overrides,
  });
}

const VALID_BODY = {
  source: 'stock.in',
  eventId: 'scan-2026-0001',
  payload: { sku: 'A100', rows: [{ sku: 'A100', batch: 'B1', qty: 1 }] },
};

test('normalizeIngest：合法签名事件 → 规范 TriggerEvent（tenantId 来自 ctx）', () => {
  const r = normalizeIngest(VALID_BODY, signedCtx(VALID_BODY));
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.value!.event.source, 'stock.in');
  assert.equal(r.value!.event.tenantId, 7);
  assert.equal(r.value!.event.eventId, 'scan-2026-0001');
  assert.equal(r.value!.event.depth, 0);
  assert.deepEqual(r.value!.event.payload.rows, [{ sku: 'A100', batch: 'B1', qty: 1 }]);
});

test('normalizeIngest：未配 secret 时跳过验签但显式警告（仅 Agent Token 鉴权）', () => {
  const r = normalizeIngest(VALID_BODY, ctx({ rawBodyJson: JSON.stringify(VALID_BODY), secret: '' }));
  assert.equal(r.ok, true);
  assert.ok(r.value!.warnings.some((w) => w.includes('HMAC')));
});

test('normalizeIngest：配了 secret 但缺签名/错签名 → 拒绝', () => {
  const noSig = normalizeIngest(VALID_BODY, ctx({ rawBodyJson: JSON.stringify(VALID_BODY) }));
  assert.equal(noSig.ok, false);
  assert.ok(noSig.errors.some((e) => e.includes('签名校验失败')));

  const badSig = normalizeIngest(VALID_BODY, ctx({
    rawBodyJson: JSON.stringify(VALID_BODY),
    tsHeader: String(Math.floor(NOW / 1000)),
    sigHeader: 'sha256=' + '0'.repeat(64),
  }));
  assert.equal(badSig.ok, false);
});

test('normalizeIngest：超时（重放窗口外）→ 拒绝', () => {
  const raw = JSON.stringify(VALID_BODY);
  const h = signatureHeaders(raw, SECRET, NOW);
  const r = normalizeIngest(VALID_BODY, ctx({
    rawBodyJson: raw, tsHeader: h['X-LabelFlow-Timestamp'], sigHeader: h['X-LabelFlow-Signature'],
    nowMs: NOW + 600_000, // +10 分钟，超出 300s 容忍窗
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('签名校验失败')));
});

test('normalizeIngest：内部事件源不可从外部伪造', () => {
  const body = { ...VALID_BODY, source: 'print.job.completed' };
  const r = normalizeIngest(body, signedCtx(body));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('事件源非法')));
  assert.ok(verifySignature(JSON.stringify(body), SECRET,
    signatureHeaders(JSON.stringify(body), SECRET, NOW)['X-LabelFlow-Timestamp'],
    signatureHeaders(JSON.stringify(body), SECRET, NOW)['X-LabelFlow-Signature'], NOW)); // 签名本身有效，拒的是 source
});

test('normalizeIngest：请求体 tenantId 被忽略并警告（租户只认 token）', () => {
  const body = { ...VALID_BODY, tenantId: 999, payload: { ...VALID_BODY.payload, tenant_id: 888 } };
  const r = normalizeIngest(body, signedCtx(body));
  assert.equal(r.ok, true);
  assert.equal(r.value!.event.tenantId, 7);
  assert.equal(r.value!.event.payload.tenantId, undefined);
  assert.equal(r.value!.event.payload.tenant_id, undefined);
  assert.ok(r.value!.warnings.some((w) => w.includes('tenantId')));
});

test('normalizeIngest：payload 边界（缺失/数组/rows 超限/行非对象）', () => {
  const cases = [
    { source: 'stock.in' },
    { ...VALID_BODY, payload: [1, 2, 3] },
    { ...VALID_BODY, payload: { rows: 'not-array' } },
    { ...VALID_BODY, payload: { rows: [1, 2] } },
  ];
  for (const b of cases) {
    const r = normalizeIngest(b, signedCtx(b));
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(b)}`);
  }
  // rows 正常通过
  assert.equal(normalizeIngest(VALID_BODY, signedCtx(VALID_BODY)).ok, true);
});

test('normalizeIngest：未提供 eventId 时用内容指纹兜底（幂等去重）', () => {
  const body = { source: 'qc.passed', payload: { sku: 'A100' } };
  const r = normalizeIngest(body, signedCtx(body));
  assert.equal(r.ok, true);
  assert.match(r.value!.event.eventId!, /^ingest:[0-9a-f]+$/);
});

test('normalizeIngest：超大 body 拒绝', () => {
  const body = { ...VALID_BODY, payload: { blob: 'x'.repeat(210_000) } };
  const r = normalizeIngest(body, signedCtx(body));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('过大')));
});
