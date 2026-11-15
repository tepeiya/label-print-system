// P8.5 本地打印代理协议判定层单测（纯函数，不需要 Redis / 真机）
import test from 'node:test';
import assert from 'node:assert/strict';
import { signatureHeaders } from '../../jobs/trigger.calc';
import {
  AGENT_CLAIM_TTL_SEC, AGENT_JOB_MAX_ATTEMPTS, AGENT_PROTOCOL_VERSION,
  agentJobEnvelope, agentJobKey, agentOnline, agentStatus, claimExpired,
  normalizeAgentRegistration, normalizeHeartbeat, selectAgentForJob,
  transitionReceipt, verifyAgentSignature, verifyReceipt,
} from '../agent-protocol.calc';

const NOW = new Date('2026-01-01T00:00:00.000Z');

// ------------------------------ 注册 ------------------------------
test('normalizeAgentRegistration：合法注册 + 未知能力给 warning 不拒绝', () => {
  const v = normalizeAgentRegistration({
    tenantId: 7, agentId: 'win-01', name: '车间 A 电脑',
    capabilities: ['windows_spooler', 'rfid', 'future_cap'], driverNames: ['ZDesigner ZT411'],
    metadata: { os: 'Windows 11' },
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.registration?.capabilities, ['windows_spooler', 'rfid']);
  assert.equal(v.registration?.tenantId, 7);
  assert.deepEqual(v.registration?.driverNames, ['ZDesigner ZT411']);
  assert.match(v.warnings.join(' '), /未知能力/);
});

test('normalizeAgentRegistration：tenant_id / agentId 非法 fail-closed', () => {
  assert.equal(normalizeAgentRegistration({ tenantId: 0, agentId: 'win-01' }).ok, false);
  assert.equal(normalizeAgentRegistration({ tenantId: 7, agentId: 'a' }).ok, false);
  assert.equal(normalizeAgentRegistration({ tenantId: 7, agentId: '../evil' }).ok, false);
  assert.equal(normalizeAgentRegistration({ tenantId: 7, agentId: 'ok-agent' }).ok, true);
  assert.match(normalizeAgentRegistration({ tenantId: 7, agentId: 'ok-agent', capabilities: [] }).warnings.join(' '), /未声明任何能力/);
});

// ------------------------------ 心跳 ------------------------------
test('agentOnline / agentStatus：冻时间判边界，脏值一律离线', () => {
  const hb = new Date(NOW.getTime() - 60_000).toISOString();
  assert.equal(agentOnline(hb, NOW), true, '60s 内在线');
  assert.equal(agentOnline(new Date(NOW.getTime() - 91_000).toISOString(), NOW), false, '超 90s 离线');
  assert.equal(agentOnline(null, NOW), false);
  assert.equal(agentOnline('not-a-date', NOW), false);
  assert.equal(agentOnline(new Date(NOW.getTime() + 999_000).toISOString(), NOW), false, '未来时间超容差也算脏');
  assert.equal(agentStatus(hb, NOW), 'online');
  assert.equal(agentStatus(hb, NOW, true), 'draining');
  assert.equal(agentStatus(null, NOW), 'offline');
});

test('normalizeHeartbeat：load 夹取、能力白名单、draining 透传', () => {
  const v = normalizeHeartbeat({ agentId: 'win-01', load: 99999, capabilities: ['usb', 'bad'], draining: true }, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.heartbeat?.load, 1000);
  assert.deepEqual(v.heartbeat?.capabilities, ['usb']);
  assert.equal(v.heartbeat?.draining, true);
  assert.equal(normalizeHeartbeat({ agentId: 'x' }, NOW).ok, false);
});

// ------------------------------ 选代理 ------------------------------
test('selectAgentForJob：能力/租户/在线过滤 + 负载最小 + 字典序确定性', () => {
  const agents = [
    { agentId: 'b', tenantId: 1, capabilities: ['windows_spooler'], driverNames: ['D1'], status: 'online', load: 5, lastHeartbeatAt: null },
    { agentId: 'a', tenantId: 1, capabilities: ['windows_spooler'], driverNames: ['D1'], status: 'online', load: 5, lastHeartbeatAt: null },
    { agentId: 'c', tenantId: 1, capabilities: ['windows_spooler'], driverNames: ['D1'], status: 'online', load: 1, lastHeartbeatAt: null },
    { agentId: 'd', tenantId: 2, capabilities: ['windows_spooler'], driverNames: ['D1'], status: 'online', load: 0, lastHeartbeatAt: null },
    { agentId: 'e', tenantId: 1, capabilities: ['rfid'], driverNames: [], status: 'online', load: 0, lastHeartbeatAt: null },
    { agentId: 'f', tenantId: 1, capabilities: ['windows_spooler'], driverNames: ['D1'], status: 'offline', load: 0, lastHeartbeatAt: null },
    { agentId: 'g', tenantId: 1, capabilities: ['windows_spooler'], driverNames: ['D1'], status: 'draining', load: 0, lastHeartbeatAt: null },
  ] as any;
  assert.equal(selectAgentForJob(agents, { tenantId: 1, capability: 'windows_spooler' })?.agentId, 'c', '负载最小');
  const tied = agents.filter((a: any) => a.agentId === 'a' || a.agentId === 'b');
  assert.equal(selectAgentForJob(tied as any, { tenantId: 1, capability: 'windows_spooler' })?.agentId, 'a', '同负载按字典序');
  assert.equal(selectAgentForJob(agents, { tenantId: 1, capability: 'windows_spooler', driverName: 'D1' })?.agentId, 'c');
  assert.equal(selectAgentForJob(agents, { tenantId: 1, capability: 'windows_spooler', driverName: 'NOPE' }), null);
  assert.equal(selectAgentForJob(agents, { tenantId: 9, capability: 'windows_spooler' }), null, '跨租户不派发');
});

// ------------------------------ 任务信封与脱敏（核心） ------------------------------
const SRC = {
  tenantId: 7, jobId: 100, printerId: 3, templateId: 9,
  capability: 'windows_spooler' as const,
  labels: [{ zpl: '^XA^FO10,10^FDHi^FS^XZ', copies: 2 }, { pngBase64: 'iVBORw0KGgo=' }],
  settings: { dpi: 300, widthMm: 50, heightMm: 30, offsetXMm: 1, density: 8 },
  connection: {
    driverName: 'ZDesigner ZT411', host: '10.0.0.5', port: 9100,
    user: 'sa', password: 'p@ss', dsn: 'postgresql://u:p@db/label', token: 'abc',
  },
};

test('agentJobEnvelope：connection 凭证一律不出域，只留 driverName', () => {
  const e = agentJobEnvelope(SRC as any, NOW);
  assert.equal(e.version, AGENT_PROTOCOL_VERSION);
  assert.equal(e.driverName, 'ZDesigner ZT411');
  assert.equal(e.labels.length, 2);
  assert.deepEqual(e.labels[0], { format: 'zpl', data: '^XA^FO10,10^FDHi^FS^XZ', copies: 2 });
  assert.equal(e.labels[1].format, 'png-base64');
  assert.equal(e.settings.dpi, 300);
  assert.equal(e.settings.density, 8);
  const serialized = JSON.stringify(e);
  for (const secret of ['10.0.0.5', 'p@ss', 'postgresql://', 'abc', 'sa']) {
    assert.equal(serialized.includes(secret), false, `敏感字段 ${secret} 不得出现在信封里`);
  }
  for (const f of ['host', 'port', 'user', 'password', 'dsn', 'token']) {
    assert.ok(e.redactedFields.includes(f), `${f} 必须记入脱敏清单`);
  }
});

test('agentJobKey：内容相同幂等，内容/租户变化即不同', () => {
  const a = agentJobKey(SRC as any);
  assert.equal(a, agentJobKey(SRC as any));
  assert.notEqual(a, agentJobKey({ ...SRC, tenantId: 8 } as any));
  assert.notEqual(a, agentJobKey({ ...SRC, labels: [{ zpl: 'DIFFERENT' }] } as any));
  assert.equal(agentJobEnvelope(SRC as any, NOW).jobKey, a, '信封与独立计算一致');
});

// ------------------------------ 状态机 / 回执 ------------------------------
test('transitionReceipt：终态不可改写，重派只允许从 failed/expired 回 pending', () => {
  assert.equal(transitionReceipt('pending', 'claimed').ok, true);
  assert.equal(transitionReceipt('claimed', 'succeeded').ok, true);
  assert.equal(transitionReceipt('succeeded', 'failed').ok, false, '成功后再报失败必须拒绝');
  assert.equal(transitionReceipt('failed', 'pending').ok, true);
  assert.equal(transitionReceipt('claimed', 'bogus' as any).ok, false);
});

test('verifyReceipt：jobKey / agentId / tenant_id 三重匹配，防跨租户伪造', () => {
  const exp = { jobKey: 'k1', agentId: 'win-01', tenantId: 7, currentStatus: 'claimed' as const };
  assert.equal(verifyReceipt({ jobKey: 'k1', agentId: 'win-01', tenantId: 7, status: 'succeeded', printedCount: 2 }, exp).ok, true);
  const bad = verifyReceipt({ jobKey: 'k1', agentId: 'win-01', tenantId: 8, status: 'succeeded' }, exp);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /tenant_id/);
  assert.match(verifyReceipt({ jobKey: 'other', agentId: 'win-01', tenantId: 7, status: 'succeeded' }, exp).errors.join(' '), /jobKey/);
  assert.match(verifyReceipt({ jobKey: 'k1', agentId: 'other', tenantId: 7, status: 'succeeded' }, exp).errors.join(' '), /agentId/);
  assert.match(verifyReceipt({ jobKey: 'k1', agentId: 'win-01', tenantId: 7, status: 'succeeded', printedCount: -1 }, exp).errors.join(' '), /printedCount/);
});

// ------------------------------ 签名 / 回收 ------------------------------
test('verifyAgentSignature：复用 Webhook HMAC 真源，过期/篡改/错密钥都拒', () => {
  const body = '{"a":1}';
  const now = Date.parse('2026-01-01T00:00:00Z');
  const h = signatureHeaders(body, 'secret-x', now);
  assert.equal(verifyAgentSignature(body, 'secret-x', h['X-LabelFlow-Timestamp'], h['X-LabelFlow-Signature'], now), true);
  assert.equal(verifyAgentSignature(body, 'wrong', h['X-LabelFlow-Timestamp'], h['X-LabelFlow-Signature'], now), false);
  assert.equal(verifyAgentSignature(body + ' ', 'secret-x', h['X-LabelFlow-Timestamp'], h['X-LabelFlow-Signature'], now), false);
  assert.equal(verifyAgentSignature(body, 'secret-x', h['X-LabelFlow-Timestamp'], h['X-LabelFlow-Signature'], now + 400_000), false, '超时间窗');
});

test('claimExpired：认领超时可重派，终态/超重试/无认领时间不可', () => {
  const claimed = new Date(NOW.getTime() - (AGENT_CLAIM_TTL_SEC + 1) * 1000).toISOString();
  assert.equal(claimExpired(claimed, 'claimed', 0, NOW), true);
  assert.equal(claimExpired(claimed, 'succeeded', 0, NOW), false);
  assert.equal(claimExpired(claimed, 'claimed', AGENT_JOB_MAX_ATTEMPTS, NOW), false);
  assert.equal(claimExpired(null, 'claimed', 0, NOW), false);
  assert.equal(claimExpired(new Date(NOW.getTime() - 1000).toISOString(), 'claimed', 0, NOW), false);
});
