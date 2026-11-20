// 第三层：打印后解码验证闭环单测（真实 bwip 渲染 → zxing-wasm 解码）
// 注意：zxing-wasm 首次初始化约 20s（进程内一次），全量 npm test 会包含本文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAndDecode, decodeBarcodeImage, zxingFormatsFor } from '../verify.service';
import { verdictOf } from '../verify.calc';
import bwipjs from '@bwip-js/node';

test('zxingFormatsFor：各码制映射到精确 zxing 格式（避免 All 慢扫描）', () => {
  assert.deepEqual(zxingFormatsFor('CODE128'), ['Code128']);
  assert.deepEqual(zxingFormatsFor('QRCODE'), ['QRCode']);
  assert.deepEqual(zxingFormatsFor('DATAMATRIX'), ['DataMatrix']);
  assert.deepEqual(zxingFormatsFor('EAN13'), ['EAN13']);
  assert.deepEqual(zxingFormatsFor('MAXICODE'), ['MaxiCode']);
  assert.deepEqual(zxingFormatsFor('PZN'), ['PZN']);
  assert.ok(zxingFormatsFor('UNKNOWN_SYM').length > 1, '未知码制回退到格式候选集');
});

test('闭环：CODE128 渲染→解码→判定 exact', async () => {
  const rt = await renderAndDecode('LF-C128-0042', 'CODE128');
  assert.ok(rt.candidates.length >= 1, '应解出至少一个码');
  const v = verdictOf(rt.candidates, 'LF-C128-0042', 'CODE128');
  assert.equal(v.match, true, `期望一致，实际解码 ${rt.candidates.map((c) => c.text).join('/')}`);
  assert.equal(v.grade, 'exact');
  assert.ok(rt.pngBase64.length > 100, '应返回 PNG 供留档');
});

test('闭环：QRCODE 渲染→解码→判定 exact', async () => {
  const rt = await renderAndDecode('https://labelflow.example/t/ABC-123', 'QRCODE');
  assert.ok(rt.candidates.length >= 1);
  const v = verdictOf(rt.candidates, 'https://labelflow.example/t/ABC-123', 'QRCODE');
  assert.equal(v.match, true, `实际解码 ${rt.candidates.map((c) => c.text).join('/')}`);
});

test('闭环：DATAMATRIX 渲染→解码→判定', async () => {
  const rt = await renderAndDecode('DM-12345', 'DATAMATRIX');
  assert.ok(rt.candidates.length >= 1, 'DataMatrix 应可解');
  const v = verdictOf(rt.candidates, 'DM-12345', 'DATAMATRIX');
  assert.equal(v.match, true, `实际解码 ${rt.candidates.map((c) => c.text).join('/')}`);
});

test('闭环：EAN13（带校验位）渲染→解码→判定', async () => {
  // 690123456789 校验位为 2 → 6901234567892
  const rt = await renderAndDecode('6901234567892', 'EAN13');
  assert.ok(rt.candidates.length >= 1, 'EAN13 应可解');
  const v = verdictOf(rt.candidates, '6901234567892', 'EAN13');
  assert.equal(v.match, true, `实际解码 ${rt.candidates.map((c) => c.text).join('/')}`);
});

test('decodeBarcodeImage：篡改期望内容应判失败（负向用例）', async () => {
  const png = await bwipjs.toBuffer({ bcid: 'code128', text: 'ORIGINAL', scale: 3, height: 10, includetext: false, padding: 10 } as any);
  const candidates = await decodeBarcodeImage(png, 'CODE128');
  const v = verdictOf(candidates, 'TAMPERED', 'CODE128');
  assert.equal(v.match, false, '内容不符必须失败');
  assert.equal(v.hitCount, candidates.length);
});

test('闭环：GS1-128 解码文本含 FNC1/AI 时归一化后可比对', async () => {
  const rt = await renderAndDecode('(01)12345678901231(17)251231', 'GS1_128');
  assert.ok(rt.candidates.length >= 1);
  // GS1 解码可能带 ]d2/~1/AI 括号等，判定层做归一化；这里只要求解出码且包含核心数字
  const joined = rt.candidates.map((c) => c.text).join(' ');
  assert.match(joined, /12345678901231|1234567890123/, `GS1 解码内容: ${joined}`);
});
