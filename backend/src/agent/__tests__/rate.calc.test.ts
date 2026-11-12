// P5 纯函数单测：rate.calc（§11.7.7 护栏 5：Agent 维度 60 次/分 + 单次批量 ≤500）
// 约束：不 import 实体类、不连 Redis；AgentRateService 的 Redis 交互靠验收脚本实测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_MAX, DEFAULT_AGENT_RPM, RPM_MAX, RPM_MIN, WINDOW_MS,
  batchOverLimit, isLimited, rateLimitKey, rateLimitTtlMs, remaining, resolveRpm,
  // B3 多维细分与响应头
  makeOutcome, rateHeaders, resetSecOf, resolveRatePlan, retryAfterHeaders,
  tightestOutcome, tokenRateLimitKey, toolRateLimitKey, toolRpmFor,
} from '../rate.calc';

const NOW = new Date('2026-11-05T08:00:30.000Z');

test('rateLimitKey: 按 (tenant, client, 分钟桶) 分桶，租户与 client 互不串味', () => {
  const bucket = Math.floor(NOW.getTime() / WINDOW_MS);
  const k = rateLimitKey(98, 7, NOW);
  assert.equal(k, `lf:agent:rl:98:7:${bucket}`);
  assert.notEqual(rateLimitKey(99, 7, NOW), k);    // 换租户
  assert.notEqual(rateLimitKey(98, 8, NOW), k);    // 换 client（验收 M 段靠这个拿干净窗口）
  assert.equal(rateLimitKey(98, 7, new Date(NOW.getTime() + WINDOW_MS)), `lf:agent:rl:98:7:${bucket + 1}`);
});

test('rateLimitTtlMs: 窗口剩余 + 5s 余量，永远落在 (5s, 65s]', () => {
  const t = rateLimitTtlMs(NOW);
  assert.equal(t, WINDOW_MS - (NOW.getTime() % WINDOW_MS) + 5_000);
  assert.ok(t > 5_000 && t <= WINDOW_MS + 5_000);
  assert.equal(rateLimitTtlMs(new Date(NOW.getTime() + 10_000)), t - 10_000);
});

test('resolveRpm: 缺配置/脏值一律回退默认 60，有效值夹到 [1, 600]', () => {
  assert.equal(resolveRpm(null), DEFAULT_AGENT_RPM);
  assert.equal(resolveRpm(undefined), DEFAULT_AGENT_RPM);
  assert.equal(resolveRpm({}), DEFAULT_AGENT_RPM);
  assert.equal(resolveRpm({ rpm: 'abc' }), DEFAULT_AGENT_RPM);
  assert.equal(resolveRpm({ rpm: 0 }), DEFAULT_AGENT_RPM);
  assert.equal(resolveRpm({ rpm: -5 }), DEFAULT_AGENT_RPM);
  assert.equal(resolveRpm({ rpm: '1' }), 1);          // 字符串数字可用（运营后台常存字符串）
  assert.equal(resolveRpm({ rpm: 4.9 }), 4);          // 向下取整
  assert.equal(resolveRpm({ rpm: 999 }), RPM_MAX);
  assert.equal(resolveRpm({ rpm: 0.4 }), DEFAULT_AGENT_RPM);   // <1 视为脏值，不夹紧
  assert.equal(RPM_MIN, 1);
  assert.equal(RPM_MAX, 600);
});

test('isLimited/remaining: 第 rpm 次放行、第 rpm+1 次拦，剩余不为负', () => {
  assert.equal(isLimited(1, 1), false);
  assert.equal(isLimited(2, 1), true);
  assert.equal(remaining(1, 1), 0);
  assert.equal(remaining(3, 60), 57);
  assert.equal(remaining(999, 60), 0);
});

test('batchOverLimit: 单次批量 ≤500（copies 或 rows 超限都给中文原因）', () => {
  assert.equal(BATCH_MAX, 500);
  assert.equal(batchOverLimit(500, undefined), null);
  assert.equal(batchOverLimit(undefined, undefined), null);   // 缺省按 1 计
  assert.equal(batchOverLimit(0, []), null);                  // 0/空按 1 计
  assert.ok(String(batchOverLimit(501, undefined)).includes('份数'));
  assert.ok(String(batchOverLimit(1, new Array(501).fill(1))).includes('行数'));
  assert.equal(batchOverLimit('12', [{}, {}]), null);         // 字符串数字可解析
});

test('batchOverLimit: 自定义上限（低套餐收紧到 100 时生效）', () => {
  assert.equal(batchOverLimit(101, undefined, 100) !== null, true);
  assert.equal(batchOverLimit(100, undefined, 100), null);
});

// ========================= B3：多维细分 + 响应头 =========================

test('B3 维度 key：agent key 保持 P5 原样，tool/token 各自独立且互不串桶', () => {
  const bucket = Math.floor(NOW.getTime() / WINDOW_MS);
  assert.equal(rateLimitKey(98, 7, NOW), `lf:agent:rl:98:7:${bucket}`, '验收 M 段直接查这个 key，不能改');
  assert.equal(toolRateLimitKey(98, 7, 'print.submit_job', NOW), `lf:agent:rl:t:98:7:print.submit_job:${bucket}`);
  assert.equal(tokenRateLimitKey(98, 321, NOW), `lf:agent:rl:k:98:321:${bucket}`);
  assert.notEqual(toolRateLimitKey(98, 7, 'print.submit_job', NOW), toolRateLimitKey(98, 7, 'inventory.adjust', NOW));
  assert.notEqual(toolRateLimitKey(98, 7, 'x', NOW), toolRateLimitKey(99, 7, 'x', NOW));
  assert.notEqual(tokenRateLimitKey(98, 321, NOW), tokenRateLimitKey(98, 322, NOW));
  assert.notEqual(toolRateLimitKey(98, 7, 'x', NOW), rateLimitKey(98, 7, NOW));
  assert.ok(toolRateLimitKey(98, 7, 'bad tool/:*', NOW).includes('bad_tool___'), '危险字符白名单化');
});

test('B3 resolveRatePlan：旧配置 {"rpm":1} 完全兼容，tool/token 默认关闭', () => {
  const p = resolveRatePlan({ rpm: 1 });
  assert.equal(p.agent, 1);
  assert.equal(p.tool, 0);
  assert.equal(p.token, 0);
  assert.deepEqual(p.perTool, {});
  assert.equal(resolveRatePlan(null).agent, DEFAULT_AGENT_RPM);
  assert.equal(resolveRatePlan({ rpm: 'abc' }).agent, DEFAULT_AGENT_RPM);
});

test('B3 resolveRatePlan：三维阈值 + per_tool 覆盖，脏值/越界被夹住', () => {
  const p = resolveRatePlan({
    rpm: 120, tool_rpm: 10, token_rpm: 30,
    per_tool: { 'print.submit_job': 2, 'ai.generate': 0, 'bad': 'nope', 'huge': 9999 },
  });
  assert.equal(p.agent, 120);
  assert.equal(p.tool, 10);
  assert.equal(p.token, 30);
  assert.equal(p.perTool['print.submit_job'], 2);
  assert.equal(p.perTool['ai.generate'], undefined, '0/脏值不建覆盖');
  assert.equal(p.perTool['bad'], undefined);
  assert.equal(p.perTool['huge'], RPM_MAX);
  // camelCase 别名同样生效（运营后台存法不统一时不会静默失效）
  const p2 = resolveRatePlan({ toolRpm: 5, tokenRpm: 8, perTool: { 'x.y': 3 } });
  assert.equal(p2.tool, 5);
  assert.equal(p2.token, 8);
  assert.equal(p2.perTool['x.y'], 3);
});

test('B3 toolRpmFor：精确覆盖优先于全局 tool_rpm，未配时回落', () => {
  const p = resolveRatePlan({ tool_rpm: 10, per_tool: { 'print.submit_job': 2 } });
  assert.equal(toolRpmFor(p, 'print.submit_job'), 2);
  assert.equal(toolRpmFor(p, 'inventory.adjust'), 10);
  assert.equal(toolRpmFor(resolveRatePlan({}), 'any.tool'), 0, '默认关闭，不能无预警收紧存量租户');
});

test('B3 makeOutcome / rateHeaders：标准头齐全，Reset 为下一分钟桶的 Unix 秒', () => {
  const o = makeOutcome('tool', 10, 3, NOW);
  assert.equal(o.remaining, 7);
  assert.equal(o.scope, 'tool');
  assert.equal(o.resetSec, Math.ceil(((Math.floor(NOW.getTime() / WINDOW_MS) + 1) * WINDOW_MS) / 1000));
  assert.equal(resetSecOf(NOW), o.resetSec);
  const h = rateHeaders(o);
  assert.deepEqual(h, {
    'X-RateLimit-Limit': '10',
    'X-RateLimit-Remaining': '7',
    'X-RateLimit-Reset': String(o.resetSec),
    'X-RateLimit-Scope': 'tool',
    'X-RateLimit-Window': '60',
  });
  assert.deepEqual(retryAfterHeaders(o, NOW), { 'Retry-After': String(Math.max(1, o.resetSec - Math.floor(NOW.getTime() / 1000))) });
});

test('B3 tightestOutcome：多头通过时响应头反映最紧的那一维', () => {
  const agent = makeOutcome('agent', 60, 2, NOW);      // 剩余 96.7%
  const tool = makeOutcome('tool', 5, 4, NOW);         // 剩余 20%
  const token = makeOutcome('token', 30, 3, NOW);      // 剩余 90%
  assert.equal(tightestOutcome([agent, tool, token]).scope, 'tool');
  assert.equal(tightestOutcome([agent, token]).scope, 'token');
  assert.equal(tightestOutcome([]).scope, 'agent');    // 空数组安全回退
  const tie = makeOutcome('agent', 10, 9, NOW);        // 剩余 10%
  const tie2 = makeOutcome('tool', 10, 9, NOW);        // 剩余 10%，取先出现的
  assert.equal(tightestOutcome([tie, tie2]).scope, 'agent');
});
