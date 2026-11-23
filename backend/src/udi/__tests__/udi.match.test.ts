// 物料 GTIN × 扫码 GTIN 比对单测（U5.1）：录入归一、比对、必扫校验、总入口优先级
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMaterialGtin, matchMaterialGtin, checkUdiRequired, judgeScanGtin,
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
