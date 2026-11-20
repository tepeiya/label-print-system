// 齐套率纯函数测试（§11.7.2）：口径、容差、边界、缺料摘要。零 Nest/TypeORM 依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKit, round3, escapeLike, shortageSummaryText, BomLineInput } from '../kit.calc';

const line = (over: Partial<BomLineInput> = {}): BomLineInput => ({
  materialId: 1, code: 'M001', name: '主板', unit: 'pcs', qtyPer: 1, lossRate: 0, available: 0, ...over,
});

test('round3 规避浮点长尾', () => {
  assert.equal(round3(0.1 + 0.2), 0.3);
  assert.equal(round3(1.23456), 1.235);
});

test('escapeLike 转义 % _ 与反斜杠', () => {
  assert.equal(escapeLike('A%_\\B'), 'A\\%\\_\\\\B');
});

test('齐套率口径：可配套数取瓶颈行下限，齐套率向下取整防虚报', () => {
  const kit = computeKit([
    line({ materialId: 1, qtyPer: 2, available: 20 }), // 能配 10 套
    line({ materialId: 2, qtyPer: 1, available: 7 }),  // 瓶颈：7 套
  ], 10);
  assert.equal(kit.maxSets, 7);
  assert.equal(kit.kitRate, 70);
  assert.equal(kit.demand, 10);
  assert.equal(kit.shortages.length, 1); // 只有第 2 行缺料
  assert.equal(kit.shortages[0].shortage, 3);
});

test('浮点容差：5.25×60=314.9999… 应算满 60 套，不误报缺料', () => {
  const kit = computeKit([line({ qtyPer: 5.25, available: 315 })], 60);
  assert.equal(kit.kitRate, 100);
  assert.equal(kit.maxSets, 60);
  assert.equal(kit.shortages.length, 0);
});

test('损耗率计入单件净需求', () => {
  const kit = computeKit([line({ qtyPer: 1, lossRate: 0.05, available: 105 })], 100);
  assert.equal(kit.maxSets, 100); // 1.05/件 × 100 = 105，正好
  assert.equal(kit.kitRate, 100);
  const short = computeKit([line({ qtyPer: 1, lossRate: 0.05, available: 104 })], 100);
  assert.ok(short.shortages.length > 0);
  assert.equal(short.shortages[0].shortage, 1);
});

test('零行 / 不耗料行：空 BOM 按 0；全不耗料视为可全配', () => {
  const empty = computeKit([], 10);
  assert.equal(empty.kitRate, 0);
  assert.equal(empty.maxSets, 0);
  assert.equal(empty.shortages.length, 0);

  const noConsume = computeKit([line({ qtyPer: 0, available: 0 })], 10);
  assert.equal(noConsume.kitRate, 100);
  assert.equal(noConsume.maxSets, 10);
});

test('齐套率上限 100：库存超出需求不虚报配套数', () => {
  const kit = computeKit([line({ qtyPer: 1, available: 1000 })], 10);
  assert.equal(kit.kitRate, 100);
  assert.equal(kit.maxSets, 10);
});

test('负数/非数字需求被拒绝', () => {
  assert.throws(() => computeKit([], 0), /demand/);
  assert.throws(() => computeKit([], -3), /demand/);
  assert.throws(() => computeKit([], NaN), /demand/);
});

test('缺料友好摘要：无缺料为 null，多缺料带 Top3 与总数', () => {
  assert.equal(shortageSummaryText('产品A', computeKit([line({ available: 100 })], 10)), null);
  const kit = computeKit([
    line({ name: '主板', available: 0 }),
    line({ materialId: 2, name: '芯片', available: 0 }),
    line({ materialId: 3, name: '外壳', available: 0 }),
    line({ materialId: 4, name: '螺丝', available: 0 }),
  ], 10);
  const text = shortageSummaryText('产品A', kit)!;
  assert.ok(text.includes('产品A'));
  assert.ok(text.includes('主板'));
  assert.ok(text.includes('等 4 项'));
  assert.ok(text.includes('齐套率'));
});
