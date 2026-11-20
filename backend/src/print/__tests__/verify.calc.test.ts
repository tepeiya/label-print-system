// 第三层：打印后解码验证判定层单测（纯函数，无 WASM）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDecoded, editDistance, compareDecoded, verdictOf,
  symFormatFamily, zxingFormatFamily,
} from '../verify.calc';

test('normalizeDecoded：剥离 GS1 symbology 前缀、FNC1 控制字符与空白', () => {
  assert.equal(normalizeDecoded(']C112345678901231'), '12345678901231');
  assert.equal(normalizeDecoded(']d2ABC123'), 'ABC123');
  assert.equal(normalizeDecoded(']C1ABC\u001D123'), 'ABC123');
  assert.equal(normalizeDecoded('  HELLO-123  '), 'HELLO-123');
  assert.equal(normalizeDecoded('AbC', { ignoreCase: true }), 'abc');
  assert.equal(normalizeDecoded(']e0\u001EHELLO'), 'HELLO');
});

test('editDistance / similarity：经典用例', () => {
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(compareDecoded('abc', 'abd', 'CODE128').score, 67);
});

test('compareDecoded：exact / normalized / none 三级判定', () => {
  const exact = compareDecoded('HELLO-123', 'HELLO-123', 'CODE128');
  assert.equal(exact.match, true);
  assert.equal(exact.grade, 'exact');
  assert.equal(exact.score, 100);

  const norm = compareDecoded('12345678901231', ']C112345678901231', 'GS1_128');
  assert.equal(norm.match, true);
  assert.equal(norm.grade, 'normalized');
  assert.equal(norm.score, 80);

  const caseInsensitive = compareDecoded('hello', 'HELLO', 'CODE39');
  assert.equal(caseInsensitive.match, true);
  assert.equal(caseInsensitive.grade, 'normalized');

  const bad = compareDecoded('HELLO-123', 'HELLO-999', 'CODE128');
  assert.equal(bad.match, false);
  assert.equal(bad.grade, 'none');
  assert.ok(bad.score < 100);
});

test('verdictOf：无候选明确失败并给排查提示', () => {
  const v = verdictOf([], 'ABC', 'CODE128');
  assert.equal(v.match, false);
  assert.equal(v.hitCount, 0);
  assert.equal(v.formatOk, false);
  assert.match(v.notes.join(' '), /解码无结果/);
});

test('verdictOf：多候选取最匹配者，格式族校验', () => {
  const v = verdictOf([
    { text: 'HELLO-999', format: 'Code39' },
    { text: 'HELLO-123', format: 'Code128' },
  ], 'HELLO-123', 'CODE128');
  assert.equal(v.match, true);
  assert.equal(v.decoded, 'HELLO-123');
  assert.equal(v.hitCount, 2);
  assert.equal(v.formatOk, true);
  assert.match(v.notes.join(' '), /识别到 2 个码/);
});

test('verdictOf：格式族不符给 note 但不直接判失败', () => {
  const v = verdictOf([{ text: 'ABC', format: 'Code39' }], 'ABC', 'QRCODE');
  assert.equal(v.match, true, '文本一致仍判成功');
  assert.equal(v.formatOk, false);
  assert.match(v.notes.join(' '), /QR/);
});

test('symFormatFamily / zxingFormatFamily：码制族映射一致', () => {
  assert.equal(symFormatFamily('QRCODE'), 'QR');
  assert.equal(zxingFormatFamily('QRCode'), 'QR');
  assert.equal(symFormatFamily('GS1_128'), 'GS1');
  assert.equal(symFormatFamily('CODE128'), 'CODE128');
  assert.equal(zxingFormatFamily('Code128'), 'CODE128');
  assert.equal(symFormatFamily('DATAMATRIX_RECT'), 'DATAMATRIX');
  assert.equal(zxingFormatFamily('Data Matrix'), 'DATAMATRIX');
  assert.equal(symFormatFamily('MAXICODE'), 'MAXICODE');
});
