// 主从批次打印纯函数单测
// 跑法：cd backend && node --test dist/src/udi/__tests__/udi.batchprint.calc.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BatchPrintError,
  buildCartonRow,
  buildSscc,
  buildUnitRows,
  nextSsccSerial,
  planSerials,
  serialSummary,
  assertSsccUsable,
  MAX_UNIT_QTY,
} from '../udi.batchprint.calc';

test('planSerials auto：从起始号连续展开，保留前缀与补零宽度', () => {
  const s = planSerials({ mode: 'auto', from: 'SN0001', count: 3 });
  assert.deepEqual(s, ['SN0001', 'SN0002', 'SN0003']);
});

test('planSerials auto：不带前缀的纯数字，宽度按起始号位数', () => {
  assert.deepEqual(planSerials({ mode: 'auto', from: '0100', count: 2 }), ['0100', '0101']);
});

test('planSerials auto：prefix 覆盖时拼在中间部分前面', () => {
  assert.deepEqual(planSerials({ mode: 'auto', from: '0001', prefix: 'A-', count: 2 }), ['A-0001', 'A-0002']);
});

test('planSerials auto：号段溢出直接报错，不静默进位', () => {
  assert.throws(() => planSerials({ mode: 'auto', from: '9998', count: 3 }), (e: any) => {
    assert.ok(e instanceof BatchPrintError);
    assert.match(e.message, /号段溢出/);
    return true;
  });
});

test('planSerials auto：起始号没有数字时报错', () => {
  assert.throws(() => planSerials({ mode: 'auto', from: 'SN', count: 2 }), /没有数字/);
});

test('planSerials auto：件数超过上限报错', () => {
  assert.throws(() => planSerials({ mode: 'auto', from: '0001', count: MAX_UNIT_QTY + 1 }), /上限/);
});

test('planSerials list：重复号拦住', () => {
  assert.throws(() => planSerials({ mode: 'list', list: ['A1', 'A1'] }), /重复/);
});

test('planSerials list：清单条数与件数不一致拦住', () => {
  assert.throws(() => planSerials({ mode: 'list', list: ['A1', 'A2'], count: 3 }), /不一致/);
});

test('planSerials list：原样返回且保序', () => {
  assert.deepEqual(planSerials({ mode: 'list', list: ['X2', 'X1'] }), ['X2', 'X1']);
});

test('serialSummary：单件只显示号，多件显示区间与件数', () => {
  assert.equal(serialSummary(['A1']), 'A1');
  assert.equal(serialSummary(['A1', 'A2', 'A3']), 'A1 ~ A3（3 件）');
  assert.equal(serialSummary([]), '');
});

test('buildUnitRows：每行序列号不同，其余字段相同；给出 GS1 与 ISO 两套日期', () => {
  const rows = buildUnitRows(['S1', 'S2'], {
    gtin14: '06901234567892', lot: 'L2601', expiryGs1: '281231', expiryIso: '2028-12-31', quantityInCarton: 2,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].serial, 'S1');
  assert.equal(rows[1].serial, 'S2');
  assert.equal(rows[0].gtin, '06901234567892');
  assert.equal(rows[0].lot, 'L2601');
  assert.equal(rows[0].expiry, '281231');
  assert.equal(rows[0].expiryDate, '2028-12-31');
  assert.equal(rows[0].qty, 2);
});

test('buildUnitRows：fieldMap 改列名后，模板变量名跟着变，标准名仍保留 serial', () => {
  const rows = buildUnitRows(['S1'], {
    gtin14: '06901234567892', lot: 'L1', expiryGs1: '', expiryIso: '', quantityInCarton: 1,
    fieldMap: { gtin: 'gtin_code', serial: 'sn' },
  });
  assert.equal(rows[0].gtin_code, '06901234567892');
  assert.equal(rows[0].sn, 'S1');
  assert.equal(rows[0].serial, 'S1');
});

test('buildCartonRow：带 SSCC、箱内件数、首末序列号', () => {
  const row = buildCartonRow({
    sscc: '069012340000000016', gtin14: '06901234567892', lot: 'L1', expiryGs1: '281231',
    expiryIso: '2028-12-31', qtyInBox: 10, serialFrom: 'S1', serialTo: 'S10',
  });
  assert.equal(row.sscc, '069012340000000016');
  assert.equal(row.qtyInBox, 10);
  assert.equal(row.serialFrom, 'S1');
  assert.equal(row.serialTo, 'S10');
  assert.equal(row.expiry, '281231');
});

test('nextSsccSerial：取同前缀流水最大值 +1，忽略异前缀与非法值', () => {
  const s1 = buildSscc('6901234', 100);
  const s2 = buildSscc('6901234', 250);
  const other = buildSscc('6909999', 900);
  assert.equal(nextSsccSerial([s1, s2, other, 'garbage'], '6901234'), 251);
});

test('nextSsccSerial：库里没有任何记录时从 1 开始', () => {
  assert.equal(nextSsccSerial([], '6901234'), 1);
});

test('assertSsccUsable：前缀不符/校验位错都拒绝', () => {
  const ok = buildSscc('6901234', 7);
  assert.equal(assertSsccUsable(ok, '6901234'), ok);
  assert.throws(() => assertSsccUsable(ok, '6909999'), /前缀/);
  assert.throws(() => assertSsccUsable('06901234000000001', '6901234'), /不合法/);
});
