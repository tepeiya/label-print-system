// 第二层：弧形文字 / 弧形条码单测（矢量 SVG 通道）
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLabelSvg } from '../vector-renderer';

const page = { widthMm: 60, heightMm: 40 };

test('弧形文字：curve.enabled 生成 <textPath> 与弧线 <path>，普通文字不生成', () => {
  const { svg, warnings } = renderLabelSvg([
    { type: 'text', x: 5, y: 5, w: 40, h: 8, text: '弧形品牌名', font: { size: 12 }, curve: { enabled: true, radiusMm: 30, sweepDeg: 60 } },
  ], page);
  assert.match(svg, /<textPath /, '有 textPath');
  assert.match(svg, /<defs><path id="arc-[^"]+" d="M[^"]+ A [^"]+" fill="none" \/>/, '有圆弧 path');
  assert.match(svg, / A [\d.]+ [\d.]+ 0 0 [01] /, '弧线用 A 圆弧指令');
  assert.match(svg, /startOffset="50%"/, '默认居中');
  assert.match(svg, /弧形品牌名/);
  assert.ok(warnings.some((w) => w.includes('弧形文字')));
});

test('弧形文字：direction=down 与 align=right 改变 sweepFlag 与 startOffset', () => {
  const { svg } = renderLabelSvg([
    { type: 'text', x: 5, y: 5, w: 40, h: 8, text: 'RIGHT', font: { size: 10, align: 'right' }, curve: { enabled: true, radiusMm: 30, sweepDeg: 90, direction: 'down' } },
  ], page);
  assert.match(svg, /startOffset="100%"/);
  assert.match(svg, /text-anchor="end"/);
  // 向下拱 sweepFlag=0
  assert.match(svg, /A [\d.]+ [\d.]+ 0 0 0 /);
});

test('弧形文字：多行文本不弧形化（退化为普通 text）', () => {
  const { svg } = renderLabelSvg([
    { type: 'text', x: 5, y: 5, w: 40, h: 8, text: 'A\nB', font: { size: 10 }, curve: { enabled: true, radiusMm: 30 } },
  ], page);
  assert.equal(svg.includes('<textPath'), false);
  assert.match(svg, /<tspan/);
});

test('弧形条码：curve.enabled 生成旋转 <line> 条码，比直线条码线多', () => {
  const bc = (curve?: any) => renderLabelSvg([
    { type: 'barcode', x: 5, y: 15, w: 40, h: 12, barcode: { sym: 'CODE128', content: 'ABC-123', showText: false }, ...(curve ? { curve } : {}) },
  ], page).svg;
  const straight = bc(undefined);
  const arc = bc({ enabled: true, radiusMm: 48, sweepDeg: 60 });
  assert.match(straight, /<svg x=/, '直线条码走 embedBwip 嵌套 svg');
  assert.equal(arc.includes('<svg x='), false, '弧形条码不嵌套 svg');
  assert.match(arc, /<line[^>]*transform="rotate\([-\d.]+ [\d.]+ [\d.]+\)"/, '每根条码线带旋转');
  assert.ok((arc.match(/<line /g) ?? []).length >= 5, '生成多根条码线');
});

test('弧形条码：warning 明示近似与非指令通道退化', () => {
  const { warnings } = renderLabelSvg([
    { type: 'barcode', x: 5, y: 15, w: 40, h: 12, barcode: { sym: 'CODE128', content: 'ABC', showText: false }, curve: { enabled: true, radiusMm: 48 } },
  ], page);
  assert.ok(warnings.some((w) => w.includes('视觉近似')));
  assert.ok(warnings.some((w) => w.includes('真机验证')));
});

test('二维码不受 curve 影响（二维码无弧形语义）', () => {
  const withCurve = renderLabelSvg([
    { type: 'qrcode', x: 5, y: 5, w: 12, h: 12, qrcode: { sym: 'QRCODE', content: 'X' }, curve: { enabled: true, radiusMm: 30 } },
  ], page).svg;
  const without = renderLabelSvg([
    { type: 'qrcode', x: 5, y: 5, w: 12, h: 12, qrcode: { sym: 'QRCODE', content: 'X' } },
  ], page).svg;
  assert.equal(withCurve, without);
});
