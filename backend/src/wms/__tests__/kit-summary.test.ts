// 工单齐套汇总纯函数单测（node:test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKit } from '../../inventory/kit.calc';
import { summarizeWoKit, lineShortageText } from '../issuing/services/kit-summary.calc';

const L = (code: string, qtyPer: number, lossRate: number, available: number) =>
  ({ materialId: Number(code.replace(/\D/g, '')) || 1, code, name: `物料${code}`, unit: '个', qtyPer, lossRate, available });

test('整体可配套数取各行最小值', () => {
  const kit = computeKit([L('A1', 2, 0, 100), L('B2', 5, 0, 40), L('C3', 1, 0, 30)], 10);
  const s = summarizeWoKit(kit, 10, '产品X');
  // A:100/2=50, B:40/5=8, C:30/1=30 → 8
  assert.equal(s.overallMaxSets, 8);
  assert.equal(s.overallKitRate, 80);
});

test('损耗率计入需求（D4）：qtyPer×(1+lossRate) 决定可配套数', () => {
  const kit = computeKit([L('A1', 1, 0.1, 105)], 100);
  assert.equal(kit.lines[0].needed, 110);
  const s = summarizeWoKit(kit, 100, 'P');
  // 可用 105 / 单位需求 1.1 = 95.45 → 95 套；需求 110 缺 5
  assert.equal(s.overallMaxSets, 95);
  assert.equal(s.overallKitRate, 95);
});

test('齐套率向下取整到两位，且不超过 100', () => {
  const kit = computeKit([L('A1', 3, 0, 10)], 3);
  // 10/3=3.33→3 套，需求 3 → 100%
  const s = summarizeWoKit(kit, 3, 'P');
  assert.equal(s.overallKitRate, 100);
  const kit2 = computeKit([L('A1', 1, 0, 1)], 3);
  const s2 = summarizeWoKit(kit2, 3, 'P');
  assert.equal(s2.overallMaxSets, 1);
  assert.equal(s2.overallKitRate, 33.33);
});

test('无行：0 套 0%，摘要给明确提示而不是报错', () => {
  const kit = computeKit([], 5);
  const s = summarizeWoKit(kit, 5, 'P');
  assert.equal(s.overallMaxSets, 0);
  assert.equal(s.overallKitRate, 0);
  assert.equal(s.shortageLines.length, 0);
  assert.match(s.summaryText!, /未找到可用的 BOM 明细行/);
});

test('全行不耗料（qtyPer=0）视为可全配', () => {
  const kit = computeKit([L('A1', 0, 0, 0)], 7);
  const s = summarizeWoKit(kit, 7, 'P');
  assert.equal(s.overallMaxSets, 7);
  assert.equal(s.overallKitRate, 100);
});

test('缺料行汇总与摘要文本（取前 3 项）', () => {
  const kit = computeKit([
    L('A1', 1, 0, 5), L('B2', 1, 0, 0), L('C3', 1, 0, 1), L('D4', 1, 0, 2),
  ], 10);
  const s = summarizeWoKit(kit, 10, '产品X');
  assert.equal(s.shortageLines.length, 4);
  assert.match(s.summaryText!, /产品X/);
  assert.match(s.summaryText!, /等 4 项/);
  assert.match(s.summaryText!, /可配套 0/);
});

test('demand 非正数直接抛错（不静默算 0）', () => {
  const kit = computeKit([], 1);
  assert.throws(() => summarizeWoKit(kit, 0, 'P'), /demand/);
});

test('行缺料文案含行号、可用与需求', () => {
  const t = lineShortageText({ lineNo: 3, name: '钢珠', unit: '个', required: 30, available: 12, shortage: 18 });
  assert.equal(t, '第3行 钢珠：可用 12个 < 需求 30个，缺 18个');
});
