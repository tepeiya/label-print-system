// 第三层：HIBC / PZN 专用校验位单测（对照官方规范样例）
import test from 'node:test';
import assert from 'node:assert/strict';
import { hibcCheck, verifyHibc, pznCheckDigit, buildPzn, verifyPzn } from '../industrial-checksum';
import { checksum } from '../checksum';

// ------------------------------ HIBC Modulo 43 ------------------------------
test('HIBC 官方样例：+A123BJC5D6E71 → 校验 G（求和 145 mod 43 = 16）', () => {
  const r = hibcCheck('+A123BJC5D6E71');
  assert.equal(r.ok, true);
  assert.equal(r.sum, 145);
  assert.equal(r.checkChar, 'G');
  assert.equal(r.data, '+A123BJC5D6E71G');
});

test('HIBC：省略前导 + 自动补齐', () => {
  const a = hibcCheck('A123BJC5D6E71');
  const b = hibcCheck('+A123BJC5D6E71');
  assert.equal(a.checkChar, b.checkChar);
  assert.ok(a.data.startsWith('+'));
});

test('HIBC：校验字符映射覆盖 - . 空格 $ / + %', () => {
  // 支持字符集：数字 字母 - . 空格 $ / + %
  assert.equal(hibcCheck('ABC-').ok, true);
  assert.equal(hibcCheck('A.B').ok, true);
  assert.equal(hibcCheck('A B').ok, true);
  assert.equal(hibcCheck('A$B').ok, true);
  assert.equal(hibcCheck('A/B').ok, true);
  assert.equal(hibcCheck('A+B').ok, true);
  assert.equal(hibcCheck('A%B').ok, true);
  // 小写与非法字符拒绝
  assert.equal(hibcCheck('abc').ok, false);
  assert.equal(hibcCheck('A@B').ok, false);
});

test('HIBC：verifyHibc 末位重算比对', () => {
  assert.equal(verifyHibc('+A123BJC5D6E71G'), true);
  assert.equal(verifyHibc('+A123BJC5D6E71X'), false);
  assert.equal(verifyHibc(''), false);
});

// ------------------------------ PZN Modulo 11 ------------------------------
test('PZN 官方样例：基础 1234567 → 校验 8（140 mod 11 = 8）', () => {
  const r = pznCheckDigit('1234567');
  assert.equal(r.ok, true);
  assert.equal(r.checkDigit, '8');
  assert.equal(buildPzn('1234567').pzn, '12345678');
});

test('PZN 官方样例：基础 2758089 → 校验 9（174 mod 11 = 9）', () => {
  assert.equal(buildPzn('2758089').pzn, '27580899');
});

test('PZN7：6 位基础前补 0，校验位不变', () => {
  // 123456（6位）与 0123456（7位）校验位相同
  assert.equal(pznCheckDigit('123456').checkDigit, pznCheckDigit('0123456').checkDigit);
  // 官方例子：1234562 校验位在 01234562 中不变（0×1+1×2+…+6×7=112，112 mod 11=2）
  assert.equal(buildPzn('123456').pzn, '01234562');
});

test('PZN：余数 10 的号段不发放', () => {
  // 找一个 mod 11 = 10 的基础串：权重和 = 21 → 例如 0000003（第7位 3×7=21）
  const r = pznCheckDigit('0000003');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /10/);
});

test('PZN：长度/字符集校验与 verifyPzn', () => {
  assert.equal(pznCheckDigit('12345').ok, false, '5 位不足');
  assert.equal(pznCheckDigit('12345678').ok, false, '8 位是完整 PZN 非基础');
  assert.equal(pznCheckDigit('12345A').ok, false);
  assert.equal(verifyPzn('12345678'), true);
  assert.equal(verifyPzn('12345679'), false);
  assert.equal(verifyPzn('1234567'), false, '7 位不是完整 PZN8');
});

// ------------------------------ CHECKSUM 分发单一真源 ------------------------------
test('checksum 分发：HIBC / PZN 走工业校验', () => {
  assert.equal(checksum('HIBC', '+A123BJC5D6E71'), 'G');
  assert.equal(checksum('MOD43_HIBC', 'A123BJC5D6E71'), 'G');
  assert.equal(checksum('PZN', '1234567'), '8');
  assert.equal(checksum('MOD11_PZN', '2758089'), '9');
  assert.throws(() => checksum('PZN', '0000003'), /10/);
});
