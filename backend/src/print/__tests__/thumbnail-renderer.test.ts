// 第二层：缩略图 DPI 自适应单测
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderThumbnail, DEFAULT_THUMB_DPI } from '../thumbnail-renderer';

const tpl = {
  page: { widthMm: 50, heightMm: 30 },
  elements: [
    { type: 'rect', x: 1, y: 1, w: 48, h: 28, fill: '#ffffff', stroke: { color: '#000', width: 0.5 } },
    { type: 'barcode', x: 3, y: 10, w: 30, h: 10, barcode: { sym: 'CODE128', content: 'ABC123' } },
  ],
};

test('renderThumbnail：默认 dpi=300，输出尺寸按 target 长边缩放', async () => {
  assert.equal(DEFAULT_THUMB_DPI, 300);
  const png = await renderThumbnail(tpl, 200, 200);
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 200, '50×30 → 长边 200');
  assert.equal(meta.height, 120, '等比 30/50*200=120');
});

test('renderThumbnail：不同 dpi 均产出合法 PNG，高 dpi 不触发像素上限退化', async () => {
  for (const dpi of [72, 300, 600, 1200]) {
    const png = await renderThumbnail(tpl, 200, 200, { dpi });
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 200, `dpi=${dpi} 仍按目标像素输出`);
    assert.equal(meta.height, 120);
    assert.ok(png.length > 400, `dpi=${dpi} 不是 16×16 兜底空图`);
  }
});

test('renderThumbnail：各 kernel 策略均合法输出', async () => {
  for (const kernel of ['nearest', 'mitchell', 'lanczos3'] as const) {
    const png = await renderThumbnail(tpl, 80, 80, { dpi: 300, kernel });
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 80);
    assert.equal(meta.format, 'png');
  }
});

test('renderThumbnail：dpi 被夹取到 [72,1200]，非法值回退默认', async () => {
  const a = await renderThumbnail(tpl, 100, 100, { dpi: 99999 });
  const b = await renderThumbnail(tpl, 100, 100, { dpi: 1200 });
  assert.ok(a.length > 0 && b.length > 0);
  const c = await renderThumbnail(tpl, 100, 100, { dpi: NaN });
  assert.ok(c.length > 0, 'NaN 回退默认不抛错');
});

test('renderThumbnail：空 page 返回兜底白图', async () => {
  const png = await renderThumbnail({ page: { widthMm: 0, heightMm: 0 } as any, elements: [] }, 64, 64);
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 16);
  assert.equal(meta.height, 16);
});
