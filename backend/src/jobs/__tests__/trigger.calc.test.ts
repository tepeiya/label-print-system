// P8.1 判定层单测：规则归一化 / SSRF / 条件求值 / 循环防护 / 去重 / 签名 / 稳定化 / 编排
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TRIGGER_DEPTH, STABLE_MS, TRIGGER_ACTIONS, TRIGGER_SOURCES,
  backoffDelay, conditionContext, dedupeKey, dropFileKey, fileStable, fingerprint,
  guardLoop, matchCondition, normalizeRule, planDeliveries, printProgressToTrigger, publicConfig,
  signatureHeaders, validateConditionExpr, validateWebhookUrl, verifySignature,
  type TriggerRule,
} from '../trigger.calc';

const rule = (over: Partial<TriggerRule> = {}): TriggerRule => ({
  id: 1, tenantId: 7, name: 'r1', source: 'print.job.completed',
  conditionExpr: null, action: 'webhook', config: { url: 'https://example.com/hook' }, enabled: true,
  ...over,
});

// ------------------------------ 规则归一化 ------------------------------

test('normalizeRule：三种动作都能构造出合法规则', () => {
  const web = normalizeRule({ name: ' 通知 ', source: 'print.job.completed', action: 'webhook', config: { url: 'https://a.example.com/x' } }, { tenantId: 7 });
  assert.equal(web.ok, true);
  assert.equal(web.value?.name, '通知');
  assert.equal(web.value?.enabled, true, '默认启用');
  assert.equal(web.value?.source, 'print.job.completed');

  const notif = normalizeRule({ name: 'n', source: 'hotfolder.file', action: 'notification', config: { title: 'T', body: 'B' } }, { tenantId: 7 });
  assert.equal(notif.ok, true);

  const prn = normalizeRule({ name: 'p', source: 'hotfolder.file', action: 'print', config: { templateId: 3, copies: 2 } }, { tenantId: 7 });
  assert.equal(prn.ok, true);
  assert.equal(prn.value?.action, 'print');
});

test('normalizeRule：禁用规则、显式关闭、id 透传', () => {
  const r = normalizeRule({ name: 'x', source: 'template.updated', action: 'notification', config: { title: 't', body: 'b' }, enabled: false }, { tenantId: 9, id: 42 });
  assert.equal(r.ok, true);
  assert.equal(r.value?.enabled, false);
  assert.equal(r.value?.tenantId, 9);
  assert.equal(r.value?.id, 42);
});

test('normalizeRule：未知事件源/动作、缺字段一律拒绝并给出可读原因', () => {
  const a = normalizeRule({ name: 'x', source: 'ftp.upload', action: 'webhook', config: { url: 'https://a.example.com' } }, { tenantId: 7 });
  assert.equal(a.ok, false);
  assert.ok(a.errors.some((e) => e.includes('未知事件源')));

  const b = normalizeRule({ name: 'x', source: 'template.updated', action: 'rm_rf', config: {} }, { tenantId: 7 });
  assert.ok(b.errors.some((e) => e.includes('未知动作')));

  const c = normalizeRule({ name: '', source: 'hotfolder.file', action: 'print', config: {} }, { tenantId: 7 });
  assert.ok(c.errors.some((e) => e.includes('name')));
  assert.ok(c.errors.some((e) => e.includes('templateId')));

  const d = normalizeRule({ name: 'x', source: 'hotfolder.file', action: 'print', config: { templateId: 1, copies: 9999 } }, { tenantId: 7 });
  assert.ok(d.errors.some((e) => e.includes('copies')));
});

test('白名单是单一真源：常量与归一化判定一致', () => {
  assert.equal(TRIGGER_SOURCES.length, 5);
  assert.equal(TRIGGER_ACTIONS.length, 3);
  for (const s of TRIGGER_SOURCES) {
    const r = normalizeRule({ name: 'n', source: s, action: 'notification', config: { title: 't', body: 'b' } }, { tenantId: 1 });
    assert.equal(r.ok, true, `${s} 应可用`);
  }
});

// ------------------------------ SSRF ------------------------------

test('validateWebhookUrl：正常 https 通过，URL 规范化', () => {
  const r = validateWebhookUrl('https://hooks.example.com/label?a=1');
  assert.equal(r.ok, true);
  assert.match(r.url ?? '', /^https:\/\/hooks\.example\.com/);
});

test('validateWebhookUrl：拒绝 http、内嵌凭证、非 http(s) 协议', () => {
  assert.equal(validateWebhookUrl('http://example.com/h').ok, false);
  assert.equal(validateWebhookUrl('https://u:p@example.com/h').ok, false);
  assert.equal(validateWebhookUrl('file:///etc/passwd').ok, false);
  assert.equal(validateWebhookUrl('ftp://example.com').ok, false);
  assert.equal(validateWebhookUrl('not a url').ok, false);
});

test('validateWebhookUrl：拒绝内网/回环/云元数据地址（https 也挡）', () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '172.16.0.1', '172.31.255.1', 'localhost', 'a.local', 'metadata.google.internal']) {
    const r = validateWebhookUrl(`https://${host}/x`);
    assert.equal(r.ok, false, `${host} 必须拦截`);
  }
  // 172.32 不在私有段，应放行
  assert.equal(validateWebhookUrl('https://172.32.0.1/x').ok, true);
});

test('validateWebhookUrl：仅显式开启时才放行 http://localhost（本机调试）', () => {
  assert.equal(validateWebhookUrl('http://localhost:9000/hook').ok, false);
  const r = validateWebhookUrl('http://localhost:9000/hook', { allowHttpLoopback: true });
  assert.equal(r.ok, true);
  assert.equal(validateWebhookUrl('http://127.0.0.1:9000/hook', { allowHttpLoopback: true }).ok, true);
  assert.equal(validateWebhookUrl('http://10.0.0.1/hook', { allowHttpLoopback: true }).ok, false);
});

test('normalizeRule 内置 SSRF 校验：脏 URL 直接拒收规则', () => {
  const r = normalizeRule({ name: 'x', source: 'print.job.completed', action: 'webhook', config: { url: 'https://169.254.169.254/latest/meta-data' } }, { tenantId: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('内网')));
});

// ------------------------------ 条件求值 ------------------------------

test('validateConditionExpr：空表达式合法；危险标识符/分号拒绝', () => {
  assert.deepEqual(validateConditionExpr(null), []);
  assert.deepEqual(validateConditionExpr('  '), []);
  assert.deepEqual(validateConditionExpr('{{done}} > 0'), []);
  assert.ok(validateConditionExpr('a; require("fs")').length >= 2);
  assert.ok(validateConditionExpr('process.exit(1)').length > 0);
  assert.ok(validateConditionExpr('x'.repeat(500)).length > 0);
});

test('matchCondition：变量用 {{name}} 占位（与模板同源）；真/假/未定义变量 fail-closed', () => {
  assert.equal(matchCondition(null, { done: 3 }).matched, true);
  assert.equal(matchCondition('{{done}} > 2', { done: 3 }).matched, true);
  assert.equal(matchCondition('{{done}} > 2', { done: 1 }).matched, false);
  assert.equal(matchCondition('{{status}} == "success"', { status: 'success' }).matched, true);
  const miss = matchCondition('{{notExist}} > 0', { done: 3 });
  assert.equal(miss.matched, false);
  assert.match(miss.reason, /fail-closed/);
  // 裸标识符是引擎的「未知标识符」，同样 fail-closed（不另造一套变量语法）
  assert.equal(matchCondition('done > 0', { done: 3 }).matched, false);
  const bad = matchCondition('1 +', {});
  assert.equal(bad.matched, false);
});

test('conditionContext 只暴露标量，嵌套对象不外泄', () => {
  const ctx = conditionContext({ done: 2, status: 'success', nested: { secret: 1 }, arr: [1, 2] });
  assert.deepEqual(ctx, { done: 2, status: 'success' });
});

// ------------------------------ 循环防护 ------------------------------

test('guardLoop：打印事件不能再触发打印动作', () => {
  const r = guardLoop({ source: 'print.job.completed', tenantId: 7, payload: {} }, rule({ action: 'print' }));
  assert.equal(r.allowed, false);
  assert.match(r.reason, /直连/);
  assert.equal(guardLoop({ source: 'hotfolder.file', tenantId: 7, payload: {} }, rule({ action: 'print' })).allowed, true);
  assert.equal(guardLoop({ source: 'print.job.completed', tenantId: 7, payload: {} }, rule({ action: 'webhook' })).allowed, true);
});

test('guardLoop：深度达到上限即丢弃', () => {
  const ev = { source: 'template.updated', tenantId: 7, payload: {}, depth: MAX_TRIGGER_DEPTH };
  const r = guardLoop(ev, rule());
  assert.equal(r.allowed, false);
  assert.match(r.reason, /深度/);
  assert.equal(guardLoop({ ...ev, depth: MAX_TRIGGER_DEPTH - 1 }, rule()).allowed, true);
  assert.equal(guardLoop({ ...ev, depth: -1 }, rule()).allowed, false);
});

// ------------------------------ 去重 / 签名 / 稳定化 ------------------------------

test('fingerprint 与键顺序无关，payload 变化则不同', () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});

test('dedupeKey：同事件稳定，不同事件/不同规则不同', () => {
  const ev = { source: 'print.job.completed', tenantId: 7, payload: { done: 1 }, eventId: 'e1' };
  assert.equal(dedupeKey(1, ev), dedupeKey(1, ev));
  assert.equal(dedupeKey(1, { ...ev, eventId: 'e1' }), dedupeKey(1, ev), '无 eventId 时按 payload 指纹');
  assert.notEqual(dedupeKey(2, ev), dedupeKey(1, ev));
  assert.notEqual(dedupeKey(1, { ...ev, eventId: 'e2' }), dedupeKey(1, ev));
});

test('dropFileKey：同名但内容/mtime 变化会重新触发', () => {
  const a = dropFileKey(3, '/in/order.csv', { size: 100, mtimeMs: 1000 });
  const b = dropFileKey(3, '/in/order.csv', { size: 100, mtimeMs: 1000 });
  assert.equal(a, b);
  assert.notEqual(a, dropFileKey(3, '/in/order.csv', { size: 120, mtimeMs: 1000 }));
  assert.notEqual(a, dropFileKey(3, '/in/other.csv', { size: 100, mtimeMs: 1000 }));
});

test('signatureHeaders / verifySignature：往返、篡改、重放窗口', () => {
  const body = JSON.stringify({ a: 1 });
  const now = 1_700_000_000_000;
  const h = signatureHeaders(body, 's3cr3t', now);
  assert.equal(verifySignature(body, 's3cr3t', h['X-LabelFlow-Timestamp'], h['X-LabelFlow-Signature'], now), true);
  assert.equal(verifySignature(body, 'wrong', h['X-LabelFlow-Timestamp'], h['X-LabelFlow-Signature'], now), false);
  assert.equal(verifySignature(body + ' ', 's3cr3t', h['X-LabelFlow-Timestamp'], h['X-LabelFlow-Signature'], now), false);
  assert.equal(verifySignature(body, 's3cr3t', h['X-LabelFlow-Timestamp'], h['X-LabelFlow-Signature'], now + 400_000), false, '超过 300s 容差判重放');
  assert.equal(verifySignature(body, 's3cr3t', h['X-LabelFlow-Timestamp'], 'sha256=zz', now), false);
});

test('fileStable：首次/写入中/窗口未到/稳定四个状态', () => {
  const t = 10_000;
  const cur = { size: 100, mtimeMs: 500, seenAt: t };
  assert.equal(fileStable(null, cur, t).stable, false);
  assert.equal(fileStable(cur, { ...cur, size: 120 }, t + 1000).stable, false);
  assert.equal(fileStable(cur, cur, t + STABLE_MS - 1).stable, false);
  assert.equal(fileStable(cur, cur, t + STABLE_MS).stable, true);
});

test('backoffDelay 指数退避且有上限', () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(3), 8000);
  assert.equal(backoffDelay(99), 30_000);
});

// ------------------------------ 编排 ------------------------------

test('planDeliveries：命中规则产出投递计划并带 dedupeKey', () => {
  const ev = { source: 'print.job.completed', tenantId: 7, payload: { done: 5, failed: 0 }, eventId: 'e1' };
  const p = planDeliveries([rule()], ev);
  assert.equal(p.deliveries.length, 1);
  assert.equal(p.deliveries[0].rule.id, 1);
  assert.match(p.deliveries[0].dedupeKey, /^trig:1:/);
  assert.deepEqual(p.skipped, []);
});

test('planDeliveries：跨租户规则硬拦截（多租户红线）', () => {
  const p = planDeliveries([rule({ tenantId: 8 })], { source: 'print.job.completed', tenantId: 7, payload: {} });
  assert.equal(p.deliveries.length, 0);
  assert.match(p.skipped[0].reason, /跨租户/);
});

test('planDeliveries：停用 / 源不匹配 / 条件为假 / 循环 全部进 skipped 且不投递', () => {
  const ev = { source: 'print.job.completed', tenantId: 7, payload: { done: 1 } };
  const rules = [
    rule({ id: 1, enabled: false }),
    rule({ id: 2, source: 'template.updated' }),
    rule({ id: 3, conditionExpr: '{{done}} > 10' }),
    rule({ id: 4, action: 'print' }),
    rule({ id: 5, config: { url: 'https://ok.example.com' } }),
  ];
  const p = planDeliveries(rules, ev);
  assert.deepEqual(p.deliveries.map((d) => d.rule.id), [5]);
  assert.equal(p.skipped.length, 4);
  assert.ok(p.skipped.some((s) => s.reason.includes('停用')));
  assert.ok(p.skipped.some((s) => s.reason.includes('事件源')));
  assert.ok(p.skipped.some((s) => s.reason.includes('条件为假')));
  assert.ok(p.skipped.some((s) => s.reason.includes('直连')));
});

test('planDeliveries：同事件多条规则各自独立去重键', () => {
  const ev = { source: 'hotfolder.file', tenantId: 7, payload: { rows: 2 }, eventId: 'f1' };
  const p = planDeliveries([
    rule({ id: 1, source: 'hotfolder.file' }),
    rule({ id: 2, source: 'hotfolder.file', action: 'notification', config: { title: 't', body: 'b' } }),
  ], ev);
  assert.equal(p.deliveries.length, 2);
  assert.notEqual(p.deliveries[0].dedupeKey, p.deliveries[1].dedupeKey);
});

test('publicConfig：密钥类字段一律不外泄，业务字段保留', () => {
  const out = publicConfig({
    url: 'https://a.example.com/h', secret: 'plain', secretEnc: 'cipher',
    password: 'p', token: 't', apiKey: 'a', templateId: 3, copies: 2,
  });
  assert.equal(out.secret, undefined);
  assert.equal(out.secretEnc, undefined);
  assert.equal(out.password, undefined);
  assert.equal(out.token, undefined);
  assert.equal(out.apiKey, undefined);
  assert.equal(out.url, 'https://a.example.com/h');
  assert.equal(out.templateId, 3);
});

test('printProgressToTrigger：只认 completed，成功/失败映射不同源', () => {
  assert.equal(printProgressToTrigger({ type: 'progress', tenantId: 7 }), null);
  assert.equal(printProgressToTrigger(null), null);
  assert.equal(printProgressToTrigger({ type: 'completed', tenantId: 0, status: 'success' }), null);
  const ok = printProgressToTrigger({ type: 'completed', tenantId: 7, status: 'success', jobId: 12, done: 3, failed: 0, total: 3, at: 123 });
  assert.equal(ok?.source, 'print.job.completed');
  assert.equal(ok?.eventId, 'print:12:123');
  assert.equal(ok?.payload.failed, 0);
  const bad = printProgressToTrigger({ type: 'completed', tenantId: 7, status: 'partial', jobId: 13, done: 2, failed: 1, total: 3 });
  assert.equal(bad?.source, 'print.job.failed');
});
