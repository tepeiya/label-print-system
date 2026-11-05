// P5 纯函数单测：rate.calc（§11.7.7 护栏 5：Agent 维度 60 次/分 + 单次批量 ≤500）
// 约束：不 import 实体类、不连 Redis；AgentRateService 的 Redis 交互靠验收脚本实测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_MAX, DEFAULT_AGENT_RPM, RPM_MAX, RPM_MIN, WINDOW_MS,
  batchOverLimit, isLimited, rateLimitKey, rateLimitTtlMs, remaining, resolveRpm,
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
