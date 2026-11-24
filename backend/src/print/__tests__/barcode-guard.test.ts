// P0-2：打印前条码自检 —— 纯函数部分（密度闸门 / 目标收集 / 摘要）。
// 真解码链路不在这里跑（zxing WASM 初始化 ~18s），由 verify.service.test.ts 与端到端脚本覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_HEIGHT_1D_MM, MIN_XDIM_1D_MM, MIN_XDIM_2D_MM,
  barcodeTargetsOf, checkDensity, summarizeGuard,
} from '../barcode-guard';

const bc = (o: any) => ({ id: 'b1', type: 'barcode', xMm: 2, yMm: 2, barcode: o });
const qr = (o: any, hMm = 15) => ({ id: 'q1', type: 'qrcode', xMm: 2, yMm: 20, hMm, qrcode: o });

test('barcodeTargetsOf：一维/二维分别取名义 X-dim 与条高', () => {
  const t = barcodeTargetsOf([
    bc({ sym: 'code128', content: 'A1', moduleWidthMm: 0.33, heightMm: 12 }),
    qr({ sym: 'datamatrix', content: '(01)123', moduleSizeMm: 0.5 }, 18),
    { id: 'x', type: 'text', text: 'hi' },
    { type: 'rect', wMm: 5, hMm: 3 },
  ]);
  assert.equal(t.length, 2);
  assert.equal(t[0].twoD, false);
  assert.equal(t[0].xdimMm, 0.33);
  assert.equal(t[1].twoD, true);
  assert.equal(t[1].xdimMm, 0.5);
  assert.equal(t[1].heightMm, 18);
});

test('checkDensity：内容为空直接拦（变量没取到值是最常见的废标原因）', () => {
  const issue = checkDensity({
    elementId: 'b1', sym: 'CODE128', content: '  ', twoD: false,
    xdimMm: 0.33, heightMm: 12, spec: {},
  });
  assert.ok(issue);
  assert.equal(issue!.kind, 'encode');
  assert.equal(issue!.blocking, true);
});

test('checkDensity：一维窄条低于下限 / 条高不足 都要拦', () => {
  const thin = checkDensity({
    elementId: 'b1', sym: 'CODE128', content: 'A1', twoD: false,
    xdimMm: MIN_XDIM_1D_MM - 0.01, heightMm: 12, spec: {},
  });
  assert.equal(thin?.kind, 'density');
  assert.match(thin!.message, /窄条尺寸/);

  const short = checkDensity({
    elementId: 'b1', sym: 'CODE128', content: 'A1', twoD: false,
    xdimMm: 0.33, heightMm: MIN_HEIGHT_1D_MM - 0.5, spec: {},
  });
  assert.equal(short?.kind, 'density');
  assert.match(short!.message, /条高/);
});

test('checkDensity：二维模块低于下限要拦，达标放行', () => {
  const bad = checkDensity({
    elementId: 'q1', sym: 'DATAMATRIX', content: '(01)123', twoD: true,
    xdimMm: MIN_XDIM_2D_MM - 0.01, heightMm: 15, spec: {},
  });
  assert.equal(bad?.blocking, true);
  assert.match(bad!.message, /模块尺寸/);

  const ok = checkDensity({
    elementId: 'q1', sym: 'DATAMATRIX', content: '(01)123', twoD: true,
    xdimMm: 0.4, heightMm: 15, spec: {},
  });
  assert.equal(ok, null);
});

test('summarizeGuard：只汇总阻断项，最多展示三条', () => {
  const r = {
    ok: false, checked: 4,
    issues: [
      { elementId: 'a', sym: 'CODE128', content: 'x', kind: 'density' as const, message: '太窄', blocking: true },
      { elementId: 'b', sym: 'QRCODE', content: 'y', kind: 'unsupported' as const, message: '解码器不支持', blocking: false },
      { elementId: 'c', sym: 'EAN13', content: 'z', kind: 'encode' as const, message: '内容非法', blocking: true },
    ],
  };
  const msg = summarizeGuard(r);
  assert.match(msg, /条码自检未通过（2 项）/);
  assert.match(msg, /CODE128/);
  assert.match(msg, /EAN13/);
  assert.doesNotMatch(msg, /QRCODE/, '非阻断项不该进摘要');
});
