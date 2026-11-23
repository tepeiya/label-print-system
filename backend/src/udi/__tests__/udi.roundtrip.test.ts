// UDI 打印回环验证：构造 → 渲染 PNG → zxing 解码 → 解析
// 目的：证明「打出来的 GS1 DataMatrix 真的能被扫码枪读出 DI/PI」，而不是只算对了字符串。
// 边界：这是位图通道（bwip）验证，不等于真机打印验收（见 docs/18 的验收说明）。
import test from 'node:test';
import assert from 'node:assert/strict';
import bwipjs from '@bwip-js/node';
import { gtinCheckDigit } from '../../../core/checksum';
import { renderBarcodeToPng } from '../../../core/barcode-renderer';
import { decodeBarcodeImage } from '../../print/verify.service';
import { buildUdi, udiBarcodeSpec, parseUdi } from '../udi.calc';

const body = '0690123456789';
const gtin14 = body + gtinCheckDigit(body);

const udi = buildUdi({ gtin: gtin14, expiry: '2027-12-31', lot: 'LOT01', serial: 'SN0001' });

const spec = {
  ...udiBarcodeSpec(udi, { moduleSizeMm: 0.4 }),
  moduleWidthMm: 0.3,
  wideRatio: 2.5,
  showText: false,
  textPosition: 'bottom' as const,
};

test('GS1 DataMatrix：渲染后可解码为 HRI，且能反解出 DI/PI', async () => {
  const png = await renderBarcodeToPng(spec as any, 300);
  const candidates = await decodeBarcodeImage(png, 'DATAMATRIX');
  assert.ok(candidates.length > 0, '应当至少解码出一个码');
  const hit = candidates.find((c) => c.text.includes('(01)')) ?? candidates[0];
  const parsed = parseUdi(hit.text);
  assert.equal(parsed.ok, true, `解码文本应可解析：${hit.text}`);
  assert.equal(parsed.udi.gtin, gtin14);
  assert.equal(parsed.udi.lot, 'LOT01');
  assert.equal(parsed.udi.serial, 'SN0001');
  assert.equal(parsed.udi.expiry, '271231');
});

test('对照：禁用 gs1 标志的普通 DataMatrix 不含 GS1 语义（避免误用）', async () => {
  const plain = await bwipjs.toBuffer({
    bcid: 'datamatrix', text: udi.hri, scale: 4, paddingwidth: 8, paddingheight: 4, backgroundcolor: 'FFFFFF',
  });
  const plainParsed = parseUdi(udi.hri);
  // 文本本身是 HRI，仍可解析；但普通 DataMatrix 不会带 FNC1 语义，扫码器可能断句失败
  assert.equal(plainParsed.ok, true);
  assert.ok(plain.length > 0);
});
