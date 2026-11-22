// 上架推荐规则单测（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendLocation } from '../inbound/services/putaway-recommend.calc';

const locs = [
  { id: 1, code: 'A-01', zone: 'FAST', utilization: 0.9, sortKey: 10 },
  { id: 2, code: 'A-02', zone: 'FAST', utilization: 0.3, sortKey: 20 },
  { id: 3, code: 'B-01', zone: 'SLOW', utilization: 0.1, sortKey: 5 },
];

test('规则匹配：priority 小者优先，按 zone 命中后按利用率选位', () => {
  const res = recommendLocation({
    rules: [{
      id: 7, priority: 10, enabled: true,
      conditionJson: { zone: 'FAST', maxUtilization: 0.5 },
      actionJson: { sortBy: 'UTILIZATION' },
    }],
    locations: locs,
    material: { abc: 'A', code: 'MAT-001' },
  });
  assert.equal(res.locationId, 2, 'FAST 区且利用率<0.5 的只有 A-02');
  assert.equal(res.locationCode, 'A-02');
  assert.match(res.reason, /命中上架规则#7/);
  assert.equal(res.ruleId, 7);
});

test('规则匹配：abc 条件不符则跳到下一规则', () => {
  const res = recommendLocation({
    rules: [
      { id: 1, priority: 1, enabled: true, conditionJson: { abc: 'A', zoneCode: 'FAST' }, actionJson: {} },
      { id: 2, priority: 2, enabled: true, conditionJson: { abc: 'C' }, actionJson: { sortBy: 'DISTANCE' } },
    ],
    locations: locs,
    material: { abc: 'C', code: 'MAT-002' },
  });
  assert.equal(res.ruleId, 2);
  assert.equal(res.locationId, 3, 'sortBy=DISTANCE 且全部命中时选 sortKey 最小的 B-01');
});

test('无规则命中：兜底选利用率最低的库位', () => {
  const res = recommendLocation({
    rules: [{ id: 1, priority: 1, enabled: true, conditionJson: { zone: 'NONE' }, actionJson: {} }],
    locations: locs,
  });
  assert.equal(res.locationId, 3);
  assert.match(res.reason, /兜底选最空库位/);
});

test('禁用规则不参与匹配', () => {
  const res = recommendLocation({
    rules: [{ id: 1, priority: 1, enabled: false, conditionJson: { zone: 'FAST' }, actionJson: {} }],
    locations: locs,
  });
  assert.match(res.reason, /兜底/);
});

test('无可用库位：返回 null 且原因明确（杜绝无库位库存）', () => {
  const res = recommendLocation({ rules: [], locations: [] });
  assert.equal(res.locationId, null);
  assert.match(res.reason, /无可用库位/);
});
