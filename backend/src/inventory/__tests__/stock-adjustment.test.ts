/**
 * 库存调整单纯函数单测（2026-11-25）
 * 覆盖两条最容易出错的口径：
 *   1) 类型与方向一致性 —— 拿「盘亏」当借口加库存是最常见的仓库事故；
 *   2) 单号格式与补零 —— SA-YYYYMMDD-NNNN，日期取本地时区。
 * 不碰数据库：服务层依赖的仓储查询另有真实 API 验收（见 docs/34）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDirection, formatAdjustNo, nextDocStatus, ADJUST_TYPE_TEXT } from '../stock-adjustment.calc';

test('盘盈 / 退货入库 只能增加库存', () => {
  assert.equal(assertDirection('GAIN', 5, 1), undefined);
  assert.equal(assertDirection('RETURN', 1.5, 2), undefined);
  assert.throws(() => assertDirection('GAIN', -5, 1), /只能增加库存/);
  assert.throws(() => assertDirection('RETURN', -0.5, 3), /只能增加库存/);
});

test('盘亏 / 报废 只能减少库存', () => {
  assert.equal(assertDirection('LOSS', -3, 1), undefined);
  assert.equal(assertDirection('DAMAGE', -12, 2), undefined);
  assert.throws(() => assertDirection('LOSS', 3, 1), /只能减少库存/);
  assert.throws(() => assertDirection('DAMAGE', 0.1, 2), /只能减少库存/);
});

test('其他调整 方向不限（正负都可以，原因里写清楚业务）', () => {
  assert.equal(assertDirection('OTHER', 7, 1), undefined);
  assert.equal(assertDirection('OTHER', -7, 1), undefined);
});

test('报错信息带行号，现场能定位到具体行', () => {
  try { assertDirection('LOSS', 2, 4); assert.fail('应当抛错'); }
  catch (e: any) { assert.match(e.message, /第 4 行/); }
});

test('五种调整类型都有中文名（前端靠它显示，漏一个会露出英文枚举）', () => {
  for (const t of ['GAIN', 'LOSS', 'DAMAGE', 'RETURN', 'OTHER'] as const) {
    assert.ok(ADJUST_TYPE_TEXT[t], `缺少 ${t} 的中文名`);
  }
});

test('单号格式 SA-YYYYMMDD-NNNN，序号补到 4 位', () => {
  assert.equal(formatAdjustNo(new Date(2026, 10, 25), 1), 'SA-20261125-0001');
  assert.equal(formatAdjustNo(new Date(2026, 10, 25), 42), 'SA-20261125-0042');
  assert.equal(formatAdjustNo(new Date(2026, 0, 9), 7), 'SA-20260109-0007');
  assert.equal(formatAdjustNo(new Date(2026, 10, 25), 1000), 'SA-20261125-1000');
});

test('单据状态收敛：全 DONE 才 POSTED，否则 PARTIAL', () => {
  assert.equal(nextDocStatus(['DONE', 'DONE']), 'POSTED');
  assert.equal(nextDocStatus(['DONE', 'FAILED']), 'PARTIAL');
  assert.equal(nextDocStatus(['PENDING']), 'PARTIAL');
  assert.equal(nextDocStatus([]), 'PARTIAL');
});

test('单号日期段长度固定 8 位（截取 slice(3,11) 依赖这一点）', () => {
  const no = formatAdjustNo(new Date(2026, 0, 1), 1);
  assert.match(no, /^SA-\d{8}-\d{4}$/);
  assert.equal(no.slice(3, 11), '20260101');
});
