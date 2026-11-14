// P8.4 工业码制（MaxiCode / HIBC / PZN）位图通道回归
// 重点：证明「能力表登记」与「bwip 真能出图」一一对应，杜绝空登记冒充可用。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYMBOLOGIES, canonSym, capabilityFor, describeUnsupported, hasNative,
  uiSymbologyList,
} from '../symbology.capabilities';
import {
  BWIP_MAP, bcidOf, is2d, supportedSymbologies, validateBarcode,
  renderBarcodeSvg, renderQrcodeSvg,
} from '../barcode-renderer';

const INDUSTRIAL = ['MAXICODE', 'HIBC_128', 'HIBC_CODE39', 'HIBC_DATAMATRIX', 'HIBC_QR', 'PZN'];

test('六码制全部登记、位图可用、无任何指令协议（前端标「预览仅」）', () => {
  const map = new Map(uiSymbologyList().map((i) => [i.sym, i]));
  for (const sym of INDUSTRIAL) {
    const c = capabilityFor(sym);
    assert.ok(c, `${sym} 未登记`);
    assert.equal(c.bitmap, true, `${sym} 必须能位图预览`);
    assert.equal(map.get(sym)!.previewOnly, true, `${sym} 应标预览仅`);
    assert.deepEqual(map.get(sym)!.printProtocols, []);
    for (const p of ['zpl', 'tspl', 'epl'] as const) {
      assert.equal(hasNative(p, sym), false, `${sym}@${p} 不应声明 native`);
    }
  }
  assert.equal(Object.keys(SYMBOLOGIES).length, 26, 'P7 基线 20 + P8.4 新增 6');
});

test('别名归一化收敛到标准标识', () => {
  assert.equal(canonSym('HIBC'), 'HIBC_128');
  assert.equal(canonSym('HIBC-128'), 'HIBC_128');
  assert.equal(canonSym('HIBCDM'), 'HIBC_DATAMATRIX');
  assert.equal(canonSym('HIBC-QR'), 'HIBC_QR');
  assert.equal(canonSym('MAXI_CODE'), 'MAXICODE');
  assert.equal(canonSym('PZN7'), 'PZN');
});

test('BWIP_MAP 与能力表一一对应，is2d 分类正确', () => {
  for (const sym of INDUSTRIAL) assert.ok(BWIP_MAP[sym], `${sym} 缺 bwip bcid`);
  assert.equal(bcidOf('MAXICODE'), 'maxicode');
  assert.equal(bcidOf('PZN'), 'pzn');
  assert.equal(is2d('MAXICODE'), true);
  assert.equal(is2d('HIBC_DATAMATRIX'), true);
  assert.equal(is2d('HIBC_QR'), true);
  assert.equal(is2d('HIBC_128'), false, 'HIBC 线性载体不能当二维码渲染');
  assert.equal(is2d('PZN'), false);
  const list = supportedSymbologies();
  assert.ok(list.linear.includes('PZN') && list.linear.includes('HIBC_128'));
  assert.ok(list.twod.includes('MAXICODE') && list.twod.includes('HIBC_QR'));
});

test('真实渲染：六种码制 bwip 都能产出合法 SVG（非空登记）', () => {
  const linearSpecs: Array<[string, string]> = [
    ['HIBC_128', 'ABC123'], ['HIBC_CODE39', 'ABC123'], ['PZN', '123456'],
  ];
  for (const [sym, content] of linearSpecs) {
    const svg = renderBarcodeSvg({ sym, content, moduleWidthMm: 0.25, heightMm: 10, showText: false } as any);
    assert.match(svg, /<svg[^>]*>[\s\S]*<\/svg>/, `${sym} 输出必须是 SVG`);
    assert.match(svg, /<path|<rect|<g/, `${sym} 必须有图形内容`);
  }
  const twoDSpecs: Array<[string, string]> = [
    ['MAXICODE', 'ABC123'], ['HIBC_DATAMATRIX', 'ABC123'], ['HIBC_QR', 'ABC123'],
  ];
  for (const [sym, content] of twoDSpecs) {
    const svg = renderQrcodeSvg({ sym, content, moduleSizeMm: 0.4, ecc: 'M' } as any);
    assert.match(svg, /<svg[^>]*>[\s\S]*<\/svg>/, `${sym} 输出必须是 SVG`);
    assert.match(svg, /<path|<rect|<g/, `${sym} 必须有图形内容`);
  }
});

test('内容校验：PZN 仅数字、MaxiCode 超长拒绝', () => {
  assert.equal(validateBarcode('PZN', '123456').ok, true);
  assert.equal(validateBarcode('PZN', 'ABCDEF').ok, false);
  assert.equal(validateBarcode('MAXICODE', 'X'.repeat(100)).ok, false);
});

test('不静默降级：不支持的指令通道给 warning 且 ZPL 区分「手册无」与「暂未覆盖」', () => {
  const pzn = describeUnsupported('zpl', 'PZN');
  assert.equal(pzn.skip, true);
  assert.equal(pzn.degradeTo, undefined);
  assert.match(pzn.warnings[0], /手册无/);
  const maxi = describeUnsupported('zpl', 'MAXICODE');
  assert.equal(maxi.skip, true);
  assert.match(maxi.warnings[0], /暂未覆盖/);
  assert.match(maxi.warnings[0], /\^BD/);
  // 位图通道一律可用
  assert.equal(describeUnsupported('image', 'MAXICODE').warnings.length, 0);
});
