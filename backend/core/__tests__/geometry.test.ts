// =============================================================================
// geometry.test.ts —— 条码几何专业约束（P7.8 交付②）
//
// 这一套单测锁的是「打印机物理上做不到的尺寸，不能在指令里假装做得到」。
// 三条硬规则各有一组用例，另加符号长度估算与旋转明文贴靠边。
//
// 为什么估算函数（estimateModules / estimateSymbolLengthMm）也要测：
// 它只用于「25% 高度建议」和「是否超出标签」这类提示，不参与任何指令数值，
// 所以它的正确性标准不是「等于真实符号宽度」，而是
//   ① 结构公式可复现（下面每条都写了推导）；
//   ② 估不出来时返回 0（绝不能猜一个数，猜错会把用户往不合理的高度上带）。
//
// 推导对照（模块 = 最窄单元，r = 宽窄比）：
//   · CODE128：每字符 11 模块。符号 = 起始 11 + 数据 11n + 校验 11 + 终止 13
//       = 11n + 35。实现给 11n+35 ✅ 精确。
//   · EAN-13：左保护条 3 + 左侧 6 位 6×7=42 + 中央保护条 5 + 右侧 6 位 42 + 右保护条 3
//       = 95；EAN-8：3 + 4×7 + 5 + 4×7 + 3 = 67；UPC-A 与 EAN-13 同 95；
//       UPC-E（零压缩）：3 + 4×6 + 6 + 9…规范定值 51。实现给 95/67/95/51 ✅ 精确。
//   · CODE39：每字符 9 个元素（5 条 + 4 空），其中 3 个宽 → 6 + 3r；
//       符号含首尾各一个起始/终止字符 → (n+2)(6+3r)，但**字符之间还有 1 模块间隔**
//       （n+1 个）未计入 → 实现值 = 精确值 − (n+1)（偏差 ~6%，只影响提示）。
//   · ITF：每对数字 10 个元素（4 宽 6 窄）= 6 + 4r，起始 4 窄模块，终止 1 窄条 + 1 宽空
//       = 1 + r → 精确值 = 4 + p(6+4r) + 1 + r（p=n/2）；
//       实现给 8 + p(7+3r)：把「成对内的宽元素个数」当成 3 而非 4，
//       少算 p−3 个模块（n=8、r=2.5 时实现 66 vs 精确 72.5）。
//   · CODABAR：每字符 7 元素（4 条 3 空，2 宽）= 5 + 2r，同样未计字符间隔。
//   · MSI：规范每字符 4 元素（4~8 模块）≈ 7 模块 + 间隔；实现给 12(n+2)+4r，
//       明显偏大（n=5 时 94 vs 约 52），保守地抬高建议高度下限，属可改进项。
//   · CODE16K / PHARMACODE / 所有二维：无法用「字符数 × 固定模块」估 → 返回 0。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  dotPitchMm, computeGeometry, compute2dGeometry, defaultRatio, estimateModules,
  estimateSymbolLengthMm, normSym, textSideFor, isVerticalTextSide,
  HEIGHT_RATIO_OF_LENGTH, MIN_HEIGHT_MODULES,
} from '../barcode-geometry';

const PITCH_203 = 25.4 / 203;

// ---------------------------------------------------------------------------
// 1. 点距
// ---------------------------------------------------------------------------

test('点距-1 打印点 = 25.4/dpi mm（203dpi≈0.125mm、300dpi≈0.0847mm、600dpi≈0.0423mm）', () => {
  assert.equal(dotPitchMm(203), 25.4 / 203);
  assert.ok(Math.abs(dotPitchMm(203) - 0.125123) < 1e-6);
  assert.ok(Math.abs(dotPitchMm(300) - 0.084667) < 1e-6);
  assert.ok(Math.abs(dotPitchMm(600) - 0.042333) < 1e-6);
  // 203dpi 的热敏头是「行业默认」，非法 dpi 必须回落到 203 而不是除出 Infinity/NaN
  for (const bad of [0, -1, NaN, undefined as unknown as number, null as unknown as number, 'abc' as unknown as number]) {
    assert.equal(dotPitchMm(bad), PITCH_203, `dpi=${String(bad)} 应回落 203`);
  }
});

// ---------------------------------------------------------------------------
// 2. X-dimension 量化到整数打印点
// ---------------------------------------------------------------------------

test('X-dim-请求值一律量化成整数点，xMm 恰为 xDots × 点距（不是用户输入的 mm）', () => {
  const g = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.2, content: 'ABC' });
  assert.equal(g.xDots, 2, '0.2mm ÷ 0.125123 = 1.598 → round = 2 点');
  assert.equal(g.xMm, g.xDots * PITCH_203);
  // 关键：指令里用的必须是点数，xMm 只是回算出来的真实物理宽度，两者必须自洽
  assert.notEqual(g.xMm, 0.2, 'xMm 不得等于用户请求值，否则用户以为的宽度与真实宽度不一致');
  // 0.25mm@203 → 2 点；0.4mm@203 → 3 点（0.4/0.125123=3.197）
  assert.equal(computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.25, content: 'A' }).xDots, 2);
  assert.equal(computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.4, content: 'A' }).xDots, 3);
  assert.equal(computeGeometry({ sym: 'CODE128', dpi: 300, moduleWidthMm: 0.25, content: 'A' }).xDots, 3);
  assert.equal(computeGeometry({ sym: 'CODE128', dpi: 600, moduleWidthMm: 0.25, content: 'A' }).xDots, 6);
});

test('X-dim-量化偏差 ≥0.02mm 必须如实提示，300dpi 以下偏差小到看不见时不打扰用户', () => {
  const coarse = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.2, content: 'A' });
  assert.ok(coarse.warnings.some((w) => /\[几何\].*量化为/.test(w)), coarse.warnings.join('\n'));
  assert.ok(coarse.warnings.some((w) => /2 点/.test(w)), '提示里要写清点数为核对依据');

  // 0.381mm@300dpi = 4.5 点 → round 5 点 = 0.4233mm，偏差 0.042 ≥ 0.02 → 提示
  const mid = computeGeometry({ sym: 'CODE128', dpi: 300, moduleWidthMm: 0.381, content: 'A' });
  assert.equal(mid.xDots, 5);
  assert.ok(mid.warnings.some((w) => /量化为/.test(w)), mid.warnings.join('\n'));

  // 0.25mm@300dpi → 3 点 = 0.254mm，偏差 0.004 < 0.02 → 不打扰
  const fine = computeGeometry({ sym: 'CODE128', dpi: 300, moduleWidthMm: 0.25, content: 'A' });
  assert.equal(fine.xDots, 3);
  assert.ok(!fine.warnings.some((w) => /量化为/.test(w)), fine.warnings.join('\n'));

  // 恰好整点倍数时零提示：0.6mm@300dpi = 7.09 点…改用 600dpi 的 0.212mm（=5 点）
  const exact = computeGeometry({ sym: 'CODE128', dpi: 600, moduleWidthMm: 0.2117, content: 'A' });
  assert.equal(exact.xDots, 5);
  assert.ok(!exact.warnings.some((w) => /量化为/.test(w)), exact.warnings.join('\n'));
});

test('X-dim-不足 1 点时抬到 1 点并提示，绝不给 0 点（0 点宽 = 固件参数非法）', () => {
  const g = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.001, content: 'A' });
  assert.equal(g.xDots, 1);
  assert.ok(g.warnings.some((w) => /不足 1 点/.test(w)), g.warnings.join('\n'));
  assert.equal(g.xMm, PITCH_203);
  assert.ok(g.quietDots >= 2 && g.heightDots >= 1, '任何点数都必须 ≥1');
});

test('X-dim-低于码制推荐下限（EAN/UPC 0.293mm、128 家族 0.249mm）时提示识读风险', () => {
  // GS1 规范 EAN/UPC 最小放大率 37% → X-dim 0.293mm；1 点@203dpi = 0.125mm 明显不够
  const ean = computeGeometry({ sym: 'EAN13', dpi: 203, moduleWidthMm: 0.125, content: '6901234567892' });
  assert.ok(ean.warnings.some((w) => /低于该码制推荐下限 0.293mm/.test(w)), ean.warnings.join('\n'));
  const c128 = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.125, content: 'A' });
  assert.ok(c128.warnings.some((w) => /下限 0.249mm/.test(w)), c128.warnings.join('\n'));
  // 300dpi 下 0.25mm → 3 点 = 0.254mm：EAN 仍低于 0.293（提示），Code128 已高于 0.249（不提示）
  const ean300 = computeGeometry({ sym: 'EAN13', dpi: 300, moduleWidthMm: 0.25, content: '6901234567892' });
  assert.ok(ean300.warnings.some((w) => /下限 0.293mm/.test(w)), ean300.warnings.join('\n'));
  const c128300 = computeGeometry({ sym: 'CODE128', dpi: 300, moduleWidthMm: 0.25, content: 'A' });
  assert.ok(!c128300.warnings.some((w) => /低于该码制推荐下限/.test(w)), c128300.warnings.join('\n'));
  // 2D 码制不在这张下限表里（QR 的模块由版本+尺寸决定，另说）
  const qr = computeGeometry({ sym: 'QRCODE', dpi: 203, moduleWidthMm: 0.125, content: 'A' });
  assert.ok(!qr.warnings.some((w) => /低于该码制推荐下限/.test(w)), qr.warnings.join('\n'));
});

// ---------------------------------------------------------------------------
// 3. 固定比例码制：wide 必须等于 narrow
// ---------------------------------------------------------------------------

test('固定比例-EAN/UPC 家族 wideDots === xDots，且用户给的宽窄比被明确忽略并提示', () => {
  for (const sym of ['EAN13', 'EAN8', 'UPC', 'UPC_A', 'UPC_E', 'ISBN', 'ISSN']) {
    const g = computeGeometry({ sym, dpi: 203, moduleWidthMm: 0.25, wideRatio: 2.5, content: '123456' });
    assert.equal(g.fixedRatio, true, `${sym} 应判为固定比例`);
    assert.equal(g.wideDots, g.xDots, `${sym} 宽元素必须等于窄元素，否则印出非法符号`);
    assert.ok(g.warnings.some((w) => /固定比例码制.*已忽略（强制 1:1）/.test(w)), `${sym} 必须提示忽略：${g.warnings.join('\n')}`);
  }
});

test('固定比例-比例本就是 1 时不必啰嗦（避免 300dpi 满屏无意义提示）', () => {
  const g = computeGeometry({ sym: 'EAN13', dpi: 203, moduleWidthMm: 0.25, wideRatio: 1, content: '6901234567892' });
  assert.equal(g.wideDots, g.xDots);
  assert.ok(!g.warnings.some((w) => /已忽略/.test(w)), g.warnings.join('\n'));
});

test('非固定比例-CODE128 的宽元素必须是整数模块（2.5 取整为 3，5 钳到 4，2 原样）', () => {
  const at = (wr: number) => computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.25, wideRatio: wr, content: 'ABC' });
  // xDots=2 → wideDots = 2 × 整数模块
  assert.equal(at(2).wideDots, 4);
  assert.ok(!at(2).warnings.some((w) => /整数模块/.test(w)), '本来就是整数模块不该提示');
  assert.equal(at(2.5).wideDots, 6, '2.5 → round 3 → 6 点');
  assert.ok(at(2.5).warnings.some((w) => /宽窄比 2.5 已取整为 3:1/.test(w)), at(2.5).warnings.join('\n'));
  assert.equal(at(5).wideDots, 8, '超上限先钳到 3.5 再取整 → 4 模块（Code128 宽元素只能是 2~4 模块）');
  assert.ok(at(5).warnings.some((w) => /宽窄比 5 已取整为 4:1/.test(w)));
  assert.equal(at(1.5).wideDots, 4, '低于下限先钳到 1.5 再取整，且不小于 2 模块');
  assert.equal(at(3.49).wideDots, 6);
  assert.equal(at(3).wideDots, 6);
  assert.equal(at(4).wideDots, 8);
  // GS1-128 走同一条规则（同一个码制族）
  const gs1 = computeGeometry({ sym: 'GS1_128', dpi: 203, moduleWidthMm: 0.25, wideRatio: 2.5, content: 'x' });
  assert.equal(gs1.wideDots, 6);
  assert.ok(gs1.warnings.some((w) => /Code128\/GS1-128/.test(w)), gs1.warnings.join('\n'));
});

test('非固定比例-CODE39/ITF/CODABAR/MSI 允许非整数模块比例，wideDots = round(xDots × r)', () => {
  const itf = computeGeometry({ sym: 'ITF', dpi: 203, moduleWidthMm: 0.25, wideRatio: 2.5, content: '12345678' });
  assert.equal(itf.wideDots, 5, '2 点 × 2.5 = 5 点');
  assert.ok(!itf.warnings.some((w) => /整数模块|已忽略/.test(w)), itf.warnings.join('\n'));
  const c39 = computeGeometry({ sym: 'CODE39', dpi: 203, moduleWidthMm: 0.25, wideRatio: 3, content: 'ABC' });
  assert.equal(c39.wideDots, 6);
});

test('非固定比例-wideRatio 非有限值时按码制默认比例，绝不产出 NaN', () => {
  for (const bad of [NaN, undefined, null, Infinity, -Infinity]) {
    const g = computeGeometry({ sym: 'ITF', dpi: 203, moduleWidthMm: 0.25, wideRatio: bad as number, content: '12345678' });
    assert.equal(g.wideDots, 5, `wideRatio=${String(bad)} 应回落到 ITF 默认 2.5`);
    assert.doesNotMatch(JSON.stringify(g), /NaN/);
  }
});

test('默认宽窄比-CODE128/93=2、CODE39/CODABAR/MSI/ITF=2.5、EAN/UPC=1、未知=2', () => {
  assert.equal(defaultRatio('CODE128'), 2);
  assert.equal(defaultRatio('GS1_128'), 2);
  assert.equal(defaultRatio('CODE93'), 2);
  for (const s of ['CODE39', 'CODABAR', 'MSI', 'ITF', 'ITF14']) assert.equal(defaultRatio(s), 2.5, s);
  for (const s of ['EAN13', 'EAN8', 'UPC_A', 'UPC_E']) assert.equal(defaultRatio(s), 1, s);
  assert.equal(defaultRatio('QRCODE'), 2);
  // 别名同样生效（比例表按 normSym 之后判定）
  assert.equal(defaultRatio('itf-14'), 2.5);
  assert.equal(defaultRatio('2of5'), 2.5);
});

test('normSym-别名归一到能力矩阵用的大写全称（大小写、连字符、同义名都不能影响判定）', () => {
  const pairs: Array<[string, string]> = [
    ['code128', 'CODE128'], ['CODE-128', 'CODE128'], ['code-128', 'CODE128'],
    ['UCC128', 'GS1_128'], ['GS1-128', 'GS1_128'], ['gs1_128', 'GS1_128'],
    ['EAN-13', 'EAN13'], ['UPC-A', 'UPC'], ['UPCA', 'UPC'], ['UPCE', 'UPC_E'],
    ['2OF5', 'ITF'], ['Interleaved2of5', 'ITF'], ['ITF-14', 'ITF14'],
    ['NW7', 'CODABAR'], ['DM', 'DATAMATRIX'], ['QR', 'QRCODE'], ['2d', 'MICROQR'],
    ['MICRO_QR', 'MICROQR'], ['CODE-39', 'CODE39'],
  ];
  for (const [raw, want] of pairs) assert.equal(normSym(raw), want, `normSym(${raw})`);
  assert.equal(normSym(''), '');
  assert.equal(normSym(undefined as unknown as string), '');
  assert.equal(normSym(null as unknown as string), '');
});

// ---------------------------------------------------------------------------
// 4. 静区（按码制，不用统一 2mm）
// ---------------------------------------------------------------------------

test('静区-一维码按码制模块数：Code128 族 10、Code93 12、EAN/UPC 9、未知 10', () => {
  const mods = (sym: string, xMm = 0.25, dpi = 203) => {
    const g = computeGeometry({ sym, dpi, moduleWidthMm: xMm, content: '123456' });
    return g.quietDots / g.xDots;
  };
  for (const s of ['CODE128', 'GS1_128', 'CODE16K', 'CODE39', 'CODABAR', 'MSI', 'PHARMACODE', 'ITF', 'ITF14']) {
    assert.equal(mods(s), 10, `${s} 静区应为 10 模块`);
  }
  assert.equal(mods('CODE93'), 12);
  for (const s of ['EAN13', 'EAN8', 'UPC', 'UPC_A', 'UPC_E']) assert.equal(mods(s), 9, `${s} 由保护条/侧条承担`);
  assert.equal(mods('SOMETHING_UNKNOWN'), 10, '未知码制保守取 10');
  // 静区随 X-dim 等比放大（模块数固定，不是固定 mm）
  const g1 = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.25, content: 'ABC' });
  const g2 = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.5, content: 'ABC' });
  assert.equal(g1.quietDots, 20);
  assert.equal(g2.quietDots, 40, '2 倍 X-dim → 2 倍静区点数');
});

test('静区-用户请求小于规范要求时按规范放大并提示（不是照用户给的毫米数缩小）', () => {
  const g = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.25, quietZoneMm: 1, content: 'ABC' });
  assert.equal(g.quietDots, 20, '1mm=8 点 < 10 模块×2 点=20 点 → 保持 20');
  assert.ok(g.warnings.some((w) => /\[静区\].*已按规范放大/.test(w)), g.warnings.join('\n'));
  assert.ok(g.warnings.some((w) => /请求 1.00mm（8 点）/.test(w)), g.warnings.join('\n'));
});

test('静区-用户请求大于规范要求时尊重用户（放大不提示）', () => {
  const g = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.25, quietZoneMm: 10, content: 'ABC' });
  assert.equal(g.quietDots, 80, '10mm ÷ 0.125123 = 79.9 → 80 点');
  assert.ok(!g.warnings.some((w) => /\[静区\]/.test(w)), g.warnings.join('\n'));
});

test('静区-二维码制四周模块数：QR/MicroQR 4、PDF417/Aztec 2、DataMatrix 1、未知 2', () => {
  const q = (sym: string) => compute2dGeometry({ sym, dpi: 203 }).quietModules;
  assert.equal(q('QRCODE'), 4);
  assert.equal(q('MICROQR'), 4);
  assert.equal(q('PDF417'), 2);
  assert.equal(q('AZTEC'), 2);
  assert.equal(q('DATAMATRIX'), 1);
  assert.equal(q('DATAMATRIX_RECT'), 1);
  assert.equal(q('CODE128'), 2, '表外（含一维）回落 2');
  assert.equal(q('QR'), 4, '别名同样生效');
  assert.equal(q('DM'), 1);
});

test('二维模块点数-默认 0.4mm、不足 1 点抬到 1 点、1 点的二维符号提示清晰度风险', () => {
  const d = compute2dGeometry({ sym: 'DATAMATRIX', dpi: 203 });
  assert.equal(d.moduleDots, 3, '0.4 ÷ 0.125123 = 3.197 → 3 点');
  assert.deepEqual(d.warnings, []);
  const tiny = compute2dGeometry({ sym: 'DATAMATRIX', dpi: 203, moduleSizeMm: 0.05 });
  assert.equal(tiny.moduleDots, 1);
  assert.ok(tiny.warnings.some((w) => /不足 1 点/.test(w)), tiny.warnings.join('\n'));
  assert.ok(tiny.warnings.some((w) => /建议 ≥2 点.*定位图形清晰/.test(w)),
    'DataMatrix 1 点模块边缘会糊，必须提示：' + tiny.warnings.join('\n'));
  const badDpi = compute2dGeometry({ sym: 'QRCODE', dpi: 0 });
  assert.equal(badDpi.moduleDots, 3, 'dpi 非法回落 203');
});

// ---------------------------------------------------------------------------
// 5. GS1 25% 高度建议
// ---------------------------------------------------------------------------

test('高度-建议下限 = min(符号长度 × 25%, 10 × X-dim)，两个界取小而不是取大', () => {
  assert.equal(HEIGHT_RATIO_OF_LENGTH, 0.25);
  assert.equal(MIN_HEIGHT_MODULES, 10);
  // 短符号：10×X 更大 → 以 25% 长度为准；长符号：25% 更大 → 以 10×X 为准（取小 = 两个界里更宽松的）
  const probe = (heightMm: number, lenMm: number) =>
    computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.4, heightMm, symbolLengthMm: lenMm }).warnings;
  // 100mm 长符号：25% = 25mm，10×X = 3.75mm → 下限取 3.75mm
  assert.ok(probe(2, 100).some((w) => /低于该长度下建议下限 3\.75mm/.test(w)), probe(2, 100).join('\n'));
  assert.ok(probe(2, 100).some((w) => /长度 25% \/ 10 模块取小/.test(w)));
  assert.ok(probe(2, 100).some((w) => /符号长度按 100.0mm 估算/.test(w)), '提示要写出长度依据');
  assert.ok(probe(20, 100).every((w) => !/低于该长度下建议下限/.test(w)), '20mm > 3.75mm 不该提示');
  // 极短符号（2mm）：25% = 0.5mm < 10×X → 下限降到 0.5mm，2mm 高度不再被误判
  assert.ok(probe(2, 2).every((w) => !/低于该长度下建议下限/.test(w)), probe(2, 2).join('\n'));
});

test('高度-没给 heightMm 时按 8mm 兜底换算成点数（≥1 点），不影响提示', () => {
  const g = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.25, content: 'ABC' });
  assert.equal(g.heightDots, Math.round(8 / PITCH_203));
  const tall = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.25, heightMm: 20, content: 'ABC' });
  assert.equal(tall.heightDots, Math.round(20 / PITCH_203));
  // 负数/0 也走兜底，不产生 0 高度
  for (const bad of [0, -5, NaN]) {
    const b = computeGeometry({ sym: 'CODE128', dpi: 203, moduleWidthMm: 0.25, heightMm: bad, content: 'ABC' });
    assert.ok(b.heightDots >= 1, `heightMm=${String(bad)} → ${b.heightDots}`);
  }
});

test('高度-估不出符号长度的码制不猜长度，也不因此报高度提示', () => {
  // PHARMACODE / CODE16K / 二维：estimateModules 返回 0 → 跳过 25% 判定
  for (const sym of ['PHARMACODE', 'CODE16K', 'QRCODE', 'DATAMATRIX']) {
    assert.equal(estimateModules(sym, 'ABC'), 0, `${sym} 不该被猜长度`);
    const g = computeGeometry({ sym, dpi: 203, moduleWidthMm: 0.25, heightMm: 0.5, content: 'ABC' });
    assert.ok(!g.warnings.some((w) => /低于该长度下建议下限/.test(w)), `${sym}: ${g.warnings.join('\n')}`);
  }
});

// ---------------------------------------------------------------------------
// 6. 符号长度估算（含推导）
// ---------------------------------------------------------------------------

test('估算-CODE128 = 11n + 35（起始 11 + 数据 11n + 校验 11 + 终止 13）', () => {
  assert.equal(estimateModules('CODE128', 'ABC'), 3 * 11 + 35);
  assert.equal(estimateModules('CODE128', 'ABC'), 68);
  assert.equal(estimateModules('GS1_128', '011234567890123121SN0007'), 11 * 24 + 35, 'GS1 把 AI 数字也算字符');
  assert.equal(estimateModules('CODE128', 'A'), 46);
  // 单调性：多一个字符恰好多 11 模块
  assert.equal(estimateModules('CODE128', 'AB') - estimateModules('CODE128', 'A'), 11);
});

test('估算-EAN13/UPC_A=95、EAN8=67、UPC_E=51（规范定值，与数据无关）', () => {
  // EAN-13：3 + 6×7 + 5 + 6×7 + 3 = 95；EAN-8：3 + 4×7 + 5 + 4×7 + 3 = 67
  assert.equal(estimateModules('EAN13', '6901234567892'), 95);
  assert.equal(estimateModules('UPC_A', '012345678905'), 95);
  assert.equal(estimateModules('UPC', '012345678905'), 95);
  assert.equal(estimateModules('EAN8', '96385074'), 67);
  assert.equal(estimateModules('UPC_E', '01234565'), 51);
  // 固定比例码制的估算与 ratio 无关（1:1）
  assert.equal(estimateModules('EAN13', '6901234567892', 3.5), 95);
});

test('估算-CODE39 = (n+2)(6+3r)、CODABAR = (n+2)(5+2r)、CODE93 = 9(n+2)+9、ITF = 8+p(7+3r)', () => {
  assert.equal(estimateModules('CODE39', 'ABC', 2.5), 5 * (6 + 3 * 2.5)); // 67.5
  assert.equal(estimateModules('CODE39', 'ABC', 3), 5 * 15);              // 75
  assert.equal(estimateModules('CODABAR', 'A1234567B', 2.5), 11 * (5 + 2 * 2.5)); // 110（9 位数据 + 首尾各一）
  assert.equal(estimateModules('CODE93', 'ABC', 2), 9 * 5 + 9);           // 54
  assert.equal(estimateModules('ITF', '12345678', 2.5), 8 + 4 * (7 + 3 * 2.5)); // 66
  assert.equal(estimateModules('ITF14', '10012345600019', 2.5), 8 + 7 * 14.5, 'ITF-14 按 14 位=7 对');
  // 奇数位 ITF 向上取整成对（打印机会补 0，长度按补位后算）
  assert.equal(estimateModules('ITF', '1234567', 2.5), 8 + 4 * 14.5);
  assert.equal(estimateModules('MSI', '12345', 2.5), 12 * 7 + 4 * 2.5);
});

test('估算-宽窄比钳在 1.5–3.5 之间（与 computeGeometry 同一钳位，防止把非法比例放大成长度）', () => {
  assert.equal(estimateModules('CODE39', 'AB', 9), estimateModules('CODE39', 'AB', 3.5));
  assert.equal(estimateModules('CODE39', 'AB', 0.1), estimateModules('CODE39', 'AB', 1.5));
  assert.equal(estimateModules('CODE39', 'AB', 9), 4 * (6 + 3 * 3.5));
  assert.equal(estimateModules('CODE39', 'AB', 0.1), 4 * (6 + 3 * 1.5));
});

test('估算-ratio 传 NaN 时 modules 为 NaN、长度被吞成 0（如实记录：与「估不出来」走同一条静默路径）', () => {
  // Math.max(1.5, Math.min(3.5, NaN)) = NaN —— 钳位对 NaN 不设防，estimateModules 直接返回 NaN；
  // estimateSymbolLengthMm 的 `mods > 0` 判定把 NaN 归入「估不出来 → 返回 0」，
  // 于是 NaN 宽窄比与真估不出来的码制（PHARMACODE/二维）在提示层不可区分。
  // 后果有限（只影响 25% 高度建议，不影响指令数值），属可改进项：应在钳位前判 Number.isFinite。
  assert.ok(Number.isNaN(estimateModules('CODE39', 'AB', NaN)));
  assert.equal(estimateSymbolLengthMm('CODE39', 'AB', 0.5, NaN), 0);
  assert.equal(estimateSymbolLengthMm('PHARMACODE', 'AB', 0.5), 0, '同类静默路径的对照组');
  // 入口侧 computeGeometry 已经用 Number.isFinite 拦住了：指令数值里不会出现 NaN
  const g = computeGeometry({ sym: 'CODE39', dpi: 203, moduleWidthMm: 0.25, wideRatio: NaN, heightMm: 2, content: 'ABCDEFGHIJ' });
  assert.equal(g.wideDots, 5, 'NaN 比例回落 CODE39 默认 2.5');
  assert.doesNotMatch(JSON.stringify(g), /NaN/);
  assert.ok(g.warnings.every((w) => !w.includes('NaN')), g.warnings.join('\n'));
});

test('估算-空内容 / 表外码制返回 0，estimateSymbolLengthMm 同步返回 0', () => {
  assert.equal(estimateModules('CODE128', ''), 0);
  assert.equal(estimateModules('CODE128', undefined as unknown as string), 0);
  assert.equal(estimateModules('NOT_A_SYM', 'ABC'), 0);
  assert.equal(estimateSymbolLengthMm('NOT_A_SYM', 'ABC', 0.468), 0);
  assert.equal(estimateSymbolLengthMm('CODE128', '', 0.468), 0);
});

test('估算-symbolLengthMm = modules × 实际 X-dim（用量化后的点数，不是用户请求的 mm）', () => {
  const xMm = 3 * PITCH_203; // 0.4mm@203dpi 量化后 3 点
  assert.equal(estimateSymbolLengthMm('EAN13', '6901234567892', xMm, 1), 95 * xMm);
  assert.ok(Math.abs(estimateSymbolLengthMm('EAN13', '6901234567892', xMm, 1) - 35.63) < 0.05);
  // 默认比例 2.5 与 computeGeometry 内部调用一致
  assert.equal(estimateSymbolLengthMm('CODE39', 'ABC', 0.5), estimateModules('CODE39', 'ABC', 2.5) * 0.5);
});

// ---------------------------------------------------------------------------
// 7. 旋转后明文贴靠边（B4 的正解）
// ---------------------------------------------------------------------------

test('明文贴靠-符号坐标系随旋转换算，bottom/top 与 left/right 成对出现', () => {
  assert.equal(textSideFor(0, 'bottom'), 'bottom');
  assert.equal(textSideFor(90, 'bottom'), 'left');
  assert.equal(textSideFor(180, 'bottom'), 'top');
  assert.equal(textSideFor(270, 'bottom'), 'right');
  assert.equal(textSideFor(0, 'top'), 'top');
  assert.equal(textSideFor(90, 'top'), 'right');
  assert.equal(textSideFor(180, 'top'), 'bottom');
  assert.equal(textSideFor(270, 'top'), 'left');
  // 4×2 的全集必须落在四个边上且不重复（每个方向各出现两次）
  const all: string[] = [];
  for (const r of [0, 90, 180, 270] as const) { all.push(textSideFor(r, 'bottom'), textSideFor(r, 'top')); }
  assert.deepEqual(new Set(all).size, 4);
  for (const s of all) assert.ok(['bottom', 'top', 'left', 'right'].includes(s), s);
});

test('明文贴靠-left/right 需要按「宽=条码高度」绘制，bottom/top 不需要', () => {
  assert.equal(isVerticalTextSide('left'), true);
  assert.equal(isVerticalTextSide('right'), true);
  assert.equal(isVerticalTextSide('bottom'), false);
  assert.equal(isVerticalTextSide('top'), false);
  // 与 textSideFor 组合：90°/270° 旋转必然触发竖向绘制，0°/180° 不会
  for (const r of [0, 180] as const) {
    assert.equal(isVerticalTextSide(textSideFor(r, 'bottom')), false);
  }
  for (const r of [90, 270] as const) {
    assert.equal(isVerticalTextSide(textSideFor(r, 'bottom')), true);
  }
});

// ---------------------------------------------------------------------------
// 8. 位图抽稀的偶数点阵约束（raster.ts）—— 分两档：能上调就上调，不能就抛
//
// 背景（实测）：bwip 的 PDF417 在 scale=1 时出 120×21，行高方向天然是奇数倍。
// 于是 moduleDots 取奇数（203dpi 的 0.4/0.6mm、300dpi 的 0.4/0.6/0.8mm）就会得到
// 396×99 这种奇数边点阵。旧实现直接抛错 ⇒ 「300dpi 上 0.4/0.6/0.8mm 的 PDF417 全打不出」。
// 现在按 requested → +1 → +2 重出图取第一个偶数档位；三档都失败才抛。
// 绝不重采样/多数表决：那等于把「预览能扫、打印糊掉」的半模块灰边重新请回来。
// ---------------------------------------------------------------------------

const rasterSrc = readFileSync(join(__dirname, '..', 'raster.ts'), 'utf8');
const rasterFrom = rasterSrc.indexOf('export async function qrcodeMonoRaster');
const rasterTo = rasterSrc.indexOf('/** 任意来源位图', rasterFrom);
/** qrcodeMonoRaster + 它调用的 monoRasterAtDots（两者在同一段里，直到 imageMonoRaster） */
const rasterBody = rasterSrc.slice(rasterFrom, rasterTo > 0 ? rasterTo : rasterSrc.length);

test('抽稀①-奇数档位必须自动上调重出，且把模板请求值记进 moduleDotsRequested（不改变换因子）', () => {
  assert.ok(rasterFrom > 0 && rasterBody.length > 400, '未找到 qrcodeMonoRaster / monoRasterAtDots 段');
  // 重试阶梯：requested → requested+1 → requested+2，取第一个 ok
  assert.match(rasterBody, /for \(let dots = requested; dots <= requested \+ 2; dots\+\+\)/,
    '阶梯必须是 +0/+1/+2 三档（封顶两档：再多就是配置错了，不该吃进出图性能）');
  assert.match(rasterBody, /if \(r\.ok\) return/, '拿到偶数点阵就立刻返回，不得继续重出');
  // 上调过才标记；没上调（绝大多数情况）必须保持返回值干净，否则每条 warning 都是噪音
  assert.match(rasterBody, /raster\.moduleDots === requested\s*\?\s*r\.raster\s*:\s*\{ \.\.\.r\.raster, moduleDotsRequested: requested \}/,
    '只有真上调了才写 moduleDotsRequested（写错方向 = 每次都告警 = 用户学会忽略告警）');
  // 出图侧：2× 超采样 + padding 按「模块数 × 每模块点数」下发，档位变了静区也同步变
  assert.match(rasterBody, /pxPerModule: [^\n]*\* 2/, 'bwip 按 2× 模块出图，抽稀因子恒为 2');
  assert.match(rasterBody, /paddingUnits: [^\n]*quietModules[^\n]*moduleDots/,
    '静区按「模块数 × 每模块点数」下发；上调档位时静区必须跟着放大，否则静区物理尺寸会缩水');
  assert.match(rasterBody, /const w = sw \/ 2, h = sh \/ 2/, '抽稀 = 隔行隔列取点');
  assert.match(rasterBody, /img\.data\[\(y \* 2\) \* sw \+ \(x \* 2\)\]/,
    '取点起点必须是 (0,0) 偶格：偏移一格就把模块边界劈成两半');
  // 奇数边的判定必须两条边都查，且是**返回 ok:false**（让上层继续下一档），不是就地抛
  assert.match(rasterBody, /sw % 2 !== 0 \|\| sh % 2 !== 0/, '必须同时校验宽高两条边（只查一条会漏掉 12×13 这种）');
  assert.match(rasterBody, /return \{ ok: false, error: /,
    '奇数边在档位函数里返回 ok:false（抛在这里就没机会试下一档了）');
  // 绝不允许的替代实现：重采样 / 求平均 / 多数表决
  assert.doesNotMatch(rasterBody, /\.resize\(/, '2D 通道不得走 sharp resize（重采样会破坏模块边界，扫得出但边界糊）');
  assert.doesNotMatch(rasterBody, /threshold\(/, '抽稀路径不得再二值化：二值化只属于 image 元素的任意位图通道');
  assert.doesNotMatch(rasterBody, /averag|mean|majority|表决/, '不得用求平均/多数表决凑偶数（半模块灰边的来源）');
});

test('抽稀②-三档都拿不到偶数点阵必须抛错，上层跳过该元素（宁可不打，不打错码）', () => {
  assert.match(rasterBody, /throw new Error\(`位图点阵无法无损抽稀/,
    '三档全失败必须抛错，绝不返回半模块图');
  // 报错文案要能定位：码制 + dpi + 起始档位 + 「其后两档」+ 底层原因
  assert.match(rasterBody, /位图点阵无法无损抽稀：\$\{sym\} 在 \$\{requested\} 点\/模块及其后两档都拿不到偶数点阵/,
    `文案必须含码制/起始档位/重试范围，否则线上只看到一句"抽稀失败"`);
  assert.match(rasterBody, /\$\{lastErr\}/, '必须把最后一档的底层原因带上（奇数边尺寸是排查的唯一线索）');
  // 抛错后上层的方向：跳过该元素 + 如实 warning，绝不回落原生指令、绝不换成别的码制
  const attach = rasterSrc.slice(rasterSrc.indexOf('export async function attachBitmapFallbacks'));
  assert.match(attach, /catch \(e: any\)/, 'attachBitmapFallbacks 必须兜住出图异常');
  assert.match(attach, /点阵生成失败/, 'warning 要说清是「点阵生成失败」而不是「码制不支持」');
  assert.match(attach, /该元素将被跳过（宁可不打，不打错码）/, '必须如实声明跳过，不允许静默降级');
  assert.doesNotMatch(attach.slice(0, attach.indexOf('if (el.type === \'image\')')),
    /planChannel\([^)]*\)\s*===\s*'native'/, '出图失败不得回头改用原生指令（那就是静默换码制）');
});

test('抽稀③-上调档位必须如实发 warning（X-dim 略大于模板值），且只在真上调时发', () => {
  const attach = rasterSrc.slice(rasterSrc.indexOf('export async function attachBitmapFallbacks'));
  // 判据是 requested ≠ 实际，而不是「requested 有值」——写错这条会让每次位图元素都刷一条假 warning
  assert.match(attach, /raster\.moduleDotsRequested !== undefined && raster\.moduleDotsRequested !== raster\.moduleDots/,
    '只有档位确实被上调过才发 warning');
  assert.match(attach, /每模块点数由 \$\{raster\.moduleDotsRequested\} 点上调到 \$\{raster\.moduleDots\} 点/,
    'warning 必须给出「从几点到几点」，只说"已调整"等于没说');
  assert.match(attach, /X-dim 略大于模板值/, '必须说明副作用是 X-dim 变大：这是用户看得见的尺寸偏差');
  assert.match(attach, /奇数点阵|隔行隔列抽稀会切掉半个模块/, '必须说明原因，否则排查方向会被引去改码制表');
});

test('抽稀-真实 bwip 出图的偶数性与可扫性由验收脚本 C 段验证（单元测试不拉 sharp/bwip）',
  { skip: '需要 @bwip-js / sharp + 解码器：见 backend/scripts/p7-acceptance.sh C 段——C.7 实测「奇数档位 → 自动上调 → moduleDotsRequested + warning」，C.2/C.3 验证点阵全偶数、PNG↔hex 逐位一致，C.4/C.5 用 zxing-cpp / cv2 真解码' },
  () => { /* 占位：真正跑图在验收脚本里 */ });
