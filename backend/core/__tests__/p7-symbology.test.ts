// =============================================================================
// p7-symbology.test.ts —— P7 条码核心：单一真源自洽 + 指令 golden 快照
//
// 验收口径（docs/10 §10.7.3 C）：
//   1. 前端可选每一个码制，都能在各生成器里找到对应分支（没有统一回落）；
//   2. 不支持的码制必出 warnings，且指令里没有静默降级成 Code128/QR；
//   3. 每码制 3 条（短内容 / 边界长度 / 带校验位）指令结构稳定。
//
// 纯函数测试，不 import TypeORM/Nest（docs/10 §10.15.6）。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYMBOLOGIES, canonSym, capabilityFor, describeUnsupported, hasNative,
  uiSymbologyList, snapModuleWidth, quietZoneMm, humanReadablePlacement,
  resolveBarcodeGeometry, encodeGs1, gs1ToProtocol, dotMm,
} from '../symbology.capabilities';
import { generateZpl } from '../zpl-generator';
import { buildJob as buildTspl } from '../tspl-generator';
import { buildJob as buildEpl } from '../epl-generator';
import type { BarcodeSpec, QrcodeSpec } from '../types';

const DPI = 300;
const linear = (sym: string, content = 'ABC123'): BarcodeSpec => ({
  sym, content, moduleWidthMm: 0.25, wideRatio: 2.5, heightMm: 10,
  showText: true, textPosition: 'bottom', checksum: true,
});
const twoD = (sym: string, content = 'HELLO-中文'): QrcodeSpec => ({
  sym, content, ecc: 'M', moduleSizeMm: 0.4, quietZoneMm: 2,
});

// ---------------------- 1. 单一真源自洽性 ----------------------
test('P7-能力真源：前端可选码制全部登记且无重复', () => {
  const items = uiSymbologyList();
  assert.equal(items.length, 20, '14 种一维 + 6 种二维');
  assert.equal(new Set(items.map((i) => i.sym)).size, items.length);
  // 每个码制至少要有位图通道（预览）
  for (const c of Object.values(SYMBOLOGIES)) assert.equal(c.bitmap, true, `${c.sym} 必须能位图预览`);
});

test('P7-别名归一化：历史模板/AI 结果的写法都能收敛', () => {
  assert.equal(canonSym('UPC-A'), 'UPC');
  assert.equal(canonSym('upc_a'), 'UPC');
  assert.equal(canonSym('GS1-128'), 'GS1_128');
  assert.equal(canonSym('INTERLEAVED2OF5'), 'ITF');
  assert.equal(canonSym('QR'), 'QRCODE');
  assert.equal(canonSym('MSI11'), 'MSI');
  assert.equal(canonSym('CODE128C'), 'CODE128');
});

test('P7-受限标记：PHARMACODE/CODE16K 无任何指令协议 → 预览仅', () => {
  const map = new Map(uiSymbologyList().map((i) => [i.sym, i]));
  for (const s of ['PHARMACODE', 'CODE16K']) {
    assert.equal(map.get(s)!.previewOnly, true, `${s} 应标预览仅`);
    assert.match(map.get(s)!.badge, /预览仅/);
  }
  // 主流码制不是"预览仅"，且列出可用协议
  assert.equal(map.get('CODE128')!.previewOnly, false);
  assert.deepEqual(map.get('CODE128')!.printProtocols, ['zpl', 'tspl', 'epl']);
  assert.deepEqual(map.get('DATAMATRIX')!.printProtocols, ['zpl']);
  assert.ok(map.get('MICROQR')!.degradeOn.includes('tspl'), 'MICROQR 在 TSPL 显式降级');
});

test('P7-声明 native 的码制，生成器一定能出原生指令（防漂移 golden）', () => {
  // 这是最关键的回归：能力真源说能打，生成器就必须真能打。
  for (const c of Object.values(SYMBOLOGIES)) {
    for (const proto of ['zpl', 'tspl', 'epl'] as const) {
      if (!hasNative(proto, c.sym)) continue;
      const el = c.kind === 'linear'
        ? { type: 'barcode' as const, xMm: 2, yMm: 2, barcode: linear(c.sym) }
        : { type: 'qrcode' as const, xMm: 2, yMm: 2, qrcode: twoD(c.sym) };
      let text = '';
      if (proto === 'zpl') text = generateZpl([el], DPI).text;
      else if (proto === 'tspl') text = buildTspl([el as any], DPI, { widthMm: 60, heightMm: 40 }).buffer.toString('ascii');
      else text = buildEpl([el as any], DPI, { widthMm: 60, heightMm: 40 }).buffer.toString('ascii');
      assert.ok(text.length > 20, `${c.sym}@${proto} 声明 native 但没有产出指令`);
      // 关键：不能有"不支持/跳过"warning
      const warns = proto === 'zpl' ? generateZpl([el], DPI).warnings
        : proto === 'tspl' ? buildTspl([el as any], DPI, { widthMm: 60, heightMm: 40 }).warnings
        : buildEpl([el as any], DPI, { widthMm: 60, heightMm: 40 }).warnings;
      assert.ok(!warns.some((w) => /跳过|暂未覆盖|缺.*映射/.test(w)),
        `${c.sym}@${proto} 声明 native 却回了跳过类 warning: ${warns.join('|')}`);
    }
  }
});

// ---------------------- 2. 不静默降级（P7.1 回归 + 精确引导） ----------------------
test('P7-不支持码制：出 warning 且指令里无 Code128/QR 回落', () => {
  for (const proto of ['zpl', 'tspl', 'epl'] as const) {
    for (const sym of ['PHARMACODE', 'CODE16K']) {
      const el = { type: 'barcode' as const, xMm: 2, yMm: 2, barcode: linear(sym) };
      let text = '', warns: string[] = [];
      if (proto === 'zpl') ({ text, warnings: warns } = generateZpl([el], DPI));
      else if (proto === 'tspl') { const j = buildTspl([el], DPI, { widthMm: 60, heightMm: 40 }); text = j.buffer.toString('ascii'); warns = j.warnings; }
      else { const j = buildEpl([el], DPI, { widthMm: 60, heightMm: 40 }); text = j.buffer.toString('ascii'); warns = j.warnings; }
      assert.ok(warns.length >= 1, `${sym}@${proto} 应出 warning`);
      assert.ok(!/\^BC|BARCODE .*"128"|,3,/.test(text), `${sym}@${proto} 出现静默 Code128 回落`);
    }
  }
});

test('P7-warnings 区分两种根因（手册无 vs 暂未覆盖）', () => {
  const noNative = describeUnsupported('zpl', 'CODE16K');
  assert.match(noNative.warnings[0], /手册无/);
  assert.equal(noNative.skip, true);
  const notCovered = describeUnsupported('epl', 'CODE93');
  assert.match(notCovered.warnings[0], /暂未覆盖/);
  const ok = describeUnsupported('zpl', 'CODE128');
  assert.equal(ok.warnings.length, 0);
  assert.equal(ok.skip, false);
});

test('P7-TSPL MICROQR 显式降级为标准 QR（不静默、指令里确有 QRCODE）', () => {
  const el = { type: 'qrcode' as const, xMm: 2, yMm: 2, qrcode: twoD('MICROQR') };
  const { buffer, warnings } = buildTspl([el], DPI, { widthMm: 60, heightMm: 40 });
  assert.ok(warnings.some((w) => /降级/.test(w)));
  assert.match(buffer.toString('ascii'), /QRCODE/);
});

// ---------------------- 3. P7.4 GS1 FNC1 语义 ----------------------
test('P7.4-GS1 定长 AI 直接接续、变长 AI 插 FNC1 分隔', () => {
  // (01)14 位 + (17)6 位都是定长 → 无分隔符
  const fixed = encodeGs1('(01)12345678901231(17)251231');
  assert.equal(fixed.invalid.length, 0);
  assert.equal(fixed.separators, 0);
  assert.equal(fixed.data, '011234567890123117251231');
  // (10) 批号是变长 → 后面还有 AI 时必须插 FNC1
  const variable = encodeGs1('(01)12345678901231(10)AB12(17)251231');
  assert.equal(variable.separators, 1);
  assert.ok(variable.data.includes('\u001D'));
});

test('P7.4-GS1 定长 AI 位数不符要报 invalid（不静默编码）', () => {
  const bad = encodeGs1('(01)123(17)251231');
  assert.ok(bad.invalid.some((m) => /AI\(01\)/.test(m)));
});

test('P7.4-GS1 FNC1 按协议转义：ZPL >8 / TSPL !', () => {
  const data = '01X\u001D10AB';
  assert.equal(gs1ToProtocol(data, 'zpl'), '01X>810AB');
  assert.equal(gs1ToProtocol(data, 'tspl'), '01X!10AB');
});

test('P7.4-ZPL/TSPL GS1-128 指令里确有 FNC1 前缀语义', () => {
  // (10) 变长 AI 后面还有 (17) 定长 AI → 之间必须插 FNC1 分隔符（>8 / !）
  const content = '(01)12345678901231(10)AB12(17)251231';
  const zpl = generateZpl([{ type: 'barcode', xMm: 2, yMm: 2, barcode: linear('GS1_128', content) }], DPI);
  assert.match(zpl.text, />;/);              // ZPL FNC1 起始
  assert.match(zpl.text, />8/);              // 变长 AI 后的 FNC1 分隔
  const tspl = buildTspl([{ type: 'barcode', xMm: 2, yMm: 2, barcode: linear('GS1_128', content) }], DPI, { widthMm: 60, heightMm: 40 });
  assert.match(tspl.buffer.toString('ascii'), /!/);  // TSPL FNC1
  // 变长 AI 是最后一个时不插分隔符（GS1 规范：数据结束即边界）
  const tail = encodeGs1('(01)12345678901231(10)AB12');
  assert.equal(tail.separators, 0);
});

// ---------------------- 4. P7.6 条码几何专业调优 ----------------------
test('P7.6-模块宽 DPI 对齐到整数点阵（原理：非整数 dot 会译码失败）', () => {
  const a = snapModuleWidth(0.25, 300);       // 0.25mm*300/25.4=2.95 → 3 dots
  assert.equal(a.dots, 3);
  assert.ok(Math.abs(a.mm * 300 / 25.4 - 3) < 1e-6);
  assert.equal(snapModuleWidth(1, 203).dots, 8);
  // 负值/0 回落到安全默认
  assert.equal(snapModuleWidth(0, 203).dots >= 1, true);
});

test('P7.6-静区按码制自动：EAN13=7X / Code128=10X / QR=4模块 / Aztec=0', () => {
  const x = 0.25;
  assert.equal(quietZoneMm('EAN13', x, 300).left, Number((7 * snapModuleWidth(x, 300).mm).toFixed(3)));
  assert.equal(quietZoneMm('CODE128', x, 300).left, Number((10 * snapModuleWidth(x, 300).mm).toFixed(3)));
  assert.equal(quietZoneMm('QRCODE', x, 300).left, Number((4 * snapModuleWidth(x, 300).mm).toFixed(3)));
  assert.equal(quietZoneMm('AZTEC', x, 300).left, 0); // Aztec 无静区要求
});

test('P7.6-旋转时明文方位反转（避开静区）', () => {
  assert.equal(humanReadablePlacement('bottom', 0).zplFlag, 'N');
  assert.equal(humanReadablePlacement('bottom', 180).zplFlag, 'Y');
  assert.equal(humanReadablePlacement('bottom', 270).zplFlag, 'Y');
  assert.equal(humanReadablePlacement('top', 0).zplFlag, 'Y');
  assert.equal(humanReadablePlacement('top', 180).zplFlag, 'N');
});

test('P7.6-高度过小告警、宽窄比按码制默认', () => {
  const g = resolveBarcodeGeometry({
    sym: 'CODE39', moduleWidthMm: 0.3, heightMm: 0.5,
    showText: true, textPosition: 'bottom', rotation: 0,
  }, 300);
  assert.equal(g.heightTooSmall, true);           // 0.5mm 远小于 10X≈3mm
  assert.equal(g.wideRatio, 2.5);                 // Code39 默认 2.5
  assert.equal(g.humanReadable.zplFlag, 'N');
});

test('P7.6-最小打印点：dot = 25.4/dpi', () => {
  assert.ok(Math.abs(dotMm(203) - 0.1251) < 0.001);
  assert.ok(Math.abs(dotMm(300) - 0.08467) < 0.001);
});

// ---------------------- 5. P7.7 EPL 通道 ----------------------
test('P7.7-EPL 页头/条码/打印命令齐全', () => {
  const { buffer, warnings } = buildEpl([
    { type: 'text', xMm: 2, yMm: 2, text: 'Hi', fontHeightMm: 3 },
    { type: 'barcode', xMm: 2, yMm: 10, barcode: linear('CODE128') },
    { type: 'qrcode', xMm: 2, yMm: 25, qrcode: twoD('QRCODE') },
  ], 203, { widthMm: 60, heightMm: 40, gapMm: 2, copies: 1 });
  const s = buffer.toString('ascii');
  assert.match(s, /^N\r?\nq/);        // 清缓冲 + 页宽
  assert.match(s, /Q\d+,\d+/);        // 页高 + 间隙
  assert.match(s, /A\d+,/);           // 文本
  assert.match(s, /B\d+,\d+,\d+,3,/); // Code128 type=3
  assert.match(s, /,QR,/);            // QR
  assert.match(s, /P1/);              // 打印
  assert.equal(warnings.length, 0);
});

test('P7.7-EPL 无原生码制精确引导、不静默出别的码', () => {
  const { buffer, warnings } = buildEpl([
    { type: 'barcode', xMm: 2, yMm: 2, barcode: linear('CODE16K') },
  ], 203, { widthMm: 60, heightMm: 40 });
  assert.ok(warnings.length >= 1);
  assert.doesNotMatch(buffer.toString('ascii'), /B\d+,\d+,\d+,3,/); // 没回落成 Code128
});

// ---------------------- 6. 每码制 3 条指令结构 golden（短/边界/带校验位） ----------------------
test('P7.8-每码制三种内容的 ZPL 指令结构稳定（golden 摘要）', () => {
  for (const c of Object.values(SYMBOLOGIES)) {
    if (!hasNative('zpl', c.sym)) continue;
    const contents = ['A', 'ABC123456789', '690123456789'];
    for (const content of contents) {
      const el = c.kind === 'linear'
        ? { type: 'barcode' as const, xMm: 2, yMm: 2, barcode: linear(c.sym, content) }
        : { type: 'qrcode' as const, xMm: 2, yMm: 2, qrcode: twoD(c.sym, content) };
      const { text, warnings } = generateZpl([el], DPI);
      assert.match(text, /\^XA[\s\S]*\^XZ/, `${c.sym}/${content} 缺标签头尾`);
      assert.ok(text.includes(content.replace(/中文/g, '')) || c.kind === '2d',
        `${c.sym}/${content} 内容未写入指令`);
      assert.ok(!warnings.some((w) => /跳过/.test(w)), `${c.sym}/${content} 不应跳过`);
    }
  }
});
