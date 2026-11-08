// =============================================================================
// golden.test.ts —— P7.8 交付③：指令快照回归网
//
// 快照的定位（与 engines/epl/render 单测的分工）：
//   · 单测证明「函数逻辑对」；快照证明「真正下发给打印机的字节没被人顺手改动」。
//   · 指令格式是跨团队最容易无意改坏的东西（参数顺序、码型字符串、转义写法），
//     而且改坏之后**照样能印、照样能扫，只是扫出另一种符号/另一种结构**。
//   · 所以每份快照头部都写了一句「回归点」，本文件把它翻译成可执行断言：
//     比字符串能发现改动，断言才能说明改动为什么不可接受。
//
// 硬约束：快照由 cases.ts 的**同步纯函数**产生，不引 sharp / bwip-js / raster.ts / Nest
// （位图段用 synthFallback 手工点阵）。像素是否真能扫，由 scripts/p7-acceptance.sh 的
// C 段用真 bwip 点阵 + cv2 解码验证，两件事不混淆。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  fileNameFor, goldenCases, makeSnapshot, renderSnapshot, synthFallback,
  CONTENT, DPI, X_MM, Y_MM, FALLBACK_WIDTH_DOTS, FALLBACK_HEIGHT_DOTS,
  type GoldenCase, type Snapshot,
} from './golden/cases';
import { CAP_MATRIX_VERSION, planChannel } from '../barcode-caps';
import { EPL_BARCODE_TYPES } from '../epl-generator';
import { gtinCheckDigit } from '../checksum';
import { computeGeometry } from '../barcode-geometry';

const DIR = join(__dirname, 'golden');
const CASES = goldenCases();
const byFile = new Map<string, GoldenCase>();
for (const c of CASES) byFile.set(fileNameFor(c), c);
const FILE = (key: string, proto: 'zpl' | 'tspl' | 'epl') => `${key.toLowerCase()}.${proto}.txt`;

/** 磁盘上的快照全文 */
function disk(file: string): string {
  const p = join(DIR, file);
  assert.ok(existsSync(p), `缺快照文件 ${file}：跑 npx tsx core/__tests__/golden/update.ts --update 生成`);
  return readFileSync(p, 'utf8');
}
/** 现算一份（不落盘，按文件名缓存） */
const memo = new Map<string, Snapshot>();
function live(file: string): Snapshot {
  const hit = memo.get(file);
  if (hit) return hit;
  const c = byFile.get(file);
  assert.ok(c, `${file} 不在用例表里`);
  const s = makeSnapshot(c);
  memo.set(file, s);
  return s;
}
/** 指令段（可见文本形态）——markers 由 renderSnapshot 加上，所以必须先渲染再切 */
const cmdsOf = (file: string): string => {
  const full = renderSnapshot(live(file));
  const i = full.indexOf('--- commands ---');
  assert.ok(i >= 0, `${file} 渲染结果里没有 commands 段`);
  return full.slice(i + '--- commands ---'.length).split('--- warnings ---')[0].trim();
};
/** 头部声明的通道 */
const channelOf = (file: string): string => {
  const m = /^# 通道派单: channel=([a-zA-Z]+)/m.exec(disk(file));
  return m ? m[1] : '';
};
const warnedSkip = (file: string): boolean => live(file).warnings.join('\n').includes('已跳过');

// ---------------------------------------------------------------------------
// 1. 覆盖矩阵与可重复性
// ---------------------------------------------------------------------------

/** 必须出快照的码制：brief 的 17 个码制 + 派生/无点阵/小众 5 条 = 22 */
const REQUIRED_KEYS = [
  'CODE128', 'GS1_128', 'CODE39', 'CODE93', 'EAN13', 'EAN8', 'UPC_A', 'UPC_E',
  'ITF', 'ITF14', 'CODABAR', 'MSI', 'PHARMACODE', 'CODE16K',
  'QRCODE', 'DATAMATRIX', 'PDF417', 'AZTEC', 'MICROQR', 'DATAMATRIX_RECT',
  'DATAMATRIX_GS1', 'DATAMATRIX_GS1_NORASTER',
];

test('golden 覆盖-22 个码制 × 3 协议 = 66 份快照，一条不缺', () => {
  const have = new Set(CASES.map((c) => `${c.key}@${c.protocol}`));
  const want: string[] = [];
  for (const k of REQUIRED_KEYS) for (const p of ['zpl', 'tspl', 'epl']) want.push(`${k}@${p}`);
  assert.equal(want.length, 66);
  for (const w of want) assert.ok(have.has(w), `缺用例 ${w}`);
  assert.equal(CASES.length, want.length, '用例总数应恰好等于覆盖矩阵（多了说明有未登记码制）');
  assert.equal(new Set(CASES.map(fileNameFor)).size, CASES.length, '文件名必须互不相同');
});

test('golden 文件-66 份 .txt 全在磁盘上，且没有孤儿快照', () => {
  const files = readdirSync(DIR).filter((n) => n.endsWith('.txt')).sort();
  const expected = [...byFile.keys()].sort();
  assert.deepEqual(files, expected,
    `磁盘快照与用例表不一致（缺：${expected.filter((e) => !files.includes(e)).join(',')}；`
    + `多：${files.filter((x) => !expected.includes(x)).join(',')}）`);
});

test('golden 可重复-同一用例连渲染两次逐字符相同（快照不许带时间戳/路径/随机数）', () => {
  for (const c of CASES) {
    const a = renderSnapshot(makeSnapshot(c));
    const b = renderSnapshot(makeSnapshot(c));
    assert.equal(a, b, `${fileNameFor(c)} 渲染不稳定`);
  }
});

test('golden 一致性-磁盘内容与当前实现输出逐字符相同（改坏指令立刻红）', () => {
  const bad: string[] = [];
  for (const c of CASES) {
    if (disk(fileNameFor(c)) !== renderSnapshot(makeSnapshot(c))) bad.push(fileNameFor(c));
  }
  assert.deepEqual(bad, [],
    `以下快照与当前实现不一致，先看懂 diff 再跑 npx tsx core/__tests__/golden/update.ts --update：\n${bad.join('\n')}`);
});

// ---------------------------------------------------------------------------
// 2. 头部、文本卫生与依赖红线
// ---------------------------------------------------------------------------

test('golden 头部-每份快照都写明「这份快照证明哪个缺陷」与能力矩阵版本', () => {
  for (const c of CASES) {
    const file = fileNameFor(c);
    const lines = disk(file).split('\n');
    assert.match(lines[0], new RegExp(`^# golden —— ${c.key} @ ${c.protocol.toUpperCase()}（dpi=${DPI}`), file);
    assert.match(lines[1], /^# 回归点: .{20,}/, `${file} 的回归点必须是一句可核对的说明（≥20 字）`);
    assert.ok(lines[2].startsWith('# 能力矩阵: ') && lines[2].includes(`CAP_MATRIX_VERSION=${CAP_MATRIX_VERSION}`),
      `${file} 头部要钉住能力矩阵版本`);
    assert.match(lines[3], /^# 通道派单: channel=(native|bitmap|none)( why=\S.*)?$/, `${file} 通道派单行`);
    assert.match(lines[4], /^# 位图段: /, `${file} 必须说明位图段来源`);
    assert.equal(lines[5], '', `${file} 头部后要有空行`);
  }
});

test('golden 头部-矩阵版本与通道派单必须与当前实现一致（实现改了没重生成 = 快照过期）', () => {
  for (const c of CASES) {
    const file = fileNameFor(c);
    const text = disk(file);
    const st = /status=([a-zA-Z]+)/.exec(text)?.[1];
    assert.ok(['native', 'degraded', 'bitmap', 'previewOnly'].includes(String(st)), `${file} status=${st}`);
    const want = planChannel(c.sym, c.protocol, CONTENT[c.key]);
    assert.equal(channelOf(file), want.channel, `${file} 头部通道与 planChannel(${c.sym}@${c.protocol}) 不一致`);
    assert.ok(text.includes(c.sym), `${file} 头部要写出真实码制`);
  }
});

test('golden 文本卫生-快照里除换行外不得有裸控制字符或二进制（能 diff 才能 review）', () => {
  for (const c of CASES) {
    const text = disk(fileNameFor(c));
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (ch === '\n') continue;
      assert.ok(code >= 0x20 && code !== 0x7f,
        `${fileNameFor(c)} 含裸控制字符 0x${code.toString(16)}，应走 visible()/binTag()`);
    }
    assert.doesNotMatch(text, /\u001d/, `${fileNameFor(c)} 的 GS 必须写成 <GS> 标记`);
    assert.doesNotMatch(text, /\r/, `${fileNameFor(c)} 的 CR 必须写成 <CR> 标记`);
    assert.ok(text.includes('--- commands ---') && text.includes('--- warnings ---'), fileNameFor(c));
  }
});

test('golden 依赖红线-快照三件套不引 sharp / bwip-js / raster / Nest / TypeORM', () => {
  const here = join(__dirname, 'golden');
  const scanned: Record<string, string> = {
    'cases.ts': join(here, 'cases.ts'),
    'update.ts': join(here, 'update.ts'),
    'golden.test.ts': join(__dirname, 'golden.test.ts'),
  };
  for (const [name, path] of Object.entries(scanned)) {
    const src = readFileSync(path, 'utf8');
    const specs = [...src.matchAll(/^\s*(?:import|export)[^;]*?from '([^']+)'/gm)].map((m) => m[1]);
    for (const spec of specs) {
      assert.doesNotMatch(spec, /sharp|bwip|raster|typeorm|nest|dgram|serialport|net|http/,
        `${name} 不应依赖 ${spec}`);
    }
    assert.doesNotMatch(src, /require\(['"](sharp|@bwip-js|node:net|node:http)/, `${name} 不得动态 require 重依赖`);
  }
  // 生成/校验入口：写盘只允许发生在 --update 分支（默认模式必须只读，否则 CI 形同虚设）
  const upd = readFileSync(join(__dirname, 'golden', 'update.ts'), 'utf8');
  assert.equal([...upd.matchAll(/writeFileSync\(/g)].length, 1, 'update.ts 只允许一处 writeFileSync');
  const branch = upd.slice(upd.indexOf('if (UPDATE)'));
  assert.ok(branch.indexOf('writeFileSync(') > 0 && branch.indexOf('writeFileSync(') < 300,
    'writeFileSync 必须落在 if (UPDATE) 分支里');
  assert.match(upd, /return 1/, '默认模式不一致时必须非 0 退出（CI 跑默认模式）');
  assert.match(upd, /孤儿快照/, '默认模式要能发现用例删掉后遗留的快照');
  assert.match(upd, /缺快照文件/, '缺快照时要给出可直接执行的补救命令');
});

test('golden 位图段 provenance-位图快照的 hex 恰等于 synthFallback()，原生快照里不得出现该点阵', () => {
  const hex = synthFallback().hex;
  let bitmapSnaps = 0;
  for (const c of CASES) {
    const file = fileNameFor(c);
    if (!disk(file).includes('# 位图段: 确定性合成点阵')) continue;
    bitmapSnaps++;
    const bitmapChannel = channelOf(file) === 'bitmap';
    if (bitmapChannel) {
      assert.ok(disk(file).includes(hex), `${file} 位图载荷必须来自 synthFallback()`);
    } else {
      // 原生通道（^BQ/^BX/^B7/^B0/QRCODE/B）不该夹带位图，出现 hex 说明被偷偷改成位图
      assert.ok(!disk(file).includes(hex), `${file} 走原生指令，不该出现合成点阵 hex`);
    }
  }
  assert.equal(bitmapSnaps, 21, '7 个二维用例 × 3 协议 = 21 份带合成点阵的快照');
});

// ---------------------------------------------------------------------------
// 3. 逐条「哪个缺陷不再复发」
// ---------------------------------------------------------------------------

test('回归点-ZPL 交叉二五码用 ^B2（^BI 是 Industrial 2 of 5、^BJ 是 Standard 2 of 5）', () => {
  for (const key of ['itf', 'itf14']) {
    const cmds = cmdsOf(FILE(key, 'zpl'));
    assert.match(cmds, /\^B2/, `${key}@zpl 必须是 ^B2`);
    assert.doesNotMatch(cmds, /\^BI|\^BJ|\^B7|\^BC/, `${key}@zpl 出现别的码制指令 = 换了码制`);
  }
});

test('回归点-ZPL PDF417 用 ^B7（不是 ^B2），行高按 3×模块', () => {
  const cmds = cmdsOf(FILE('pdf417', 'zpl'));
  assert.match(cmds, /\^B7/);
  assert.doesNotMatch(cmds, /\^B2/, '^B2 会把 PDF417 打成一维交叉二五码');
  assert.match(cmds, /\^BY\d+,\d+(?:\.\d+)?,12/, '行高 12 点 = 3× 模块点数（PDF417 行高下限）');
});

test('回归点-TSPL GS1-128 的码型必须是 "EAN128"，数据段是裸 GS 而不是 ZPL 转义', () => {
  const file = FILE('gs1_128', 'tspl');
  const cmds = cmdsOf(file);
  assert.match(cmds, /"EAN128"/, '写成 "128" 时符号扫得出但 AI 字段全丢');
  assert.doesNotMatch(cmds, /"128"/);
  assert.ok(live(file).raw.includes('\u001d'), '真实字节里必须是 0x1D');
  assert.doesNotMatch(cmds, />;|>8/, 'ZPL 转义写进 TSPL 会被当字面量打进符号');
  assert.match(cmds, /"011234567890123121SN0007<GS>301234"/, '定长 01 之后不插、非末位变长 21 之后插、末位不插');
});

test('回归点-ZPL GS1-128 以 >; 起始、非末位变长 AI 之后 >8、^BC 的 UCC 校验位锁 N', () => {
  const cmds = cmdsOf(FILE('gs1_128', 'zpl'));
  assert.match(cmds, /\^BCN,96,Y,N,N/, '第 5 位（UCC 校验）必须 N，否则固件重算校验位');
  assert.match(cmds, /\^FD>;011234567890123121SN0007>8301234\^FS/);
  assert.equal((cmds.match(/>8/g) ?? []).length, 1, '>8 只能出现在非末位的变长 AI 之后');
});

test('回归点-TSPL BITMAP 头部 bpr×rows 必须等于载荷字节数（差一字节整块图错位）', () => {
  const expectKeys = ['DATAMATRIX', 'PDF417', 'AZTEC', 'MICROQR', 'DATAMATRIX_RECT', 'DATAMATRIX_GS1'];
  const seen: string[] = [];
  for (const c of CASES) {
    if (c.protocol !== 'tspl' || c.noRaster) continue;
    const file = fileNameFor(c);
    const raw = live(file).raw;
    const m = /BITMAP (\d+),(\d+),(\d+),(\d+),(\d+),/.exec(raw);
    if (!m) continue;
    const bpr = Number(m[3]), rows = Number(m[4]), mode = Number(m[5]);
    const start = (m.index ?? 0) + m[0].length;
    const bytes = Buffer.from(raw.slice(start), 'latin1');
    const declared = bpr * rows;
    seen.push(c.key);
    assert.equal(mode, 0, `${file} 位图模式必须是 0（直接赋值）`);
    assert.equal(bpr, synthFallback().bytesPerRow, `${file} 每行字节数 = ceil(宽点数/8)`);
    assert.equal(rows, synthFallback().heightDots, `${file} 行数 = 点阵高度`);
    assert.equal(bytes.length >= declared, true, `${file} 载荷短于头部声明的 ${declared} 字节`);
    const after = bytes.subarray(declared, declared + 2).toString('latin1');
    assert.ok(after === '\r\n' || after === '',
      `${file} 载荷之后必须紧跟 CRLF（多一个字节 = 吃掉下一行指令），实得 ${JSON.stringify(after.slice(0, 8))}`);
    assert.ok(disk(file).includes(`⟦BIN ${declared}B:`), `${file} 的 BIN 标记字节数要与头部声明一致`);
  }
  assert.deepEqual(seen.sort(), [...expectKeys].sort(), 'TSPL 位图快照清单变了');
});

test('回归点-EPL GW 的 p3×p4 必须等于载荷字节数，且载荷以单个 CR 结束', () => {
  const expectKeys = ['QRCODE', 'DATAMATRIX', 'PDF417', 'AZTEC', 'MICROQR', 'DATAMATRIX_RECT', 'DATAMATRIX_GS1'];
  const seen: string[] = [];
  for (const c of CASES) {
    if (c.protocol !== 'epl' || c.noRaster) continue;
    const file = fileNameFor(c);
    const raw = live(file).raw;
    const m = /GW(\d+),(\d+),(\d+),(\d+),/.exec(raw);
    if (!m) continue;
    const bpr = Number(m[3]), rows = Number(m[4]);
    const start = (m.index ?? 0) + m[0].length;
    const bytes = Buffer.from(raw.slice(start), 'latin1');
    seen.push(c.key);
    assert.equal(bpr, synthFallback().bytesPerRow, `${file} GW p3 = 每行字节数`);
    assert.equal(rows, synthFallback().heightDots, `${file} GW p4 = 行数`);
    assert.equal(bytes.subarray(bpr * rows, bpr * rows + 1).toString('latin1'), '\r',
      `${file} GW 载荷第 p3×p4 字节之后必须是 CR，否则说明载荷长度与声明不符`);
    assert.ok(disk(file).includes(`⟦BIN ${bpr * rows}B:`), file);
  }
  assert.deepEqual(seen.sort(), [...expectKeys].sort(), 'EPL GW 快照清单变了');
});

/**
 * ^GFA 三数自洽检查（从主断言里拆出来，是为了能对**已知的错写法**也跑一遍：
 * 结构断言读的是 live() 现算结果，手改 .txt 只会红「一致性」那条，
 * 所以必须用合成样本证明守卫本身咬得住，否则它就是装饰。）
 */
function checkGfa(where: string, cmds: string): void {
  const m = /\^GFA,(\d+),(\d+),(\d+),([0-9A-F]+)\^FS/.exec(cmds);
  assert.ok(m, `${where}：找不到 ^GFA 块`);
  const [, b, cParam, d, hex] = m;
  assert.equal(b, cParam, `${where}：单块 ^GFA 的 b（传输字节数）必须等于 c（总字节数）；`
    + `c 写成行数 = 固件只收 c 个字节就截断，位图缺一半且不报错`);
  assert.equal(Number(cParam), Number(d) * FALLBACK_HEIGHT_DOTS,
    `${where}：c 必须等于 每行字节数 × 行数（${d}×${FALLBACK_HEIGHT_DOTS}），而不是行数本身`);
  assert.notEqual(Number(cParam), FALLBACK_HEIGHT_DOTS,
    `${where}：c 恰等于行数 ⇒ 就是「行数当总字节数」的复发形态`);
  assert.equal(hex.length, Number(b) * 2, `${where}：ASCII hex 形态下字符数必须是 2×b（多一位少一位都是载荷错位）`);
  assert.equal(Number(b) % Number(d), 0, `${where}：总字节数必须被每行字节数整除，否则最后一行是半行`);
  assert.equal(Number(b) / Number(d), FALLBACK_HEIGHT_DOTS, `${where}：b/d 必须等于点阵行数`);
  assert.equal(Number(d), Math.ceil(FALLBACK_WIDTH_DOTS / 8), `${where}：d 必须等于 ceil(点阵宽/8)`);
  assert.equal(hex, synthFallback().hex, `${where} 位图内容必须是确定性合成点阵`);
}

test('回归点-ZPL ^GFA 的 b/c/d 三数自洽：b==c、hex 长度 = 2×total、total/bpr = 行数', () => {
  // ZPL II `^GFa,b,c,d,data`：b=本块传输字节数、c=点阵总字节数、d=每行字节数。
  // 单块下发时 b==c，d 只描述行宽。原实现写的是 `^GFA,total,heightDots,bpr,hex`
  // ——把「行数」当成了 c（总字节数）。固件按 b/c 收字节，于是 12 行的图只收 12 字节
  // 就被认为结束：**图被截断/错位，且不报错**，正是最难查的那类缺陷（P7.3 位图通道）。
  // 三个数两两约束：写错任何一个都红。
  const expectKeys = ['MICROQR', 'DATAMATRIX_RECT', 'DATAMATRIX_GS1'];
  const seen: string[] = [];
  for (const c of CASES) {
    if (c.protocol !== 'zpl' || c.noRaster) continue;
    const file = fileNameFor(c);
    const cmds = cmdsOf(file);
    if (!/\^GFA,/.test(cmds)) continue;
    seen.push(c.key);
    checkGfa(file, cmds);
  }
  assert.deepEqual(seen.sort(), [...expectKeys].sort(), 'ZPL ^GFA 快照清单变了');
  // 守卫自检：历史上的错写法（c=行数）必须被上面那套断言判红。
  // 哪天有人把 checkGfa 放宽成「只查 hex 长度」，这条会立刻指出守卫失效。
  const good = cmdsOf(FILE('MICROQR', 'zpl'));
  const regression = good.replace(/\^GFA,(\d+),(\d+),/, (_s, b) => `^GFA,${b},${FALLBACK_HEIGHT_DOTS},`);
  assert.notEqual(regression, good, '合成样本没生效（^GFA 头部格式变了，请同步更新本用例）');
  assert.throws(() => checkGfa('复发形态样本', regression), /必须等于 c|恰等于行数/);
  // 反向自检：只把 hex 砍掉一个字符（载荷错位）也必须被抓住
  const shortHex = good.replace(/([0-9A-F]{6})[0-9A-F]{2}/, '$1');
  assert.notEqual(shortHex, good);
  assert.throws(() => checkGfa('截短 hex 样本', shortHex), /字符数必须是|位图内容必须是/);
});

test('回归点-EPL 类型码与 EPL_BARCODE_TYPES 一致，窄条宽落在该类型码允许区间内', () => {
  const expect: Record<string, string> = {
    CODE128: '1', CODE39: '3', CODE93: '9', EAN13: 'E30', EAN8: 'E80',
    UPC_A: 'UA0', UPC_E: 'UE0', ITF: '2', ITF14: '2', CODABAR: 'K',
  };
  const seen: string[] = [];
  for (const c of CASES) {
    if (c.protocol !== 'epl' || c.kind !== 'barcode') continue;
    const file = fileNameFor(c);
    const m = /^B(\d+),(\d+),(\d+),([^,]+),(\d+),(\d+),(\d+),([AB]),"([^"]*)"(?:<CR>)?$/m.exec(cmdsOf(file));
    if (!m) {
      // 语法查不到 → 整条跳过（这份清单同样被钉住）
      assert.ok(['GS1_128', 'MSI', 'PHARMACODE', 'CODE16K'].includes(c.key), `${c.key}@epl 不该出 B 指令`);
      assert.match(live(file).warnings.join('\n'), /\[码制\] EPL 无法原生输出/);
      continue;
    }
    const [, , , , type, narrow, wide, height] = m;
    const def = EPL_BARCODE_TYPES[c.sym];
    assert.ok(def, `${c.sym} 不在 EPL_BARCODE_TYPES 里却出了 B 指令`);
    assert.equal(type, def.type, `${c.key}@epl 类型码应为 ${def.type}`);
    assert.equal(type, expect[c.key], `${c.key}@epl 类型码与预期清单不符`);
    assert.ok(Number(narrow) >= def.narrowMin && Number(narrow) <= def.narrowMax,
      `${c.key}@epl 窄条宽 ${narrow} 超出 Table 2-1 的 ${def.narrowMin}–${def.narrowMax} 点`);
    assert.ok(Number(wide) >= Number(narrow), `${c.key}@epl 宽条不得窄于窄条`);
    assert.equal(Number(height), 96);
    // 「p6 是固件固定值」这条 warning 必须与类型表一致：谎报会让使用者以为改了宽窄比就生效（打出来的符号仍按固件值）
    const claimsFixed = live(file).warnings.join('\n').includes('p6（宽条宽）为固件固定值');
    assert.equal(claimsFixed, !def.wideSettable, `${c.key}@epl 的 p6 说明与 EPL_BARCODE_TYPES.wideSettable=${def.wideSettable} 不符`);
    seen.push(`${c.key}:${type}`);
  }
  assert.deepEqual(seen.sort(), Object.entries(expect).map(([k, v]) => `${k}:${v}`).sort(), seen.join('\n'));
});

test('回归点-EAN/UPC 在 TSPL 上 narrow 必须等于 wide（固定比例符号）', () => {
  const pairs: Array<[string, string]> = [['ean13', 'EAN13'], ['ean8', 'EAN8'], ['upc_a', 'UPCA'], ['upc_e', 'UPCE']];
  for (const [key, type] of pairs) {
    const file = FILE(key, 'tspl');
    const m = new RegExp(`BARCODE \\d+,\\d+,"${type}",\\d+,\\d+,\\d+,(\\d+),(\\d+),`).exec(cmdsOf(file));
    assert.ok(m, `${key}@tspl 应有 BARCODE 行：${cmdsOf(file)}`);
    assert.equal(m![1], m![2], `${key} 的 narrow(${m![1]}) 必须等于 wide(${m![2]})，否则符号非法`);
    assert.match(live(file).warnings.join('\n'), /固定比例码制/);
    // EPL 侧同样强制 1:1（EAN13 的 p6 与 p5 相同）
    const em = /^B\d+,\d+,\d+,E[0-9A-Z]+,(\d+),(\d+),/m.exec(cmdsOf(FILE(key === 'upc_a' ? 'upc_a' : key, 'epl')));
    if (em && ['ean13', 'ean8'].includes(key)) assert.equal(em[1], em[2], `${key}@epl wide 必须等于 narrow`);
  }
});

test('回归点-小众一维码（PHARMACODE/CODE16K）三协议都只跳过 + 可执行建议，指令串里不得出现任何码制指令', () => {
  const banned: Record<'zpl' | 'tspl' | 'epl', RegExp> = {
    zpl: /\^B[A-Z0-9]/,
    tspl: /BARCODE |QRCODE |BITMAP /,
    epl: /^(B|GW)\d/m,
  };
  for (const key of ['pharmacode', 'code16k']) {
    for (const proto of ['zpl', 'tspl', 'epl'] as const) {
      const file = FILE(key, proto);
      assert.doesNotMatch(cmdsOf(file), banned[proto], `${file} 出现码制/图形指令 = 静默换了码制`);
      assert.equal(channelOf(file), 'none', `${file} 头部应记录派单为仅预览`);
      const w = live(file).warnings.join('\n');
      assert.match(w, /\[码制\]/);
      assert.match(w, /建议|改用|protocol=image/, `${file} 的 warning 要给出下一步`);
      assert.match(w, /已跳过/);
    }
  }
});

test('回归点-Micro QR / 矩形 DataMatrix / GS1 DataMatrix 不得谎称打印机原生指令', () => {
  const zpl = cmdsOf(FILE('microqr', 'zpl'));
  assert.match(zpl, /\^GFA/);
  assert.doesNotMatch(zpl, /\^BQ/, '^BQ 打出来是标准 QR，与预览不是同一符号');
  const rect = cmdsOf(FILE('datamatrix_rect', 'zpl'));
  assert.match(rect, /\^GFA/);
  assert.doesNotMatch(rect, /\^BX/, '^BX 的 columns/rows 只接受 9–49，矩形 ECC200 尺寸越界会整块不打印');
  const gs1dm = cmdsOf(FILE('datamatrix_gs1', 'zpl'));
  assert.match(gs1dm, /\^GFA/);
  assert.doesNotMatch(gs1dm, /\^BX/, '^BX 没有可引用的 FNC1 转义写法，硬编会把 GS1 DataMatrix 静默打成普通 DataMatrix');
  assert.match(disk(FILE('datamatrix_gs1', 'zpl')), /含 GS1 \(AI\)/, '头部要写明是因为 (AI) 才改派位图');
  assert.doesNotMatch(cmdsOf(FILE('microqr', 'tspl')), /QRCODE/, 'TSPL 降级成标准 QR 也不等价');
  assert.match(cmdsOf(FILE('microqr', 'tspl')), /BITMAP/);
  // 反面对照：真正的 QR / DataMatrix 必须走原生指令，不能被一刀切成位图
  assert.match(cmdsOf(FILE('qrcode', 'zpl')), /\^BQ/);
  assert.match(cmdsOf(FILE('datamatrix', 'zpl')), /\^BX/);
  assert.match(cmdsOf(FILE('qrcode', 'tspl')), /^QRCODE/m);
});

test('回归点-位图通道拿不到点阵时「跳过 + warning」，绝不凭空造指令也不回落原生码制', () => {
  for (const proto of ['zpl', 'tspl', 'epl'] as const) {
    const file = FILE('datamatrix_gs1_noraster', proto);
    const cmds = cmdsOf(file);
    assert.doesNotMatch(cmds, /\^BX|\^GFA/, `${file} 不该出现 ^BX 或凭空造的 ^GFA`);
    assert.doesNotMatch(cmds, /QRCODE|BITMAP|GW\d/, `${file} 不该出现凭空造的位图行`);
    const w = live(file).warnings.join('\n');
    assert.match(w, /\[码制\]/);
    // 三协议措辞不同，但都必须落到「缺的是点阵」这一层：
    //   ZPL/TSPL 走位图通道 → 「需位图回填但未拿到点阵」；EPL 无原生 b 语法 → 「没有预置位图点阵（fallback）」
    assert.match(w, /未拿到点阵|预置位图点阵|fallback/,
      `${file} 要说清「缺的是点阵」而不是「码制不支持」，否则排障会被引去改码制表`);
    assert.match(disk(file), /# 位图段: 故意不给 fallback/);
    assert.equal(warnedSkip(file), true);
  }
});

test('回归点-MSI 在 ZPL 的校验方式位必须是 A（省略时固件按 B 多打一位）', () => {
  const cmds = cmdsOf(FILE('msi', 'zpl'));
  assert.match(cmds, /\^BMN,A,/);
  assert.match(cmds, /\^FD1234567\^FS/);
  assert.equal(channelOf(FILE('msi', 'epl')), 'none');
  assert.match(live(FILE('msi', 'epl')).warnings.join('\n'), /校验算法被类型码写死|不是同一符号/);
  // TSPL 未要求校验位 → 不得自动换成 "MSIC"
  assert.match(cmdsOf(FILE('msi', 'tspl')), /"MSI"/);
  assert.doesNotMatch(cmdsOf(FILE('msi', 'tspl')), /"MSIC"/);
});

test('回归点-Code128 的 2.5 宽窄比必须落到整数模块（设计器 2.5、打印机 2 的历史坑）', () => {
  assert.match(cmdsOf(FILE('code128', 'zpl')), /\^BY3,3,96/, '^BY 第 2 段是取整后的 3:1');
  assert.match(cmdsOf(FILE('code128', 'zpl')), /\^BCN,96,Y,N,N/);
  assert.match(live(FILE('code128', 'zpl')).warnings.join('\n'), /宽窄比 2\.5 已取整为 3:1/);
  // TSPL 的 wide 以点为单位：3 点 × 3 = 9
  assert.match(cmdsOf(FILE('code128', 'tspl')), /"128",96,1,0,3,9,/);
  assert.match(cmdsOf(FILE('code128', 'epl')), /^B80,64,0,1,3,9,96,B,/m);
  assert.match(live(FILE('code128', 'epl')).warnings.join('\n'), /p6（宽条宽）为固件固定值/,
    'EPL 的 p6 不可设，必须如实提示而不是假装生效');
});

test('回归点-元素摆放按 mm→点换算；被跳过的元素不得留下坐标残行', () => {
  const dots = (mm: number) => Math.round((mm * DPI) / 25.4);
  assert.equal(dots(X_MM), 80);
  assert.equal(dots(Y_MM), 64);
  const placed: Record<'zpl' | 'tspl' | 'epl', RegExp> = {
    zpl: new RegExp(`\\^FO${dots(X_MM)},${dots(Y_MM)}`),
    tspl: new RegExp(`^(BARCODE|QRCODE|BITMAP) ${dots(X_MM)},${dots(Y_MM)},`, 'm'),
    // EPL 每条指令独占一行、行尾是 CR（快照里由 visible() 写成字面量 <CR>）
    epl: new RegExp(`^(B|GW)${dots(X_MM)},${dots(Y_MM)},`, 'm'),
  };
  for (const c of CASES) {
    const file = fileNameFor(c);
    const cmds = cmdsOf(file);
    if (warnedSkip(file)) {
      assert.doesNotMatch(cmds, /\^FO\d+,\d+/, `${file} 跳过的元素不得留 ^FO 空壳`);
      continue;
    }
    assert.match(cmds, placed[c.protocol], `${file} 指令坐标应为 (${dots(X_MM)},${dots(Y_MM)})`);
  }
});

test('回归点-ITF14 的 degraded 等价性必须写成 warning（不能假装与预览完全等价）', () => {
  const file = FILE('itf14', 'epl');
  assert.match(live(file).warnings.join('\n'), /不含 ITF-14 的边框|ITF-14 边框/);
  assert.match(disk(file), /status=degraded/);
  assert.match(disk(file), /channel=native why=/, 'degraded 仍走原生，但头部必须带差异说明');
  assert.match(cmdsOf(file), /^B80,64,0,2,/m, '仍用交叉二五码类型码 2 承载');
});

test('回归点-ZPL ^BY 的宽窄比对 EAN/UPC 无效时必须说明（而不是静默给一个看着像参数的数字）', () => {
  for (const key of ['ean13', 'ean8', 'upc_a', 'upc_e']) {
    const file = FILE(key, 'zpl');
    assert.match(live(file).warnings.join('\n'), /\[参数\].*宽窄比对 .* 无效/, `${file} 缺参数级说明`);
    assert.match(cmdsOf(file), /\^BY3,2,96/, '固定比例码制下发 1:1（第 2 段为 2 是 ZPL 的最小合法值）');
  }
});

// ---- ^BY 第 2 段的口径（P7.8 裁决 (g)：不是 bug，但必须钉住它「怎么算出来的」）----
// 快照里 ITF/CODE39/CODE93/CODABAR/MSI 都是 `^BY3,2.7,96`，看着像手滑，实际是刻意：
//   2.7 = wideDots(8) / xDots(3) 反算后按 0.1 步长取整，即**打印机真正会打的宽窄比**。
//   若改成用户填的 2.5，固件要把 2.5×3 再取整一次，结果取决于固件是四舍五入还是截断；
//   给 2.7 时 2.7×3=8.1→8，与几何层算出的 wideDots 自洽，预览/打印不会分叉。
// 所以这里断言的不是「等于 2.7」，而是「等于用同一份几何反算出来的那个值」：
//   · xDots/wideDots 任一被人改动 → 快照与几何对不上，本用例红；
//   · zplByRatio 改回输出用户原值（2.5）→ 本用例红；
//   · 输出 2.666666 这种超出 ZPL 0.1 步长的值 → 本用例红。
/** 一维码里 ^BY 会真正下发的 12 条（PHARMACODE/CODE16K 走不到原生 ^BY，PDF417 用 ^B7 单独口径） */
const BY_1D_KEYS = ['CODE128', 'GS1_128', 'CODE39', 'CODE93', 'EAN13', 'EAN8',
  'UPC_A', 'UPC_E', 'ITF', 'ITF14', 'CODABAR', 'MSI'];
const BY_REQUESTED_RATIO = 2.5; // cases.bcSpec 的默认宽窄比，改动它等于改动所有快照

/** 从指令段里取 ^BY(w,r,h) 的三段；r 的原始字符串也要留着判步长 */
function byLine(where: string, cmds: string): { w: number; r: number; h: number; rRaw: string } {
  const m = /\^BY(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+)/.exec(cmds);
  assert.ok(m, `${where}：指令段里没有 ^BY(w,r,h)`);
  return { w: Number(m[1]), r: Number(m[2]), h: Number(m[3]), rRaw: m[2] };
}

/** 核心判据：^BY 必须与传入的几何自洽。坏样本喂进来必须在这里炸掉（下面自证可达）。 */
function checkBy(where: string, cmds: string, geo: { xDots: number; wideDots: number; fixedRatio: boolean }): void {
  const { w, r, h, rRaw } = byLine(where, cmds);
  assert.equal(w, geo.xDots, `${where}：^BY 第 1 段必须等于量化后的模块点数 ${geo.xDots}，实得 ${w}`);
  assert.ok(h >= 10 && h <= 3200, `${where}：^BY 第 3 段（高度）超出 ZPL 合法范围：${h}`);
  // 先判写法（ZPL 只吃 2.0–3.0、0.1 步长），再判取值口径
  assert.ok(/^[23](?:\.\d)?$/.test(rRaw), `${where}：宽窄比必须是 ZPL 允许的 2.0–3.0/0.1 步长写法，实得 ${rRaw}`);
  assert.ok(r >= 2 && r <= 3, `${where}：宽窄比 ${r} 超出 ZPL 手册的 2.0–3.0`);
  // 用户请求值只有在「恰好等于打印机真正会打的比例」时才允许原样下发
  const eff = geo.fixedRatio ? 1 : geo.wideDots / geo.xDots;
  const expected = geo.fixedRatio ? 2 : Math.round(Math.min(3, Math.max(2, eff)) * 10) / 10;
  assert.equal(r, expected,
    `${where}：^BY 宽窄比应为 ${expected}（fixedRatio=${geo.fixedRatio}, wideDots=${geo.wideDots}/xDots=${geo.xDots}=`
    + `${eff.toFixed(4)} 反算），实得 ${r}。写成用户原值 ${BY_REQUESTED_RATIO} 会让固件再取整一次，预览与打印分叉`);
  if (!geo.fixedRatio && Math.abs(eff - BY_REQUESTED_RATIO) > 1e-9) {
    assert.notEqual(r, BY_REQUESTED_RATIO, `${where}：${eff.toFixed(4)}:1 落不到 2.5 的整数倍，不得把用户值原样下发`);
  }
}

test('回归点-ZPL ^BY 宽窄比 = 由几何 wideDots/xDots 反算（2.7 不是笔误，也不能写回用户的 2.5）', () => {
  for (const key of BY_1D_KEYS) {
    const file = FILE(key.toLowerCase(), 'zpl');
    const geo = computeGeometry({
      sym: key, dpi: DPI, moduleWidthMm: 0.4, wideRatio: BY_REQUESTED_RATIO, content: CONTENT[key],
    });
    checkBy(file, cmdsOf(file), geo);
  }
  // 至少钉住一次「非 2.5 / 非整数」的形态，证明这条判据真的在区分反算值与用户值
  const itfGeo = computeGeometry({ sym: 'ITF', dpi: DPI, moduleWidthMm: 0.4, wideRatio: 2.5, content: CONTENT.ITF });
  assert.equal(byLine('itf.zpl.txt', cmdsOf(FILE('itf', 'zpl'))).r, 2.7,
    'ITF@203dpi/0.4mm/2.5:1 的宽条落 8 点 ⇒ 必须输出 2.7，这是本用例的锚点');
  assert.ok(Math.abs(itfGeo.wideDots / itfGeo.xDots - 2.6666667) < 1e-6);
});

test('回归点-ZPL ^BY 判据可失败：用户值直发 / 超步长小数 / 越界 / 模块宽与几何脱钩，坏样本都要炸', () => {
  const geo = { xDots: 3, wideDots: 8, fixedRatio: false }; // 正常值应得 ^BY3,2.7,96
  checkBy('好样本', '^FO10,8^BY3,2.7,96^BVN,N,96', geo);
  assert.throws(() => checkBy('坏样本-直发用户值', '^FO10,8^BY3,2.5,96^BVN,N,96', geo),
    /宽窄比应为 2\.7|落不到 2\.5 的整数倍/, '把 2.5 原样下发必须判失败');
  assert.throws(() => checkBy('坏样本-超步长', '^FO10,8^BY3,2.666667,96^BVN,N,96', geo), /0\.1 步长/);
  assert.throws(() => checkBy('坏样本-越界', '^FO10,8^BY3,3.5,96^BVN,N,96', geo), /超出 ZPL 手册的 2\.0–3\.0/);
  assert.throws(() => checkBy('坏样本-模块宽脱钩', '^FO10,8^BY4,2.7,96^BVN,N,96', geo), /第 1 段必须等于/);
  assert.throws(() => checkBy('坏样本-高度越界', '^FO10,8^BY3,2.7,9^BVN,N,9', geo), /第 3 段（高度）/);
  // 固定比例码制：第 2 段落在最小合法值 2，且不得跟着几何里的 wideDots 跑
  checkBy('好样本-固定比例', '^FO10,8^BY3,2,96^BEN,N', { xDots: 3, wideDots: 3, fixedRatio: true });
  assert.throws(() => checkBy('坏样本-固定比例', '^FO10,8^BY3,2.5,96^BEN,N', { xDots: 3, wideDots: 3, fixedRatio: true }),
    /宽窄比应为 2（/);
});

// ---------------------------------------------------------------------------
// 4. 样本数据自检（快照内容本身得是合法数据，否则「能扫」是假的）
// ---------------------------------------------------------------------------

test('样本自检-CONTENT 里的校验位/位数/字符集符合各码制规范', () => {
  assert.equal(CONTENT.EAN13.length, 13);
  assert.equal(gtinCheckDigit(CONTENT.EAN13.slice(0, 12)), CONTENT.EAN13[12]);
  assert.equal(gtinCheckDigit(CONTENT.EAN8.slice(0, 7)), CONTENT.EAN8[7]);
  assert.equal(gtinCheckDigit(CONTENT.UPC_A.slice(0, 11)), CONTENT.UPC_A[11]);
  assert.equal(gtinCheckDigit(CONTENT.ITF14.slice(0, 13)), CONTENT.ITF14[13]);
  // UPC-E 零压缩：NS=0 + 123456（末位 5–9 → 展开为 …d5d6 00000）= 012345600000
  assert.equal(gtinCheckDigit('01234560000'), CONTENT.UPC_E[7]);
  assert.equal(CONTENT.ITF.length % 2, 0, 'ITF 必须是偶数位');
  assert.match(CONTENT.CODE39, /^[0-9A-Z\-.$/+% ]+$/, 'Code39 字符集');
  assert.match(CONTENT.CODABAR, /^[A-Z][0-9$:/.+\-]+[A-Z]$/, 'Codabar 必须 A–D 起迄符');
  assert.match(CONTENT.MSI, /^\d+$/, 'MSI 仅数字');
  const gs1 = CONTENT.GS1_128;
  assert.equal(gtinCheckDigit(/\(01\)(\d{13})/.exec(gs1)![1]), /\(01\)\d{13}(\d)/.exec(gs1)![1], '(01) 的校验位要合法');
  assert.match(gs1, /\(21\).+\(30\)/, '样本要同时含定长 + 非末位变长 + 末位变长，才能覆盖 >8/GS 分支');
  assert.equal(CONTENT.DATAMATRIX_GS1, '(01)12345678901231(21)SN0007');
  assert.equal(CONTENT.DATAMATRIX_GS1_NORASTER, CONTENT.DATAMATRIX_GS1);
});

test('样本自检-同一份内容喂三个协议（横向可比），且每条用例都有回归说明', () => {
  for (const key of REQUIRED_KEYS) {
    const same = CASES.filter((c) => c.key === key);
    assert.equal(same.length, 3, `${key} 应有 3 份快照`);
    const contents = new Set(same.map((c) => live(fileNameFor(c)).content));
    assert.equal(contents.size, 1, `${key} 三协议内容必须一致，实得 ${[...contents].join(' | ')}`);
    assert.ok(CONTENT[key], `${key} 缺样本内容`);
    for (const c of same) assert.ok(c.regression.length >= 20, `${fileNameFor(c)} 回归说明太短`);
  }
  assert.equal(DPI, 203);
});
