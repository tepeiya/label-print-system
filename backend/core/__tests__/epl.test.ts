// =============================================================================
// epl.test.ts —— P7.7 EPL2 生成器单测（纯函数）
//
// 本轮按 coordinator 要求改成**自包含交付**：生成器只 import `./types`，
// 因此本单测也**不 import barcode-caps / barcode-geometry / bitmap-blocks / gs1 / raster**，
// 点阵一律手写字面量（raster() 函数造的就是 BitmapFallback 结构的字面量）。
// 仓库硬规定：单测不引入 TypeORM 实体 / Nest 模块，也不碰网络与打印机。
// 覆盖（任务要求第 6 条）：
//   1) 查证到的码制 → 输出正确的 B 指令片段（类型码 + 参数顺序）
//   2) 查证不到的码制 → 只有 warnings，指令里不含任何伪造内容（不打 b、不打 X/LO）
//   3) GW 图形指令的字节宽度对齐（每行字节数 × 行数 = 载荷字节数，hex→latin1 不变形）
//   4) 中文文本 → warning
//   5) 页面头尾 / 坐标换算 / 参数钳制 / 不抛异常 / 无网络与打印机依赖
//   6) 自包含审计表 EPL_SYM_STATUS 与硬编码码制全集、与本地类型码表的一致性守卫
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  generateEpl, eplGraphic, eplInvertHex, hexToLatin1, mmToDots, normSym,
  EPL_BARCODE_TYPES, EPL_SYM_STATUS, EPL_GRAPHIC_COMMAND, EPL_GW_POLARITY,
  type EplElement, type EplPage,
} from '../epl-generator';
import type { BarcodeSpec, BitmapFallback, QrcodeSpec } from '../types';

const DPI = 203;
const PAGE: EplPage = { widthMm: 60, heightMm: 40, gapMm: 2 };

/** 一维码 spec（默认值与模板缺省一致） */
function bc(sym: string, content: string, over: Partial<BarcodeSpec> = {}): EplElement {
  const spec: BarcodeSpec = {
    sym, content, moduleWidthMm: 0.4, wideRatio: 2.5, heightMm: 12,
    showText: false, textPosition: 'bottom', ...over,
  };
  return { type: 'barcode', xMm: 10, yMm: 20, barcode: spec };
}

function qr(content: string, fallback?: BitmapFallback): EplElement {
  const spec: QrcodeSpec = { sym: 'QRCODE', content, ecc: 'M', moduleSizeMm: 0.5, quietZoneMm: 1 };
  return { type: 'qrcode', xMm: 40, yMm: 5, qrcode: spec, fallback };
}

/** 造点阵字面量：hex 逐行拼接，避免 0D/0A/2C 这些会混进指令文本的字节 */
function raster(rowsHex: string[]): BitmapFallback {
  const bytesPerRow = rowsHex[0].length / 2;
  return {
    widthDots: bytesPerRow * 8,
    heightDots: rowsHex.length,
    bytesPerRow,
    hex: rowsHex.join(''),
    moduleDots: 2,
  };
}

/** 取指令行（去掉页头页尾），lines[0] 一定是 'N' */
function cmds(text: string): string[] {
  return text.split('\r\n').filter((l) => l.length > 0);
}

/** 解析 B 指令：返回 p1..p8 与 DATA */
function parseB(text: string) {
  const line = cmds(text).find((l) => /^B\d/.test(l));
  if (!line) return undefined;
  const q = line.indexOf('"');
  return { line, p: line.slice(1, q - 1).split(','), data: line.slice(q + 1, line.length - 1) };
}

/** 解析 A 指令：返回 p1..p7 与 DATA */
function parseA(text: string) {
  const line = cmds(text).find((l) => /^A\d/.test(l));
  if (!line) return undefined;
  const q = line.indexOf('"');
  return { line, p: line.slice(1, q - 1).split(','), data: line.slice(q + 1, line.length - 1) };
}

/** 解析图形指令头部（载荷是二进制，只按前 4 个数值参数切） */
function parseGw(text: string) {
  const line = text.split('\r\n').find((l) => l.startsWith(EPL_GRAPHIC_COMMAND));
  if (!line) return undefined;
  const m = new RegExp(`^${EPL_GRAPHIC_COMMAND}(\\d+),(\\d+),(\\d+),(\\d+),`).exec(line);
  if (!m) return undefined;
  return { line, x: +m[1], y: +m[2], widthBytes: +m[3], rows: +m[4], payload: line.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// 1. 页面头 / 页尾 / 坐标换算
// ---------------------------------------------------------------------------
test('EPL 页头页尾：N → q(宽) → Q(长,间距) → 元素 → P，行尾 CR LF 且首尾补换行', () => {
  const { text, warnings } = generateEpl([], DPI, PAGE);
  assert.equal(text, '\r\nN\r\nq480\r\nQ320,16\r\nP1\r\n'); // 60mm=480 点、40mm=320 点、2mm=16 点
  assert.equal(mmToDots(60, DPI), 480);
  assert.equal(mmToDots(40, DPI), 320);
  assert.deepEqual(warnings, []);
});

test('EPL 页头可选命令：D（密度）、S（速度）、P（份数）按调用方给值输出；非整数忽略并 warning', () => {
  const ok = generateEpl([], DPI, { ...PAGE, density: 10, speed: 2, copies: 3 });
  assert.ok(ok.text.includes('\r\nD10\r\n'), ok.text);
  assert.ok(ok.text.includes('\r\nS2\r\n'), ok.text);
  assert.ok(ok.text.endsWith('\r\nP3\r\n'), ok.text);

  const bad = generateEpl([], DPI, { ...PAGE, density: 1.5, speed: -1 });
  assert.ok(!bad.text.includes('D'), '非法 density 不应产生 D 指令');
  assert.ok(!/S/.test(bad.text), '非法 speed 不应产生 S 指令');
  assert.equal(bad.warnings.filter((w) => /D 指令已忽略/.test(w)).length, 1);
  assert.equal(bad.warnings.filter((w) => /S 指令已忽略/.test(w)).length, 1);
});

test('EPL 打印方向：180 出 ZB；90/270 查证不到等价设置 → 不出指令并 warning（第 4 个参数优先于 page.orientation）', () => {
  const z180 = generateEpl([], DPI, { ...PAGE, orientation: 180 });
  assert.ok(z180.text.includes('\r\nZB\r\n'), z180.text);
  assert.deepEqual(z180.warnings, []);

  for (const o of [90, 270] as const) {
    const r = generateEpl([], DPI, { ...PAGE, orientation: o });
    assert.ok(!r.text.includes('Z'), `orientation=${o} 不应猜出 Z 指令`);
    assert.ok(r.warnings.some((w) => /\[版式\] 走纸方向/.test(w)), `orientation=${o} 应有 warning`);
  }
  // 第 4 个参数覆盖 page.orientation
  const override = generateEpl([], DPI, { ...PAGE, orientation: 180 }, 0);
  assert.ok(!override.text.includes('ZB'), override.text);
  const viaArg = generateEpl([], DPI, PAGE, 180);
  assert.ok(viaArg.text.includes('\r\nZB\r\n'), viaArg.text);
});

test('EPL 元素坐标按 dots=mm*dpi/25.4 换算（B/A 的 p1,p2）', () => {
  const { text } = generateEpl([bc('CODE128', 'ABC123')], DPI, PAGE);
  const b = parseB(text)!;
  assert.equal(b.p[0], String(mmToDots(10, DPI)));  // 80
  assert.equal(b.p[1], String(mmToDots(20, DPI)));  // 160
  assert.equal(b.p[0], '80');
  assert.equal(b.p[1], '160');
});

// ---------------------------------------------------------------------------
// 2. 一维码：查证到类型码的码制 → 正确的 B 指令片段
// ---------------------------------------------------------------------------
test('EPL B 指令参数顺序：B p1,p2,p3,p4(类型码),p5(窄条),p6(宽条),p7(高度),p8(B/N),"DATA"', () => {
  const { text } = generateEpl([bc('CODE128', 'ABC123', { showText: true })], DPI, PAGE);
  const b = parseB(text)!;
  assert.equal(b.p.length, 8);
  assert.equal(b.p[2], '0');            // 旋转
  assert.equal(b.p[3], '1');            // Code 128 auto A,B,C → 类型码 1
  assert.ok(Number(b.p[4]) >= 1 && Number(b.p[4]) <= 10, 'p5 窄条宽须在 Table 2-1 的 1–10 内');
  assert.ok(Number(b.p[5]) >= 2 && Number(b.p[5]) <= 30, 'p6 宽条宽须在 2–30 内');
  assert.ok(Number(b.p[5]) >= Number(b.p[4]), 'p6 宽条必须 ≥ p5 窄条');
  assert.ok(Number(b.p[6]) >= 1, 'p7 条码高度（点）');
  assert.equal(b.p[7], 'B');            // showText → 打印可读文本
  assert.equal(b.data, 'ABC123');
});

test('EPL 一维码类型码全覆盖：与查证到的 Table 2-1 一致', () => {
  const expect: Record<string, string> = {
    CODE128: '1', CODE39: '3', CODE93: '9', EAN13: 'E30', EAN8: 'E80',
    UPC: 'UA0', UPC_A: 'UA0', UPC_E: 'UE0', ITF: '2', ITF14: '2', CODABAR: 'K',
  };
  const content: Record<string, string> = {
    CODE128: 'X1', CODE39: 'ABC', CODE93: 'ABC', EAN13: '123456789012', EAN8: '1234567',
    UPC: '012345678901', UPC_A: '012345678901', UPC_E: '04252711', ITF: '1234', ITF14: '1234567890123',
    CODABAR: 'A12345B',
  };
  for (const [sym, type] of Object.entries(expect)) {
    const { text, warnings } = generateEpl([bc(sym, content[sym])], DPI, PAGE);
    const b = parseB(text);
    assert.ok(b, `${sym} 应输出 B 指令`);
    assert.equal(b!.p[3], type, `${sym} 的类型码应为 ${type}`);
    assert.equal(EPL_BARCODE_TYPES[sym].type, type);
    assert.ok(!warnings.some((w) => /无法原生输出/.test(w)), `${sym} 不该出现「无法原生输出」`);
  }
});

test('EPL EAN/UPC 的 p5 窄条宽被钳到 Table 2-1 的 2–4 点', () => {
  const el = bc('EAN13', '123456789012', { moduleWidthMm: 0.1 });  // 1 点 < 下限 2
  const { text, warnings } = generateEpl([el], DPI, PAGE);
  const narrow = Number(parseB(text)!.p[4]);
  assert.equal(narrow, 2);
  assert.ok(warnings.some((w) => /低于 EPL2 p5 下限 2 点/.test(w)), warnings.join('\n'));
});

test('EPL 固定比例码制（EAN/UPC/Code128/Code93）明确告知 p6 会被固件忽略', () => {
  const { warnings } = generateEpl([bc('EAN13', '123456789012', { wideRatio: 3 })], DPI, PAGE);
  assert.ok(warnings.some((w) => /p6（宽条宽）为固件固定值/.test(w)), warnings.join('\n'));
});

test('EPL 校验位：Code39 用 3C、ITF 用 2C（Table 2-1 里确实存在的带校验类型码）', () => {
  const c39 = generateEpl([bc('CODE39', 'ABC', { checksum: true })], DPI, PAGE);
  assert.equal(parseB(c39.text)!.p[3], '3C');
  assert.ok(c39.warnings.some((w) => /\[校验位\].*3C/.test(w)), c39.warnings.join('\n'));

  const itf = generateEpl([bc('ITF', '1234', { checksum: true })], DPI, PAGE);
  assert.equal(parseB(itf.text)!.p[3], '2C');

  // Code128/Code93 没有「自动加校验位」的独立类型码：如实说明，不改类型码
  const c128 = generateEpl([bc('CODE128', 'ABC123', { checksum: true })], DPI, PAGE);
  assert.equal(parseB(c128.text)!.p[3], '1');
  assert.ok(c128.warnings.some((w) => /\[校验位\]/.test(w)), c128.warnings.join('\n'));
});

test('EPL ITF14 用交叉二五码 2 承载时给出等价性差异说明（degraded）', () => {
  const { text, warnings } = generateEpl([bc('ITF14', '1234567890123')], DPI, PAGE);
  assert.equal(parseB(text)!.p[3], '2');
  assert.ok(warnings.some((w) => /ITF-14 的边框|无 ITF-14 类型码/.test(w)), warnings.join('\n'));
  // 审计表里这一行必须提醒矩阵标 degraded（本表枚举没有 degraded）
  assert.match(EPL_SYM_STATUS.ITF14.note, /矩阵请标 \*\*degraded\*\*/);
});

test('EPL 可读文本位置：showText=false → p8=N；要求置顶时如实说明只能印在下方', () => {
  assert.equal(parseB(generateEpl([bc('CODE39', 'ABC')], DPI, PAGE).text)!.p[7], 'N');
  const top = generateEpl([bc('CODE39', 'ABC', { showText: true, textPosition: 'top' })], DPI, PAGE);
  assert.equal(parseB(top.text)!.p[7], 'B');
  assert.ok(top.warnings.some((w) => /p8 只有 B（打印在条码下方）/.test(w)), top.warnings.join('\n'));
});

test('EPL 元素 rotation → B 的 p3（0/1/2/3 = 0°/90°/180°/270°）', () => {
  for (const [deg, p3] of [[0, '0'], [90, '1'], [180, '2'], [270, '3']] as const) {
    const el = { ...bc('CODE39', 'ABC'), rotation: deg };
    assert.equal(parseB(generateEpl([el], DPI, PAGE).text)!.p[2], p3);
  }
});

test('EPL EAN13 位数不合规时不打指令（不交给固件猜）', () => {
  const { text, warnings } = generateEpl([bc('EAN13', '12345')], DPI, PAGE);
  assert.equal(parseB(text), undefined);
  assert.ok(warnings.some((w) => /要求 12–13 位/.test(w)), warnings.join('\n'));

  const notDigits = generateEpl([bc('EAN13', '1234567890AB')], DPI, PAGE);
  assert.equal(parseB(notDigits.text), undefined);
  assert.ok(notDigits.warnings.some((w) => /含非数字字符/.test(w)), notDigits.warnings.join('\n'));
});

// ---------------------------------------------------------------------------
// 3. 查证不到的码制 → 只有 warnings，指令里不含任何伪造内容
// ---------------------------------------------------------------------------
test('EPL 未查证到的码制只出 warning：无 B 指令、无降级内容、页头页尾仍在', () => {
  const cases: Array<[string, RegExp]> = [
    ['GS1_128', /1E/],                    // 有类型码但 FNC1 写法未查证 → 不打
    ['MSI', /MSI-3/],                     // 只有 M/L，与本产品 MSI 不等价 → 不打
    ['PHARMACODE', /手册无此指令/],
    ['CODE16K', /手册无此指令/],
    ['NOT_A_SYM', /不在 EPL2 类型码表/],
  ];
  for (const [sym, re] of cases) {
    const { text, warnings } = generateEpl([bc(sym, '12345678')], DPI, PAGE);
    assert.equal(cmds(text).filter((l) => /^B\d/.test(l)).length, 0, `${sym} 不应产生 B 指令`);
    assert.equal(warnings.filter((w) => /\[码制\]/.test(w)).length, 1, `${sym} 应恰好一条码制 warning`);
    assert.match(warnings.find((w) => /\[码制\]/.test(w))!, re, `${sym} 的 warning 要说清原因`);
    assert.ok(text.includes('\r\nN\r\n') && text.endsWith('P1\r\n'), `${sym} 时页头页尾仍需完整`);
    // 不允许把 ZPL/TSPL 的指令借过来凑数
    assert.doesNotMatch(text, /\^BC|\^BQ|BARCODE|QRCODE/);
  }
});

test('EPL GS1_128 不得把 (AI) 原样塞进任何指令（静默错码是仓库红线），但要把 AI 结构写进 warning', () => {
  const { text, warnings } = generateEpl([bc('GS1_128', '(01)12345678901231(10)ABC')], DPI, PAGE);
  assert.doesNotMatch(text, /1E/);
  assert.doesNotMatch(text, /\(01\)/);
  const w = warnings.find((x) => /\[码制\]/.test(x))!;
  assert.match(w, /FNC1/);
  // (AI) 诊断：01 定长、10 变长（变长后面还有字段就必须插 FNC1，而这正是查证不到的写法）
  assert.match(w, /检出 2 个 \(AI\)/);
  assert.match(w, /定长 01/);
  assert.match(w, /变长 10/);
  assert.ok(warnings.some((x) => /建议：①改用 ZPL/.test(x)), 'warning 必须给可执行出路');
});

test('EPL 单个元素不支持不影响其它元素（能打多少打多少）', () => {
  const els: EplElement[] = [
    { type: 'text', xMm: 5, yMm: 5, text: 'LOT 1', fontHeightMm: 3 },
    bc('MSI', '1234567'),
    bc('CODE128', 'OK123'),
  ];
  const { text, warnings } = generateEpl(els, DPI, PAGE);
  assert.ok(parseA(text), '文本应输出');
  assert.equal(parseB(text)!.data, 'OK123', '只应保留查证到的码制');
  assert.ok(warnings.some((w) => /\[码制\].*MSI/.test(w)));
});

// ---------------------------------------------------------------------------
// 3b. 数据字段永不省略（coordinator 的坑 2：省略数据段会打印上一次缓存的符号）
// ---------------------------------------------------------------------------
test('EPL 数据字段永不省略：A/B 行必带 "DATA"，内容为空时整条元素不打（绝不发 B...,""）', () => {
  const els: EplElement[] = [
    { type: 'text', xMm: 5, yMm: 5, text: 'ABC', fontHeightMm: 3 },
    bc('CODE39', 'ABC'),
    qr('HELLO', raster(['F0F0', '0F0F'])),
  ];
  const { text } = generateEpl(els, DPI, PAGE);
  for (const line of cmds(text)) {
    if (!/^[AB]\d/.test(line)) continue;
    // 语法串必须带数据字段：以 ," 开头、以 " 结尾，且字段非空（[S] 的 A/B 语法都以 ,"Data" 收尾）
    assert.ok(line.endsWith('"') && line.includes(',"'), `缺数据字段：${line}`);
    assert.ok(!line.endsWith(',""'), `数据字段不得为空：${line}`);
  }
  // 空内容 ⇒ 不打指令（不是打一条空数据段的指令）
  const empty = generateEpl([bc('CODE39', '   ')], DPI, PAGE);
  assert.equal(cmds(empty.text).filter((l) => /^B\d/.test(l)).length, 0);
  assert.doesNotMatch(empty.text, /,""/, '绝不下发空数据段');
  assert.ok(empty.warnings.some((w) => /\[数据\].*内容为空/.test(w)), empty.warnings.join('\n'));
});

// ---------------------------------------------------------------------------
// 4. 二维码 / 图像：图形指令的字节宽度对齐
// ---------------------------------------------------------------------------
test('EPL 二维码无原生语法可引用：拿不到 fallback 时不打 b、不打图形指令，只给可执行建议', () => {
  const { text, warnings } = generateEpl([qr('https://example.com')], DPI, PAGE);
  assert.doesNotMatch(text, /GW/);
  assert.doesNotMatch(text, /^b\d/m);
  assert.equal(warnings.filter((w) => /\[码制\]/.test(w)).length, 1);
  assert.match(warnings[0], /b（\[M\] p\.3-20/);
  assert.match(warnings[0], /建议：①改用 ZPL 或 TSPL 协议/);
  assert.match(warnings[0], /protocol=image/);
});

test('EPL GW 指令：p3=每行字节数、p4=行数，载荷字节数与头部声明严格一致', () => {
  const fb = raster(['F0F0', '0F0F', 'CCCC', '3333']);   // 2 字节/行 × 4 行
  const { text, warnings } = generateEpl([qr('HELLO', fb)], DPI, PAGE);
  const g = parseGw(text)!;
  assert.ok(g, '应输出图形指令');
  assert.equal(EPL_GRAPHIC_COMMAND, 'GW');                // 指令名：[M] 目录只有 GG/GI/GK/GM/GW
  assert.equal(g.widthBytes, fb.bytesPerRow);             // 与 bitmap-blocks.eplGraphicSize 同一结论
  assert.equal(g.rows, fb.heightDots);
  assert.equal(Buffer.from(g.payload, 'latin1').length, g.widthBytes * g.rows);
  assert.deepEqual(Buffer.from(g.payload, 'latin1'), Buffer.from(fb.hex, 'hex'));
  assert.equal(g.x, mmToDots(40, DPI));
  assert.equal(g.y, mmToDots(5, DPI));
  assert.ok(warnings.some((w) => /\[位图\].*GW 图形指令下发/.test(w)), warnings.join('\n'));
  assert.ok(warnings.some((w) => /latin1\/binary 逐字节写出/.test(w)), '必须提示载荷是二进制，不能按 utf8 发');
  // DATA 是原始字节而不是 ASCII hex：同一行里载荷长度 = 声明字节数（若是 hex 会是 2 倍）
  assert.ok(g.payload.length < fb.hex.length, '载荷应为字节而非 hex 文本');
});

test('EPL GW 位极性按仓内点阵口径（1=墨）输出，翻转收敛为常量 + 函数', () => {
  assert.equal(EPL_GW_POLARITY, 'mark-is-1');
  const fb = raster(['F0', '0F']);
  const warns: string[] = [];
  const line = eplGraphic(fb, 0, 0, DPI, warns, 'QRCODE');
  assert.deepEqual(Buffer.from(parseGw(line)!.payload, 'latin1'), Buffer.from(fb.hex, 'hex'));
  assert.ok(warns.some((w) => /位极性/.test(w) && /EPL_GW_POLARITY/.test(w)), warns.join('\n'));
  // eplInvertHex 是按位取反、不改变行/列序与长度；两次取反回到原值
  assert.equal(eplInvertHex(fb.hex), '0FF0');
  assert.equal(eplInvertHex(eplInvertHex(fb.hex)), fb.hex);
});

test('EPL hexToLatin1 逐字节还原（含 ≥0x80 的字节，一个 hex 字节 = 一个 char code）', () => {
  const hex = '81FF7F01';
  const s = hexToLatin1(hex);
  assert.equal(s.length, 4);
  assert.deepEqual([...s].map((c) => c.charCodeAt(0)), [0x81, 0xff, 0x7f, 0x01]);
  assert.equal(Buffer.from(s, 'latin1').toString('hex').toUpperCase(), hex);
  // utf8 会把 ≥0x80 的字节翻倍——这正是 warning 要防的事
  assert.ok(Buffer.from(s, 'utf8').length > s.length);
});

test('EPL 图形点阵长度与头部不符时如实 warning 并按头部截齐（不下发多出的字节）', () => {
  const fb = { ...raster(['F0F0', '0F0F']), hex: 'F0F0F0F0FF' }; // 5 字节，声明 2×2=4
  const warns: string[] = [];
  const line = eplGraphic(fb, 0, 0, DPI, warns, 'QRCODE');
  assert.ok(warns.some((w) => /点阵数据长度异常/.test(w)), warns.join('\n'));
  const m = /^GW0,0,2,2,/.exec(line)!;
  assert.equal(Buffer.from(line.slice(m[0].length), 'latin1').length, 4);
});

test('EPL image 元素同样走图形指令；未预置点阵时跳过并给出路', () => {
  const noFb = generateEpl([{ type: 'image', xMm: 5, yMm: 5, imgWmm: 10, imgHmm: 10 }], DPI, PAGE);
  assert.doesNotMatch(noFb.text, /GW/);
  assert.ok(noFb.warnings.some((w) => /\[图像\]/.test(w) && /protocol=image/.test(w)), noFb.warnings.join('\n'));

  const fb = raster(['AAAA', '5555']);
  const withFb = generateEpl([{ type: 'image', xMm: 5, yMm: 5, fallback: fb }], DPI, PAGE);
  const g = parseGw(withFb.text)!;
  assert.equal(g.widthBytes, 2);
  assert.equal(g.rows, 2);
});

// ---------------------------------------------------------------------------
// 5. 文本：A 指令 / 中文 / 转义
// ---------------------------------------------------------------------------
test('EPL 拉丁文本：A p1,p2,p3,p4(字体 1–5),p5,p6,p7,"DATA"，膨胀系数取合法值', () => {
  const { text, warnings } = generateEpl([{ type: 'text', xMm: 5, yMm: 6, text: 'Hello Zebra', fontHeightMm: 3 }], DPI, PAGE);
  const a = parseA(text)!;
  assert.equal(a.p.length, 7);
  assert.equal(a.p[0], String(mmToDots(5, DPI)));
  assert.equal(a.p[1], String(mmToDots(6, DPI)));
  assert.equal(a.p[2], '0');
  assert.ok(['1', '2', '3', '4', '5'].includes(a.p[3]), `内置拉丁字体 p4 只能是 1–5，实得 ${a.p[3]}`);
  assert.ok(['1', '2', '3', '4', '5', '6', '8'].includes(a.p[4]), `p5 水平膨胀合法取值 1–6 与 8，实得 ${a.p[4]}`);
  assert.ok(Number(a.p[5]) >= 1 && Number(a.p[5]) <= 9, 'p6 垂直膨胀 1–9');
  assert.equal(a.p[6], 'N');
  assert.equal(a.data, 'Hello Zebra');
  assert.ok(!warnings.some((w) => /无法/.test(w)), warnings.join('\n'));
});

test('EPL 文本反白用 p7=R；colorInvert 缺省为 N', () => {
  assert.equal(parseA(generateEpl([{ type: 'text', xMm: 1, yMm: 1, text: 'A', colorInvert: true }], DPI, PAGE).text)!.p[6], 'R');
  assert.equal(parseA(generateEpl([{ type: 'text', xMm: 1, yMm: 1, text: 'A' }], DPI, PAGE).text)!.p[6], 'N');
});

test('EPL 中文文本：出 A 指令（双字节字体 p4=8）并 warning 说明字库与码页依赖', () => {
  const { text, warnings } = generateEpl([{ type: 'text', xMm: 5, yMm: 5, text: '产品批次 A1', fontHeightMm: 3 }], DPI, PAGE);
  const a = parseA(text)!;
  assert.ok(a, '含中文时仍应给出 A 指令（与 TSPL 通道口径一致：能出就出，但如实告警）');
  assert.equal(a.p[3], '8');
  assert.ok(['4', '5', '6', '7'].includes(a.p[2]), `亚洲双字节字体的 p3 取值 4–7，实得 ${a.p[2]}`);
  assert.ok(warnings.some((w) => /\[字体\] 文本含中日韩字符.*双字节字体 p4=8/.test(w)), warnings.join('\n'));
  assert.ok(warnings.some((w) => /GBK\/GB18030 或 BIG5/.test(w)), '要说明数据段需按打印机码页转码');
  assert.ok(warnings.some((w) => /ZPL\(\^CI28\)/.test(w)), '要给出替代出路');
});

test('EPL 文本里的双引号与控制字符：不允许猜转义写法，替换/剔除并 warning', () => {
  const q = generateEpl([{ type: 'text', xMm: 1, yMm: 1, text: 'A"B' }], DPI, PAGE);
  assert.equal(parseA(q.text)!.data, "A'B");
  assert.ok(q.warnings.some((w) => /\[数据\].*定界符/.test(w)), q.warnings.join('\n'));
  assert.ok(!/\r\nA\d.*".*"B/.test(q.text), 'DATA 段不能被引号截断');

  const nl = generateEpl([{ type: 'text', xMm: 1, yMm: 1, text: 'A\tB\r\nC' }], DPI, PAGE);
  assert.equal(parseA(nl.text)!.data, 'ABC');
  assert.ok(nl.warnings.some((w) => /\[数据\].*控制字符/.test(w)), nl.warnings.join('\n'));
});

test('EPL 空文本 / 纯空白文本不产生指令', () => {
  for (const t of ['', '   ', undefined]) {
    assert.equal(parseA(generateEpl([{ type: 'text', xMm: 1, yMm: 1, text: t as string }], DPI, PAGE).text), undefined);
  }
});

// ---------------------------------------------------------------------------
// 6. 矢量元素：查证不到参数含义 → 不打，只 warning
// ---------------------------------------------------------------------------
test('EPL 框/线/椭圆不输出猜测的 X/LO/LS/LW/LE 指令，改为 warning + 出路', () => {
  const els: EplElement[] = [
    { type: 'box', xMm: 5, yMm: 5, wMm: 20, hMm: 10, borderMm: 0.4 },
    { type: 'line', xMm: 5, yMm: 20, x2Mm: 40, y2Mm: 20, strokeMm: 0.4 },
    { type: 'ellipse', xMm: 5, yMm: 25, wMm: 20, hMm: 10, borderMm: 0.4 },
  ];
  const { text, warnings } = generateEpl(els, DPI, PAGE);
  assert.doesNotMatch(text, /^X\d/m);
  assert.doesNotMatch(text, /^L[OSWE]\d/m);
  for (const shape of ['矩形框', '直线', '椭圆']) {
    assert.ok(warnings.some((w) => w.includes(shape)), `应有关于${shape}的 warning`);
  }
  assert.ok(warnings.some((w) => /未查证到就不输出/.test(w)), warnings.join('\n'));
});

// ---------------------------------------------------------------------------
// 7. 稳定性 / 依赖边界
// ---------------------------------------------------------------------------
test('EPL 生成器是纯同步函数：非法输入不抛异常，返回 { text, warnings }', () => {
  const garbage: any[] = [
    { type: 'barcode', xMm: NaN, yMm: 5 },                       // 缺 spec
    { type: 'barcode', xMm: 0, yMm: 0, barcode: { sym: undefined, content: undefined } },
    { type: 'qrcode', xMm: 0, yMm: 0 },                          // 缺 spec
    { type: 'text', xMm: 5, yMm: 5, text: 'X', fontHeightMm: 0, fontWidthMm: NaN },
    { type: 'whatever', xMm: 5, yMm: 5 },
    { type: 'barcode', xMm: 5, yMm: 5, barcode: { sym: 'CODE39', content: 'ABC', moduleWidthMm: 0, wideRatio: NaN, heightMm: -5, showText: true, textPosition: 'bottom' } },
    null, undefined,
  ];
  for (const el of garbage) {
    const r = generateEpl([el], DPI, { widthMm: 50, heightMm: 30, gapMm: 3, density: 5, speed: 4, copies: 2 });
    assert.equal(typeof r.text, 'string');
    assert.ok(Array.isArray(r.warnings));
    assert.ok(r.text.startsWith('\r\nN\r\n'), r.text);
    assert.ok(r.text.endsWith('\r\nP2\r\n'), r.text);
  }
  // 整个 els 不是数组也不能炸
  assert.doesNotThrow(() => generateEpl(undefined as any, DPI, PAGE));
  // dpi 非法（<=0）也不能产生 NaN 指令
  const bad = generateEpl([{ type: 'text', xMm: 5, yMm: 5, text: 'A' }], 0, { widthMm: 0, heightMm: 0 });
  assert.doesNotMatch(bad.text, /NaN/);
  assert.ok(bad.warnings.some((w) => /\[版式\] 页面尺寸无效/.test(w)), bad.warnings.join('\n'));
});

test('EPL 通道自包含：生成器只 import ./types，单测不引入重依赖（网络/打印机/矩阵模块）', () => {
  const importSpecs = (file: string): string[] =>
    [...readFileSync(file, 'utf8').matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);

  // 1) 生成器：本轮 coordinator 要求「完全自包含」，所以除 ./types 之外不允许任何 import
  const genSpecs = importSpecs(join(__dirname, '..', 'epl-generator.ts'));
  assert.deepEqual(genSpecs, ['./types'], `EPL 生成器只允许 import ./types，实得 ${genSpecs.join(', ')}`);
  const genSrc = readFileSync(join(__dirname, '..', 'epl-generator.ts'), 'utf8');
  for (const banned of ['barcode-caps', 'barcode-geometry', 'bitmap-blocks', './gs1', './raster', 'zpl-generator', 'tspl-generator', 'bwip', 'sharp', 'dgram', 'serialport', 'node:net']) {
    assert.ok(!new RegExp(`from '${banned.replace('.', '\\.')}'|require\\(['"]${banned.replace('.', '\\.')}`).test(genSrc), `生成器不应引用 ${banned}`);
  }

  // 2) 单测：只允许 node 内置、../epl-generator、../types
  const selfSpecs = importSpecs(join(__dirname, 'epl.test.ts'));
  assert.deepEqual(
    [...selfSpecs].sort(),
    ['../epl-generator', '../types', 'node:assert/strict', 'node:fs', 'node:path', 'node:test'].sort(),
    `单测 import 清单异常：${selfSpecs.join(', ')}`,
  );
  for (const spec of selfSpecs) {
    assert.doesNotMatch(spec, /typeorm|nestjs|dgram|serialport|bwip|sharp|barcode-caps|bitmap-blocks|gs1|raster/);
  }
});

// ---------------------------------------------------------------------------
// 8. 审计表 EPL_SYM_STATUS：与硬编码码制全集 / 与本地类型码表的一致性守卫
// ---------------------------------------------------------------------------

/** 期望的码制全集（UI 一维 + 二维）。硬编码在此，**不 import barcode-caps** */
const SYM_UNIVERSE = [
  // 一维
  'CODE128', 'GS1_128', 'CODE39', 'CODE93', 'EAN13', 'EAN8', 'UPC', 'UPC_A', 'UPC_E',
  'ITF', 'ITF14', 'CODABAR', 'MSI', 'PHARMACODE', 'CODE16K',
  // 二维
  'QRCODE', 'MICROQR', 'DATAMATRIX', 'DATAMATRIX_RECT', 'PDF417', 'AZTEC',
];

test('EPL_SYM_STATUS 的键集合是硬编码码制全集的子集，且每行 status/note 合法', () => {
  const keys = Object.keys(EPL_SYM_STATUS);
  for (const k of keys) {
    assert.ok(SYM_UNIVERSE.includes(k), `EPL_SYM_STATUS 出现全集之外的码制键 ${k}`);
    const st = EPL_SYM_STATUS[k];
    assert.ok(['native', 'bitmap', 'previewOnly', 'no-evidence'].includes(st.status), `${k} status 非法：${st.status}`);
    assert.ok(st.note.length > 20, `${k} 必须有说明（note）`);
    // native / bitmap / previewOnly 这三类是给矩阵合并用的结论，必须带可引用来源代号
    if (st.status !== 'no-evidence') {
      assert.match(st.note, /\[M\]|\[Z\]|\[S\]|\[N\]/, `${k} 的 note 必须带查证代号`);
    } else {
      assert.match(st.note, /手册无此指令/, `${k} 应明确「手册无此指令」`);
    }
  }
  // 全集里每一行都得有结论，合并时不能漏码制
  for (const sym of SYM_UNIVERSE) assert.ok(EPL_SYM_STATUS[sym], `EPL_SYM_STATUS 缺 ${sym} 行`);
});

test('EPL_SYM_STATUS 与 EPL_BARCODE_TYPES / 实际输出行为三者互相一致（自包含守卫）', () => {
  const natives = Object.keys(EPL_SYM_STATUS).filter((s) => EPL_SYM_STATUS[s].status === 'native').sort();
  assert.deepEqual(natives, Object.keys(EPL_BARCODE_TYPES).sort(),
    '审计表的 native 行必须与可输出类型码表完全一致');

  for (const sym of Object.keys(EPL_SYM_STATUS)) {
    const st = EPL_SYM_STATUS[sym];
    const twoD = ['QRCODE', 'MICROQR', 'DATAMATRIX', 'DATAMATRIX_RECT', 'PDF417', 'AZTEC'].includes(sym);
    if (st.status === 'bitmap') {
      assert.equal(st.command, EPL_GRAPHIC_COMMAND, `${sym} 走位图通道时指令应为图形指令`);
      assert.ok(twoD, `${sym} 只有二维才允许 bitmap 通道`);
      assert.ok(!(sym in EPL_BARCODE_TYPES), `${sym} 走位图，不得有一维类型码`);
    }
    if (st.status === 'previewOnly' || st.status === 'no-evidence') {
      assert.equal(st.command, undefined, `${sym} 不输出任何指令，command 字段必须留空`);
      assert.ok(!(sym in EPL_BARCODE_TYPES), `${sym} 不输出，不得出现在类型码表里`);
      // 行为与结论一致：给内容也只有 warning，没有 B 指令
      const { text, warnings } = generateEpl([bc(sym, '1234567')], DPI, PAGE);
      assert.equal(cmds(text).filter((l) => /^B\d/.test(l)).length, 0, `${sym} 不该产生 B 指令`);
      assert.equal(warnings.filter((w) => /\[码制\]/.test(w)).length, 1, `${sym} 应有且仅有一条码制 warning`);
    }
    if (st.status === 'native' && st.command) {
      const code = /p4='([^']+)'/.exec(st.command)?.[1];
      if (code) assert.ok([EPL_BARCODE_TYPES[sym].type, EPL_BARCODE_TYPES[sym].checkType].includes(code),
        `${sym} 审计表里的类型码 ${code} 与抄录表不符`);
    }
  }
});

test('EPL 归一化与矩阵无关：常见别名都能落到类型码表（内联 normSym 副本的行为守卫）', () => {
  assert.equal(normSym('code-128'), 'CODE128');
  assert.equal(normSym('UPC-A'), 'UPC');
  assert.equal(normSym('itf-14'), 'ITF14');
  assert.equal(normSym('GS1-128'), 'GS1_128');
  assert.equal(normSym('qr'), 'QRCODE');
  // 别名生效后，用 'Code 128' 写法也应输出类型码 1
  const { text } = generateEpl([bc('code-128', 'ABC123')], DPI, PAGE);
  assert.equal(parseB(text)!.p[3], '1');
});
