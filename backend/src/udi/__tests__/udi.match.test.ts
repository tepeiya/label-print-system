// 物料 GTIN × 扫码 GTIN 比对单测（U5.1）：录入归一、比对、必扫校验、总入口优先级
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMaterialGtin, matchMaterialGtin, matchMaterialGtins, checkUdiRequired, judgeScanGtin,
  matchPack, convertToUnits,
} from '../udi.match.calc';

const GTIN14 = '06901234567892';
const GTIN13 = '6901234567892';
const GTIN12 = '690123456785';  // 12 位：口径不支持，应拒绝

test('录入归一：13 位补零成 14 位且校验位正确', () => {
  const r = normalizeMaterialGtin(GTIN13);
  assert.equal(r.ok, true);
  assert.equal(r.gtin14, GTIN14);
});

test('录入归一：12 位拒绝（8/12 位奇偶口径与 GTIN14 不一致）', () => {
  const r = normalizeMaterialGtin(GTIN12);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /13 或 14 位/);
});

test('录入归一：空值视为不比对，不报错', () => {
  const r = normalizeMaterialGtin('');
  assert.equal(r.ok, true);
  assert.equal(r.gtin14, undefined);
});

test('录入归一：校验位错 / 位数不对都拒绝', () => {
  assert.equal(normalizeMaterialGtin('6901234567893').ok, false);
  assert.equal(normalizeMaterialGtin('12345').ok, false);
});

test('比对：物料未登记 GTIN → 跳过（不误拦未赋码物料）', () => {
  const m = matchMaterialGtin(null, GTIN14);
  assert.equal(m.ok, true);
  assert.equal(m.skipped, true);
});

test('比对：一致通过；不一致给出"疑似扫错料"', () => {
  assert.equal(matchMaterialGtin(GTIN13, GTIN14).ok, true);
  const bad = matchMaterialGtin(GTIN14, '06901234567908');
  assert.equal(bad.ok, false);
  assert.match(bad.reason!, /疑似扫错料/);
});

test('比对：扫到的码没有 GTIN 时不放行', () => {
  const bad = matchMaterialGtin(GTIN14, null);
  assert.equal(bad.ok, false);
  assert.match(bad.reason!, /没有 GTIN/);
});

test('必扫：udi_required 且无码 → 拒绝；有码 → 通过', () => {
  assert.equal(checkUdiRequired(true, false).ok, false);
  assert.equal(checkUdiRequired(true, true).ok, true);
  assert.equal(checkUdiRequired(false, false).ok, true);
});

test('总入口：先判"没码"再判"码不对"', () => {
  const noCode = judgeScanGtin({ materialGtin: GTIN14, udiRequired: true, hasCode: false });
  assert.equal(noCode.ok, false);
  assert.match(noCode.reason!, /未扫到码/);

  const wrong = judgeScanGtin({ materialGtin: GTIN14, udiRequired: true, hasCode: true, codeGtin: '06901234567908' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason!, /GTIN 不符/);
});

test('总入口：force 放行（保留审计由服务层写）', () => {
  const r = judgeScanGtin({ materialGtin: GTIN14, udiRequired: true, hasCode: false, force: true });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});


// ---------------------------------------------------------------- U5.2 多 GTIN
const GTIN_CARTON = '06901234567908';

test('多码：扫到列表中任意一个（含中包码）都算对', () => {
  const m = matchMaterialGtins([GTIN14, GTIN_CARTON], GTIN_CARTON);
  assert.equal(m.ok, true);
  assert.equal(m.skipped, false);
});

test('多码：都不匹配 → 报错并列出物料全部码', () => {
  const m = matchMaterialGtins([GTIN14, GTIN_CARTON], '06901234567000');
  assert.equal(m.ok, false);
  assert.match(m.reason!, /疑似扫错料/);
  assert.match(m.reason!, new RegExp(GTIN14));
});

test('多码：空列表 → 跳过；全脏数据 → 拒绝', () => {
  assert.equal(matchMaterialGtins([], GTIN14).skipped, true);
  assert.equal(matchMaterialGtins([null, ''], GTIN14).skipped, true);
  const bad = matchMaterialGtins(['123', 'abc'], GTIN14);
  assert.equal(bad.ok, false);
  assert.match(bad.reason!, /全部非法/);
});

test('多码：13 位与 14 位混存也能对上（归一后比较）', () => {
  assert.equal(matchMaterialGtins([GTIN13], GTIN14).ok, true);
});

test('总入口：给了多码列表就优先按整组匹配', () => {
  const r = judgeScanGtin({
    materialGtin: '06901234567000', materialGtins: [GTIN14, GTIN_CARTON],
    udiRequired: true, hasCode: true, codeGtin: GTIN_CARTON,
  });
  assert.equal(r.ok, true);
});


test('折箱：扫中包码命中包装行并带级别与每包件数', () => {
  const rows = [
    { gtin: GTIN14, packLevel: 'UNIT', packQty: 1 },
    { gtin: GTIN_CARTON, packLevel: 'CARTON', packQty: 24 },
  ];
  const m = matchPack(rows, GTIN_CARTON);
  assert.ok(m);
  assert.equal(m!.packLevel, 'CARTON');
  assert.equal(m!.packQty, 24);
});

test('折箱：未命中返回 null；空列表安全返回 null', () => {
  assert.equal(matchPack([], GTIN_CARTON), null);
  assert.equal(matchPack(null, GTIN14), null);
  assert.equal(matchPack([{ gtin: GTIN14, packLevel: 'UNIT', packQty: 1 }], GTIN_CARTON), null);
});

test('折箱：中包 N 包 × 每包件数折单品，UNIT 级不折算', () => {
  assert.equal(convertToUnits(2, 24, 'CARTON'), 48);
  assert.equal(convertToUnits(1, 24, 'PALLET'), 24);
  assert.equal(convertToUnits(5, 24, 'UNIT'), 5);
  assert.equal(convertToUnits(3, 10), 3);
});

test('折箱：小数包数按三舍四入到三位', () => {
  assert.equal(convertToUnits(1.5, 10, 'CARTON'), 15);
  assert.equal(convertToUnits(2, 0.5, 'CARTON'), 1);
  assert.equal(convertToUnits(1.25, 8, 'CARTON'), 10);
});
