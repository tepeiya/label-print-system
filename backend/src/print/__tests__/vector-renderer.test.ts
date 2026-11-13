// P8.2 整标签矢量 SVG 单测：几何、求值、拼版、边界
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXPORT_LABELS, buildExportSvgs, layoutSheets, ptToMm, renderLabelSvg,
} from '../vector-renderer';

const page = { widthMm: 40, heightMm: 30 };

test('ptToMm：标准 pt→mm 换算，非法字号回退 10pt', () => {
  assert.equal(ptToMm(72), 25.4);
  assert.equal(ptToMm(10), 3.528);
  assert.equal(ptToMm(0), 3.528, '0 号字回退默认 10pt');
  assert.equal(ptToMm(-5), 3.528);
});

test('renderLabelSvg：根尺寸/mm 单位/白底不重复，文本 XML 转义', () => {
  const { svg, warnings } = renderLabelSvg([
    { type: 'text', x: 2, y: 3, w: 30, h: 6, text: 'SKU: A&B <01>', font: { size: 10 } },
    { type: 'rect', x: 1, y: 1, w: 38, h: 28, fill: '#ffffff', stroke: { color: '#000', width: 0.3 } },
  ], page);
  assert.match(svg, /width="40mm" height="30mm"/);
  assert.match(svg, /viewBox="0 0 40 30"/);
  assert.match(svg, /A&amp;B &lt;01&gt;/);
  assert.match(svg, /<rect x="1" y="1" width="38" height="28"/);
  assert.equal(svg.includes('fill="#FFFFFF" />'), false, '标签层不铺整页白底（避免 <g> 里百分比 rect 画满整页）');
  assert.deepEqual(warnings, []);
});

test('renderLabelSvg：对齐锚点、旋转、_skip / visible=false 跳过', () => {
  const { svg } = renderLabelSvg([
    { type: 'text', x: 0, y: 0, w: 40, h: 6, text: 'CENTER', font: { align: 'center', size: 8 } },
    { type: 'text', x: 0, y: 8, w: 10, h: 4, text: 'R', font: { align: 'right' } },
    { type: 'rect', x: 1, y: 1, w: 5, h: 5, rotation: 90 },
    { type: 'text', x: 0, y: 0, w: 5, h: 5, text: 'SKIP', _skip: true },
    { type: 'text', x: 0, y: 0, w: 5, h: 5, text: 'HIDDEN', visible: false },
  ], page);
  assert.match(svg, /text-anchor="middle"/);
  assert.match(svg, /text-anchor="end"/);
  assert.match(svg, /rotate\(90 3\.5 3\.5\)/);
  assert.equal(svg.includes('SKIP'), false);
  assert.equal(svg.includes('HIDDEN'), false);
});

test('renderLabelSvg：条码/二维码内联 bwip 的嵌套 SVG（真矢量，不是位图）', () => {
  const { svg, warnings } = renderLabelSvg([
    { type: 'barcode', x: 2, y: 18, w: 30, h: 9, barcode: { sym: 'CODE128', content: 'ABC123', moduleWidthMm: 0.25, showText: true } },
    { type: 'qrcode', x: 30, y: 2, w: 8, h: 8, qrcode: { sym: 'QRCODE', content: 'HELLO', moduleSizeMm: 0.4, ecc: 'M' } },
  ], page);
  assert.equal(svg.match(/<svg x=/g)?.length, 2, '两个码制各嵌一个嵌套 svg');
  assert.match(svg, /<path /, 'bwip 输出的是 path 几何');
  assert.equal(svg.includes('<image'), false, '矢量导出不出现位图');
  assert.equal(warnings.length, 0);
});

test('renderLabelSvg：外链图片给 warning，编码失败不静默吞掉', () => {
  const { svg, warnings } = renderLabelSvg([
    { type: 'image', x: 1, y: 1, w: 10, h: 10, src: 'https://cdn.example.com/a.png' },
    { type: 'barcode', x: 1, y: 12, w: 20, h: 6, barcode: { sym: 'NO_SUCH_SYM', content: 'x' } },
  ], page);
  assert.match(svg, /<image href="https:\/\/cdn\.example\.com/);
  assert.ok(warnings.some((w) => w.includes('外链图片')));
  assert.ok(warnings.some((w) => w.includes('编码失败')));
});

test('layoutSheets：1×1 与 2×3 拼版的页面尺寸与 translate 坐标', () => {
  const one = layoutSheets(['<svg viewBox="0 0 40 30"><text a="1"/></svg>'], page);
  assert.equal(one.sheets.length, 1);
  assert.equal(one.sheetWidthMm, 40);
  assert.equal(one.sheetHeightMm, 30);
  assert.match(one.sheets[0], /fill="#FFFFFF"/, 'sheet 层铺白底');

  const labels = Array.from({ length: 7 }, () => '<svg viewBox="0 0 40 30"><text a="1"/></svg>');
  const multi = layoutSheets(labels, { widthMm: 40, heightMm: 30, columns: 2, rows: 3, gapXMm: 2, gapYMm: 3, marginMm: 1 });
  // 2*40 + 2 + 2*1 = 84 ; 3*30 + 2*3 + 2*1 = 98
  assert.equal(multi.sheetWidthMm, 84);
  assert.equal(multi.sheetHeightMm, 98);
  assert.equal(multi.perSheet, 6);
  assert.equal(multi.sheets.length, 2, '7 张标签 → 2 张 sheet');
  assert.match(multi.sheets[0], /translate\(1 1\)/, '左上含 margin');
  assert.match(multi.sheets[0], /translate\(43 1\)/, '第二列 = margin + 40 + gapX');
  assert.match(multi.sheets[0], /translate\(1 34\)/, '第二行 = margin + 30 + gapY');
});

test('buildExportSvgs：变量求值、copies 展开、系统变量、中文提示', () => {
  const tpl = {
    page: { ...page, dpi: 300 },
    elements: [
      { id: 't1', type: 'text', x: 2, y: 2, w: 30, h: 6, text: 'SKU-{{sku}} 中文', font: { size: 10 } },
      { id: 't2', type: 'text', x: 2, y: 10, w: 30, h: 5, text: '{{pageNo}}/{{pageTotal}}', font: { size: 8 } },
    ],
  };
  const out = buildExportSvgs({ templateContent: tpl, rows: [{ sku: 'A1' }, { sku: 'B2' }], copies: 2 });
  assert.equal(out.labelCount, 4);
  assert.equal(out.sheets.length, 4, '未配拼版时一标签一页');
  assert.match(out.sheets[0], /SKU-A1/);
  assert.match(out.sheets[1], /SKU-B2/);
  assert.match(out.sheets[0], /1\/4/, '系统变量已求值');
  assert.ok(out.warnings.some((w) => w.includes('中文文本')));
  assert.ok(out.warnings.some((w) => w.includes('非矢量 PDF')));
});

test('buildExportSvgs：超过上限抛错，不静默截断', () => {
  const tpl = { page: { ...page }, elements: [{ id: 't', type: 'text', x: 0, y: 0, w: 10, h: 5, text: 'x' }] };
  assert.throws(
    () => buildExportSvgs({ templateContent: tpl, rows: [{}], copies: MAX_EXPORT_LABELS + 1 }),
    /超过上限/,
  );
  assert.throws(() => buildExportSvgs({ templateContent: {} as any }), /缺少 page/);
});
