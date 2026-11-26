// =============================================================================
// label-png.test.ts —— 标签栅格化（image / png-base64 通道）
//
// 修复背景：ImageProvider 原来在无 node-canvas 时回退「白底占位 PNG」，
//   打出来是空白纸且被记成功。现改为 已渲染元素 → 整标签 SVG → sharp 栅格化，
//   并把「没有元素」变成显式失败。
//
// 验收口径：出的 PNG ①尺寸按 dpi 精确；②确实有内容（非全白）；③条码可被 zxing 解码。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { renderLabelPng, mmToPixel } from '../label-png';
import { ImageProvider } from '../../../printer/printer-provider.interface';
import { decodeBarcodeImage } from '../verify.service';
import { gtinCheckDigit } from '../../../core/checksum';

const GTIN = '0690123456789' + gtinCheckDigit('0690123456789');
const UDI = `(01)${GTIN}` + '(17)271231(10)LOT-R1(21)SN0001';

const labelElements = () => [
  { id: 'n', type: 'text', x: 2, y: 1.5, w: 46, h: 5, text: '真空采血管 5ml', font: { size: 9, bold: true, align: 'center' } },
  { id: 'dm', type: 'qrcode', x: 2, y: 11, w: 16, h: 16,
    qrcode: { sym: 'DATAMATRIX', content: UDI, ecc: 'M', moduleSizeMm: 0.3, quietZoneMm: 1, gs1: true } },
  { id: 'hri', type: 'text', x: 19.5, y: 11, w: 28.5, h: 16, text: UDI, font: { size: 6 } },
];

test('尺寸按 dpi 精确：50×30mm @300dpi → 591×354', async () => {
  const r = await renderLabelPng({ elements: labelElements(), widthMm: 50, heightMm: 30, dpi: 300 });
  const meta = await sharp(r.png).metadata();
  assert.equal(meta.width, mmToPixel(50, 300));
  assert.equal(meta.height, mmToPixel(30, 300));
  assert.equal(meta.format, 'png');
  assert.equal(r.widthPx, 591);
  assert.equal(r.heightPx, 354);
});

test('出图不是空白：有深色像素（不再是占位白纸）', async () => {
  const r = await renderLabelPng({ elements: labelElements(), widthMm: 50, heightMm: 30, dpi: 300 });
  const raw = await sharp(r.png).greyscale().raw().toBuffer();
  let dark = 0;
  for (const v of raw) if (v < 60) dark++;
  assert.ok(dark > 5000, `深色像素应远多于噪声，实际 ${dark}`);
  assert.ok(dark < raw.length, '不应整张全黑');
});

test('回环：PNG 里的 GS1 DataMatrix 能被 zxing 解码并解析出 AI', async () => {
  const r = await renderLabelPng({ elements: labelElements(), widthMm: 50, heightMm: 30, dpi: 300 });
  const hits = await decodeBarcodeImage(r.png, 'DATAMATRIX');
  assert.ok(hits.length > 0, '应当至少解码出一个码');
  const text = hits[0].text;
  assert.ok(text.includes('01') , `解码文本应含 01 AI：${text}`);
  assert.ok(text.includes('LOT-R1'), `解码文本应含批号：${text}`);
});

test('ImageProvider 用已渲染元素出真码（ok:true 且可解码）', async () => {
  const p = new ImageProvider();
  const res = await p.print({
    tenantId: 1, jobId: 42, templateId: 7,
    printer: { type: 'image', dpi: 300, widthMm: 50, heightMm: 30, offsetXMm: 0, offsetYMm: 0, orientation: 0, connection: {} },
    copies: 1,
    labels: [{ elements: labelElements() }],
  } as any);
  assert.equal(res.ok, true);
  assert.ok(res.bytes && res.bytes.length > 1000, '应返回真实 PNG 字节');
  const hits = await decodeBarcodeImage(res.bytes!, 'DATAMATRIX');
  assert.ok(hits.length > 0);
});

test('缺元素时显式失败，绝不回退白底占位', async () => {
  const p = new ImageProvider();
  const res = await p.print({
    tenantId: 1, jobId: 43, templateId: 7,
    printer: { type: 'image', dpi: 300, widthMm: 50, heightMm: 30, offsetXMm: 0, offsetYMm: 0, orientation: 0, connection: {} },
    copies: 1,
    labels: [{}],
  } as any);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /缺少可渲染元素/);
});

test('尺寸非法 / DPI 越界 → 抛错（不产出可疑图）', async () => {
  await assert.rejects(() => renderLabelPng({ elements: [], widthMm: 0, heightMm: 30, dpi: 300 }), /尺寸非法/);
  await assert.rejects(() => renderLabelPng({ elements: [], widthMm: 50, heightMm: 30, dpi: 5000 }), /DPI 超出范围/);
});
