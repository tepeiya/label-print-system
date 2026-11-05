// P4 纯函数单测：agent.calc（token/argsHash/scope）与 kit.calc（齐套率/缺料/escapeLike）
// 约束：不 import 实体类（tsx 无装饰器元数据），只测纯逻辑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_TOKEN_PREFIX, argsHash, defaultReadScopes, hashAgentToken, isExpired,
  isValidScope, looksLikeAgentToken, maskToken, newAgentToken, normalizeArgs, scopeCovers,
} from '../agent.calc';
import { computeKit, escapeLike, round3, shortageSummaryText } from '../../inventory/kit.calc';

// ---------------------------------------------------------------- agent.calc

test('newAgentToken: 前缀 + 40 hex，hash 为 64 位 sha256 且可复现', () => {
  const a = newAgentToken();
  assert.match(a.plain, /^lfagent_[0-9a-f]{40}$/);
  assert.equal(a.hash, hashAgentToken(a.plain));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(newAgentToken().plain, a.plain);   // 两次生成不撞车
});

test('looksLikeAgentToken: 只认 agent token 形态，租户 JWT / 乱码一律 false', () => {
  assert.equal(looksLikeAgentToken('lfagent_' + 'a'.repeat(40)), true);
  assert.equal(looksLikeAgentToken('lfagent_short'), false);
  assert.equal(looksLikeAgentToken('eyJhbGciOi.abc.def'), false);
  assert.equal(looksLikeAgentToken(null), false);
});

test('maskToken: 保留头 12 尾 4，中间省略', () => {
  const m = maskToken('lfagent_0123456789abcdef0123456789abcdef01234567');
  assert.ok(m.startsWith('lfagent_012'));
  assert.ok(m.endsWith('4567'));
  assert.ok(m.includes('…'));
});

test('normalizeArgs/argsHash: 键顺序无关，值不同则指纹不同', () => {
  assert.equal(argsHash({ a: 1, b: { c: 2, d: [3, 4] } }), argsHash({ b: { d: [3, 4], c: 2 }, a: 1 }));
  assert.notEqual(argsHash({ a: 1 }), argsHash({ a: 2 }));
  assert.equal(normalizeArgs(null), '{}');
});

test('isExpired: null 不过期；过去时间过期；非法值不误判', () => {
  const now = new Date('2026-11-05T00:00:00Z');
  assert.equal(isExpired(null, now), false);
  assert.equal(isExpired(new Date('2026-11-04T23:59:59Z'), now), true);
  assert.equal(isExpired('2026-12-01T00:00:00Z', now), false);
  assert.equal(isExpired('not-a-date', now), false);
});

test('scopeCovers: 精确 + 前缀通配（inventory:* 覆盖 inventory:stock:read）', () => {
  assert.equal(scopeCovers(['inventory:stock:read'], 'inventory:stock:read'), true);
  assert.equal(scopeCovers(['inventory:*'], 'inventory:stock:read'), true);
  assert.equal(scopeCovers(['inventory:stock:*'], 'inventory:stock:adjust'), true);
  assert.equal(scopeCovers(['inventory:stock:read'], 'inventory:stock:adjust'), false);
  assert.equal(scopeCovers([], 'template:read'), false);
  assert.equal(scopeCovers(['*'], 'anything:goes'), true);
});

test('isValidScope: 权限点形态；大写/空格/超长拒绝', () => {
  assert.equal(isValidScope('template:read'), true);
  assert.equal(isValidScope('inventory:stock:adjust'), true);
  assert.equal(isValidScope('Template:read'), false);
  assert.equal(isValidScope('a b'), false);
  assert.equal(isValidScope(''), false);
  assert.equal(isValidScope('x:' + 'y'.repeat(70)), false);
});

test('defaultReadScopes: 恰为 P4 只读集合，不含任何 adjust/transfer/write 码', () => {
  const s = defaultReadScopes();
  assert.deepEqual(new Set(s), new Set([
    'template:read', 'inventory:stock:read', 'inventory:batch:read', 'bom:kit:read', 'bom:shortage:read',
  ]));
  assert.ok(s.every((x) => !/adjust|transfer|write/.test(x)));
  assert.equal(AGENT_TOKEN_PREFIX, 'lfagent_');
});

// ---------------------------------------------------------------- kit.calc

const line = (over: Record<string, unknown> = {}) => ({
  materialId: 1, code: 'M-A', name: '有机苹果', unit: 'kg',
  qtyPer: 5, lossRate: 0.05, available: 320, ...over,
});

test('computeKit: 演示口径 苹果320kg/盒60个 → 需求100 齐套率60%，缺料两行', () => {
  const kit = computeKit([
    line(),
    line({ materialId: 3, code: 'M-BOX', name: '礼盒包装盒', unit: '个', qtyPer: 1, lossRate: 0, available: 60 }),
  ], 100);
  assert.equal(kit.kitRate, 60);
  assert.equal(kit.maxSets, 60);
  assert.equal(kit.shortages.length, 2);
  const apple = kit.lines.find((l) => l.code === 'M-A')!;
  assert.equal(apple.needed, 525);
  assert.equal(apple.shortage, 205);
});

test('computeKit: 库存充足 → 100%，maxSets 封顶到需求量', () => {
  const kit = computeKit([line({ available: 10000 })], 50);
  assert.equal(kit.kitRate, 100);
  assert.equal(kit.maxSets, 50);           // 10000/5.25=1904 但分母是需求
  assert.deepEqual(kit.shortages, []);
});

test('computeKit: 零库存 → 0% 全缺（无数据友好路径的算法层保证）', () => {
  const kit = computeKit([line({ available: 0 }), line({ materialId: 2, code: 'M-B', available: 0, qtyPer: 1 })], 10);
  assert.equal(kit.kitRate, 0);
  assert.equal(kit.maxSets, 0);
  assert.equal(kit.shortages.length, 2);
});

test('computeKit: 无 BOM 行 → maxSets 0 / kitRate 0（空数组不是 NaN）', () => {
  const kit = computeKit([], 100);
  assert.equal(kit.maxSets, 0);
  assert.equal(kit.kitRate, 0);
  assert.deepEqual(kit.lines, []);
});

test('computeKit: 浮点临界不吞套（5.25×60=314.9999… 应可配 60 套）', () => {
  const kit = computeKit([line({ available: 315 })], 60);
  assert.equal(kit.maxSets, 60);
  assert.equal(kit.kitRate, 100);
});

test('computeKit: 不耗料行（qtyPer=0）不拖低齐套率', () => {
  const kit = computeKit([
    line({ qtyPer: 0, lossRate: 0, materialId: 9, code: 'M-DOC' }),
    line({ available: 525 }),
  ], 100);
  assert.equal(kit.maxSets, 100);
  assert.equal(kit.kitRate, 100);
});

test('computeKit: demand<=0 / NaN 直接抛错', () => {
  assert.throws(() => computeKit([line()], 0), /demand/);
  assert.throws(() => computeKit([line()], NaN), /demand/);
});

test('shortageSummaryText: 带缺料行与前 3 项；无缺料返回 null', () => {
  const kit = computeKit([
    line(), line({ materialId: 2, code: 'M-B', name: '雪梨', available: 0 }),
    line({ materialId: 3, code: 'M-C', name: '礼盒', available: 0 }),
    line({ materialId: 4, code: 'M-D', name: '标签', available: 0 }),
  ], 100);
  const t = shortageSummaryText('苹果礼盒', kit)!;
  assert.ok(t.includes('苹果礼盒'));
  assert.ok(t.includes('等 4 项'));
  assert.equal(shortageSummaryText('x', computeKit([line({ available: 9999 })], 10)), null);
});

test('escapeLike: % _ 反斜杠前置转义；普通串原样', () => {
  assert.equal(escapeLike('100%_a\\b'), '100\\%\\_a\\\\b');
  assert.equal(escapeLike('有机苹果'), '有机苹果');
  assert.equal(escapeLike(null), '');
});

test('round3: 三位小数四舍五入', () => {
  assert.equal(round3(1.0005), 1.001);
  assert.equal(round3(2.1234), 2.123);
  assert.equal(round3(525), 525);
});
