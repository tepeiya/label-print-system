// =============================================================================
// gs1.test.ts —— GS1 应用标识符（AI）解析与 FNC1 语义落地（P7.8 交付①）
//
// 为什么要单独一套 GS1 单测：GS1-128 / GS1 DataMatrix 与普通 Code128 的差别
// **只在 FNC1**（符号起始 + 变长 AI 之后的分隔）。FNC1 丢了一个，符号仍然能扫，
// 但解出来是一整串字符而不是结构化 AI 字段——数据错、肉眼看不出、产线才暴露，
// 是最危险的那类缺陷。所以这里锁的是「分隔符出现在哪儿、绝不出现在哪儿」。
//
// 只测 core/gs1.ts + core/checksum.ts 两个纯模块（不碰生成器、不碰 bwip/网络）；
// 生成器把这些返回值写进指令的形态由 golden/*.txt 快照负责。
// 例外：第 10 节末尾对 core/barcode-renderer.ts 做**只读文本**扫描（不 import，
// 以免把 @bwip-js / sharp 拉进单元测试），锁的是「gs1BwipText 真的被两条出图路径接上」。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiLength, parseGs1, needsSeparator, gs1ToZpl, gs1ToRawStream, gs1ToBrackety, validateGs1,
  gs1ToBwipFnc1, gs1BwipText, BWIP_GS1_2D_BCIDS,
  type Gs1Component,
} from '../gs1';
import { gtinCheckDigit } from '../checksum';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GS = '\u001d';

/** 常用样本：01 定长 + 21 变长 + 30 变长（末位） */
const A01 = '(01)12345678901231';
const MIX3 = `${A01}(21)SN0007(30)1234`;

// ---------------------------------------------------------------------------
// 1. 定长 / 变长判定
// ---------------------------------------------------------------------------

test('GS1 AI-定长表：SSCC/GTIN/日期/LOCODE 返回期望位数', () => {
  assert.deepEqual(aiLength('00'), { fixed: true, length: 18 }); // SSCC
  assert.deepEqual(aiLength('01'), { fixed: true, length: 14 }); // GTIN
  assert.deepEqual(aiLength('02'), { fixed: true, length: 14 }); // 内装物 GTIN
  for (const ai of ['11', '12', '13', '15', '16', '17']) {
    assert.deepEqual(aiLength(ai), { fixed: true, length: 6 }, `日期类 AI ${ai} 必须是定长 6`);
  }
  for (const ai of ['410', '411', '412', '413', '414', '415']) {
    assert.deepEqual(aiLength(ai), { fixed: true, length: 13 }, `LOCODE AI ${ai} 必须是定长 13`);
  }
  assert.deepEqual(aiLength('7002'), { fixed: true, length: 3 });
  assert.deepEqual(aiLength('8006'), { fixed: true, length: 18 });
});

test('GS1 AI-计量类（31nn–36nn）按「前缀 + 6 位数字」定长', () => {
  // 31nn–36nn：第 1 位是小数点位权，后 5 位数值，共 6 位定长 —— 定长才不需要分隔符
  for (const ai of ['3102', '3103', '3105', '3601']) {
    assert.deepEqual(aiLength(ai), { fixed: true, length: 6 }, `计量 AI ${ai} 应为定长 6`);
  }
});

test('GS1 AI-变长表：20/21/30/37/400/420/8020 判为变长（length=null）', () => {
  for (const ai of ['10', '20', '21', '30', '37', '400', '402', '420', '421', '8020']) {
    assert.deepEqual(aiLength(ai), { fixed: false, length: null }, `AI ${ai} 应为变长`);
  }
});

test('GS1 AI-未知 AI 一律按变长处理（保守：宁可多一个分隔符，也不让扫描器串字段）', () => {
  for (const ai of ['99', '91', '240', '8999']) {
    assert.equal(aiLength(ai).fixed, false, `未知 AI ${ai} 必须判变长`);
  }
  // 这条判定的后果必须在两个序列化函数里都体现为「插分隔符」
  const unknown: Gs1Component[] = [
    { ai: '01', data: '12345678901231', fixed: true, length: 14 },
    { ai: '99', data: 'XX', fixed: aiLength('99').fixed, length: aiLength('99').length },
    { ai: '21', data: 'SN1', fixed: false, length: null },
  ];
  assert.equal(needsSeparator(unknown), true);
  assert.match(gs1ToZpl(unknown), />8\s*$|99XX>821/);
});

test('GS1 AI-计量类只认 31xx–36xx，4xxx 一律按变长（保守方向）', () => {
  // P7.8 复核修正：旧实现用 /^[34][1-6]\d{2}$/ 且只排除 41xx，把 4212/4221 这类
  // **变长的 4 位地址 AI**（Ship To 族）当成定长 6 位。后果不是"多一个分隔符"而是
  // "该插的没插"——扫描器会把地址和下一个 AI 串成一个字段，属于最危险的那类错。
  // 现在 4xxx 全部落到变长：4100 这类实际定长 13 的 GLN 地址因此多插一个分隔符，
  // 这是已知且刻意保留的偏差（查不到逐条出处就不进定长表，见 §10.27.3「三条刻意不做」）。
  assert.deepEqual(aiLength('4212'), { fixed: false, length: null });
  assert.deepEqual(aiLength('421'), { fixed: false, length: null });
  assert.deepEqual(aiLength('4101'), { fixed: false, length: null });
  assert.deepEqual(aiLength('4500'), { fixed: false, length: null });
  // 计量类仍在 31xx–36xx 内按 6 位定长
  assert.deepEqual(aiLength('3103'), { fixed: true, length: 6 });
  assert.deepEqual(aiLength('3699'), { fixed: true, length: 6 });
  // 39xx（可变计量，位数随小数位变化）不能误并进 6 位定长
  assert.deepEqual(aiLength('3923'), { fixed: false, length: null });
  // 3 位表里的 410–415 仍是定长 13，裸串优先命中它（见下一个用例）
  assert.deepEqual(aiLength('410'), { fixed: true, length: 13 });
});

test('GS1 分隔符-4212（变长地址）之后必须插 FNC1，定长 3103 之后不插', () => {
  // 这两个断言就是上面那条修正的"后果"，比 aiLength 的返回值更能说明为什么必须改
  const comps = parseGs1('(01)12345678901231(4212)Springfield(21)SN0007');
  assert.deepEqual(comps.map((c) => [c.ai, c.fixed]), [['01', true], ['4212', false], ['21', false]]);
  assert.equal(gs1ToBwipFnc1(comps), '^FNC101123456789012314212Springfield^FNC121SN0007');
  assert.match(gs1ToZpl(comps), /4212Springfield>8 21|4212Springfield>821/);
  const meas = parseGs1('(3103)001234(21)SN0007');
  assert.equal(gs1ToBwipFnc1(meas), '^FNC1310300123421SN0007');
});

// ---------------------------------------------------------------------------
// 2. (AI) 括号形式解析
// ---------------------------------------------------------------------------

test('GS1 解析-括号形式逐字段还原 AI / 数据 / 定长标记', () => {
  assert.deepEqual(parseGs1(MIX3), [
    { ai: '01', data: '12345678901231', fixed: true, length: 14 },
    { ai: '21', data: 'SN0007', fixed: false, length: null },
    { ai: '30', data: '1234', fixed: false, length: null },
  ]);
  assert.deepEqual(parseGs1(`${A01}(37)12`), [
    { ai: '01', data: '12345678901231', fixed: true, length: 14 },
    { ai: '37', data: '12', fixed: false, length: null },
  ]);
});

test('GS1 解析-括号形式里已有的 GS 分隔符被丢弃（分隔符由本模块重新判定，绝不双重计入）', () => {
  // 用户在模板里手写 (01)…\u001d(21)… 是常见输入。若保留这个 GS，序列化后会变成
  // 「数据段尾部带不可见字符」+ 模块自己再插一个 → 双分隔符，扫描器解出空字段。
  const withGs = parseGs1(`${A01}${GS}(21)SN0007`);
  assert.deepEqual(withGs, [
    { ai: '01', data: '12345678901231', fixed: true, length: 14 },
    { ai: '21', data: 'SN0007', fixed: false, length: null },
  ]);
  assert.ok(!withGs.some((c) => c.data.includes(GS)), '数据段内不得残留 GS');
});

test('GS1 解析-数据里允许出现的符号字符不被误切（> / & % / 空格以外的可打印字符）', () => {
  const comps = parseGs1('(21)A>B(30)12');
  assert.deepEqual(comps.map((c) => [c.ai, c.data]), [['21', 'A>B'], ['30', '12']]);
});

test('GS1 解析-空 / 全空白 / null 一律报「GS1 内容为空」，不返回空数组', () => {
  // 返回空数组会让上层生成出「只有起始 FNC1」的指令：符号能扫、内容为空 —— 必须抛错
  for (const bad of ['', '   ', '\t', null as unknown as string, undefined as unknown as string]) {
    assert.throws(() => parseGs1(bad), /^Error: GS1 内容为空$/, `输入 ${JSON.stringify(bad)} 应抛错`);
  }
});

test('GS1 解析-括号与裸串混写必须抛错（混写无法可靠判定字段边界，宁可拒绝也不猜）', () => {
  // '0112345678901231(21)SN0007' 里前半段没有任何括号，正则只认得 (21)：
  // 静默按「(21) 之前的都是垃圾」处理会打出错数据，所以按剩余字符报错。
  assert.throws(
    () => parseGs1('0112345678901231(21)SN0007'),
    /GS1 内容格式不完整或存在多余字符/,
  );
});

// ---------------------------------------------------------------------------
// 3. 裸串解析（定长贪婪切分）
// ---------------------------------------------------------------------------

test('GS1 解析-裸串按定长表贪婪切分：定长 AI 后不留分隔符也能切开', () => {
  assert.deepEqual(parseGs1('4101234567890123'), [
    { ai: '410', data: '1234567890123', fixed: true, length: 13 },
  ]);
  // 定长之后紧跟变长 AI：变长在末位，吃到串尾
  assert.deepEqual(parseGs1('01123456789012313012'), [
    { ai: '01', data: '12345678901231', fixed: true, length: 14 },
    { ai: '30', data: '12', fixed: false, length: null },
  ]);
});

test('GS1 解析-裸串里变长字段的数据看起来像 AI 时报错，绝不静默错切', () => {
  // '01'+'12345678901231'+'21SN0007'：变长数据 'SN0007' 中的 "00" 会被当成下一个 AI 起点，
  // 于是切出 '21SN' + '00…'。模块选择抛「定长数据不足」而不是产出错字段——
  // 这正是裸串（无分隔符）在语义上不可靠的证据：GS1 字段边界只能靠括号或 GS。
  assert.throws(() => parseGs1('011234567890123121SN0007'), /AI 00 数据长度不足，期望 18 位/);
  assert.throws(() => parseGs1('00123456789012345621SN0007'), /无法识别 GS1 应用标识符/);
});

test('GS1 解析-裸串遇到表外 AI 报出位置与残串（报错要能定位到用户输入）', () => {
  assert.throws(() => parseGs1('99abc'), /无法识别 GS1 应用标识符（位置 0）：99abc/);
});

test('GS1 解析-定长字段位数不足在 parse 阶段就抛错（裸串），括号阶段留给 validateGs1', () => {
  // 裸串必须靠位数推进指针，位数不够就无路可走 → 抛错；
  // 括号形式有明确边界，parse 如实返回 (01) 装了 3 位，validateGs1 负责报「位数不对」。
  assert.throws(() => parseGs1('01123'), /AI 01 数据长度不足，期望 14 位/);
  const bracketed = parseGs1('(01)123');
  assert.deepEqual(bracketed, [{ ai: '01', data: '123', fixed: true, length: 14 }]);
  assert.deepEqual(validateGs1(bracketed), ['AI (01) 为定长 14 位，实际 3 位：123']);
});

// ---------------------------------------------------------------------------
// 4. needsSeparator
// ---------------------------------------------------------------------------

test('GS1 分隔判定-只有「变长 AI 且后面还有 AI」才需要分隔符', () => {
  assert.equal(needsSeparator(parseGs1(`${A01}(21)SN0007(30)1234`)), true, '21 变长且后面还有 30');
  assert.equal(needsSeparator(parseGs1(`${A01}(37)12`)), false, '37 变长在末位：不需要');
  assert.equal(needsSeparator(parseGs1(`${A01}(11)251231`)), false, '全是定长：不需要');
  assert.equal(needsSeparator(parseGs1(A01)), false, '单字段：不需要');
});

test('GS1 分隔判定-末尾分隔符必须为 false（GS1 规范：末位之后的 FNC1 无意义）', () => {
  // 多打一个尾部分隔符，部分解码器会解出一个空字段（AI 数量对不上），
  // 所以 needsSeparator 的语义是「中间是否需要插」，不是「是否存在变长 AI」。
  const lastIsVariable = parseGs1(`${A01}(21)SN0007`);
  assert.equal(lastIsVariable.some((c) => !c.fixed), true);
  assert.equal(needsSeparator(lastIsVariable), false);
});

// ---------------------------------------------------------------------------
// 5. ZPL 序列化：>; 与 >8
// ---------------------------------------------------------------------------

test('GS1→ZPL-恒定以 >;（起始 FNC1）开头，单字段也不例外', () => {
  assert.equal(gs1ToZpl(parseGs1(A01)), '>;0112345678901231');
  assert.ok(gs1ToZpl(parseGs1(MIX3)).startsWith('>;'));
});

test('GS1→ZPL-变长 AI 之后插 >8，定长 AI 之后不插，末位之后不插', () => {
  assert.equal(gs1ToZpl(parseGs1(MIX3)), '>;011234567890123121SN0007>8301234');
  // 01 定长 → 不插；21 变长且后面有 30 → 插；30 末位 → 不插
  assert.equal(gs1ToZpl(parseGs1(`${A01}(11)251231`)), '>;011234567890123111251231');
  assert.equal(gs1ToZpl(parseGs1(`${A01}(21)SN0007`)), '>;011234567890123121SN0007');
  assert.equal(gs1ToZpl(parseGs1('(21)SN0007(30)12(37)999')), '>;21SN0007>83012>837999');
});

test('GS1→ZPL->8 的出现次数 = 非末位的变长 AI 个数', () => {
  const comps = parseGs1(`${A01}(21)SN0007(10)LOT(30)12`);
  const variables = comps.slice(0, -1).filter((c) => !c.fixed).length;
  assert.equal((gs1ToZpl(comps).match(/>8/g) ?? []).length, variables);
});

test('GS1→ZPL-Code128 里的字面 > 必须转成 >>（> 是 FNC 引导符）', () => {
  assert.equal(
    gs1ToZpl(parseGs1('(21)A>B(30)12'), (s) => s.replace(/>/g, '>>')),
    '>;21A>>B>83012',
  );
});

test('GS1→ZPL-escapeData 只作用在数据段：AI 数字、>; 与 >8 都不被污染（行为契约）', () => {
  // 生成器把协议转义函数注入进来。若实现图省事对整串结果做转义，
  // '>;' 会变成 '>>;'（FNC1 消失，退化成普通 Code128）、'>8' 变成 '>>8'（字面 >>8）。
  // 这两类错误都能印能扫，但解出来的是错数据 —— 所以这条是契约而不是风格。
  const seen: string[] = [];
  const esc = (s: string) => { seen.push(s); return s.replace(/>/g, '>>').replace(/~/g, '~~'); };
  const comps = parseGs1(`${A01}(21)A>B(30)1~2`);
  const out = gs1ToZpl(comps, esc);
  assert.deepEqual(seen, ['12345678901231', 'A>B', '1~2'], 'escapeData 收到的必须只有数据段');
  assert.ok(!seen.some((s) => /^\(\d{2,4}\)$/.test(s) || s.includes('>8') || s.includes('>;')),
    '不得把 AI 括号或 FNC1 转义序列交给协议转义函数');
  assert.ok(out.startsWith('>;') && !out.startsWith('>>;'), `起始 FNC1 必须原样存在：${out}`);
  assert.ok(out.includes('>8') && !out.includes('>>8'), `分隔 FNC1 必须原样存在：${out}`);
  assert.equal(out, '>;011234567890123121A>>B>8301~~2');
});

test('GS1→ZPL-默认转义是恒等（调用方不注入时不改数据）', () => {
  assert.equal(gs1ToZpl(parseGs1('(21)A>B')), '>;21A>B');
});

// ---------------------------------------------------------------------------
// 6. 裸数据流序列化（0x1D）
// ---------------------------------------------------------------------------

test('GS1→裸流-变长 AI 之后是裸 0x1D（GS），定长之后与末尾都没有', () => {
  const raw = gs1ToRawStream(parseGs1(MIX3));
  assert.equal(raw, `011234567890123121SN0007${GS}301234`);
  assert.ok(!raw.startsWith(GS) && !raw.endsWith(GS), '首尾不得有 GS');
  assert.equal((raw.match(/\u001d/g) ?? []).length, 1, '只有一个变长 AI 非末位');
});

test('GS1→裸流-不含任何 ZPL 转义痕迹（该写法服务 TSPL/EPL 的原始数据段）', () => {
  const raw = gs1ToRawStream(parseGs1(`${A01}(21)SN0007(30)1234`));
  assert.doesNotMatch(raw, />/);
  // 数据里的 > 保持字面量：裸流没有 FNC 引导符语义，转义反而会把 > 变成两个字符
  assert.equal(gs1ToRawStream(parseGs1('(21)A>B(30)12')), `21A>B${GS}3012`);
});

test('GS1→裸流-起始不插任何分隔符（起始 FNC1 由指令参数/码型承担，不在数据里）', () => {
  const raw = gs1ToRawStream(parseGs1('(01)12345678901231'));
  assert.equal(raw, '0112345678901231');
});

// ---------------------------------------------------------------------------
// 7. 括号形式（位图通道 / bwip parsefnc）
// ---------------------------------------------------------------------------

test('GS1→括号形式与 parseGs1 互为逆运算（位图通道与原生通道的 AI 结构必须一致）', () => {
  const comps = parseGs1(MIX3);
  const brackety = gs1ToBrackety(comps);
  assert.equal(brackety, MIX3);
  assert.deepEqual(parseGs1(brackety), comps, '括号形式再解析一次必须逐字段相同');
  assert.doesNotMatch(brackety, /\u001d|>/, '括号形式不带任何分隔符/转义，FNC1 由 bwip parsefnc 负责');
});

// ---------------------------------------------------------------------------
// 8. validateGs1 报错口径
// ---------------------------------------------------------------------------

test('GS1 校验-合法内容返回空数组（空数组是「通过」的唯一表示，不能返回 undefined）', () => {
  assert.deepEqual(validateGs1(parseGs1(`${A01}(21)SN0007`)), []);
  // SSCC 必须带正确的 Mod10 校验位：12345678901234567 的校验位是 5。
  // （历史上这条写的是 123456789012345678，那时 validateGs1 还算不出校验位，见下一条用例。）
  assert.equal(gtinCheckDigit('12345678901234567'), '5');
  assert.deepEqual(validateGs1(parseGs1('(00)123456789012345675')), []);
});

test('GS1 校验-定长位数不符：中文提示带上 AI、期望位数、实际位数与实际数据', () => {
  assert.deepEqual(validateGs1([{ ai: '01', data: '123', fixed: true, length: 14 }]),
    ['AI (01) 为定长 14 位，实际 3 位：123']);
});

test('GS1 校验-定长 AI 只允许数字（位数对但装了字母同样是错码）', () => {
  assert.deepEqual(validateGs1([
    { ai: '01', data: '12345678901231', fixed: true, length: 14 },
    { ai: '11', data: '2512AB', fixed: true, length: 6 },
  ]), ['AI (11) 只允许数字：2512AB']);
});

test('GS1 校验-变长数据超 30 字符 / 内含分隔符分别报错', () => {
  const head: Gs1Component = { ai: '01', data: '12345678901231', fixed: true, length: 14 };
  assert.ok(validateGs1([head, { ai: '21', data: 'x'.repeat(31), fixed: false, length: null }])
    .some((e) => /AI \(21\) 变长数据超过 30 字符/.test(e)));
  assert.ok(validateGs1([head, { ai: '21', data: `a${GS}b`, fixed: false, length: null }])
    .some((e) => /AI \(21\) 数据内含分隔符，需拆分/.test(e)));
  assert.deepEqual(validateGs1([head, { ai: '21', data: 'x'.repeat(30), fixed: false, length: null }]), [],
    '正好 30 字符不该报错（上限是闭区间）');
});

test('GS1 校验-首个 AI 非 (00)/(01)/(02) 给「建议」提示（不是硬错，其它字段仍照打）', () => {
  const ADVISORY = '首个 AI 为 (21)，GS1 建议以 (00)/(01)/(02) 开头以保证识别';
  const errs = validateGs1([
    { ai: '21', data: 'A', fixed: false, length: null },
    { ai: '20', data: 'B', fixed: false, length: null },
  ]);
  assert.deepEqual(errs, [ADVISORY]);
  // 豁免条件是「串里存在 00/01/02」而不是「首位是 00/01/02」：(01) 放在中间也不再提示。
  // 后果如实记录：AI 顺序不符合 GS1 推荐（GTIN 应打头）时扫码端仍可能整串按 Code128 解，
  // 但当前实现不会提醒用户 —— 属可改进项，不是 P7.8 该动的地方。
  const middle = validateGs1([
    { ai: '21', data: 'A', fixed: false, length: null },
    { ai: '01', data: '12345678901231', fixed: true, length: 14 },
  ]);
  assert.deepEqual(middle, [], '存在 (01) 即豁免（some 判定，与位置无关）');
  // 02（内装物 GTIN）与 00/01 同等豁免
  assert.deepEqual(validateGs1([{ ai: '02', data: '12345678901231', fixed: true, length: 14 }]), []);
  // 只有 30（变长计数）这种「无任何 GTIN」的组合才提示
  assert.deepEqual(validateGs1([{ ai: '30', data: '12', fixed: false, length: null }]),
    ['首个 AI 为 (30)，GS1 建议以 (00)/(01)/(02) 开头以保证识别']);
});

test('GS1 校验-相同提示去重，不同数据的同类错误各自列出（便于定位字段）', () => {
  const dup = validateGs1([
    { ai: '01', data: '1', fixed: true, length: 14 },
    { ai: '01', data: '1', fixed: true, length: 14 },
  ]);
  assert.equal(dup.length, 1, JSON.stringify(dup));
  const distinct = validateGs1([
    { ai: '01', data: '1', fixed: true, length: 14 },
    { ai: '01', data: '2', fixed: true, length: 14 },
  ]);
  assert.deepEqual(distinct, [
    'AI (01) 为定长 14 位，实际 1 位：1',
    'AI (01) 为定长 14 位，实际 1 位：2',
  ]);
});

test('GS1 校验-定长位数不符时不再叠加「只允许数字」（continue 短路，错误口径唯一）', () => {
  assert.deepEqual(validateGs1([
    { ai: '01', data: '12345678901231', fixed: true, length: 14 },
    { ai: '11', data: 'AB', fixed: true, length: 6 },
  ]), ['AI (11) 为定长 6 位，实际 2 位：AB']);
});

test('GS1 校验-Mod10 校验位只查 (00)/(01)/(02)，其余带数字的 AI 一律不算（P7.8 复核补上的缺口）', () => {
  // 原来 validateGs1 只看位数与字符集，校验位错了照样放行 ⇒ 扫描器能扫出字段、复核才发现数据不对。
  // 现在算校验位，但**只**对语义有出处的三项：误报一条 warning 会让用户对正确数据起疑。
  assert.equal(gtinCheckDigit('1234567890123'), '1');
  assert.deepEqual(validateGs1(parseGs1('(01)12345678901239')), [
    'AI (01) GTIN 校验位错误：末位应为 1，实际 9（12345678901239）',
  ]);
  assert.deepEqual(validateGs1(parseGs1('(02)12345678901239')), [
    'AI (02) 内装物 GTIN 校验位错误：末位应为 1，实际 9（12345678901239）',
  ]);
  assert.deepEqual(validateGs1(parseGs1('(00)123456789012345678')), [
    'AI (00) SSCC 校验位错误：末位应为 5，实际 8（123456789012345678）',
  ]);
  // 正确校验位必须放行（否则上面的报错会误伤合法数据）
  assert.deepEqual(validateGs1(parseGs1('(01)12345678901231')), []);
  assert.deepEqual(validateGs1(parseGs1('(02)12345678901231(01)12345678901231')), []);
  // (03)/(04)/(08)/(12) 也带数字，但「末位是不是 GTIN 校验位」本仓库没有可核验出处 ⇒ 不校验。
  // 这条断言的意义：谁哪天把这些 AI 也塞进校验表，这里会显式变红，逼他补出处。
  assert.deepEqual(validateGs1([
    { ai: '01', data: '12345678901231', fixed: true, length: 14 },
    { ai: '12', data: '12345678901239', fixed: true, length: 14 },
  ]), [], 'AI 12 不参与校验位判定');
  // 位数不符时 continue 短路，不会再来一条校验位错误（同一字段只报最本质的那条）
  assert.deepEqual(validateGs1([{ ai: '01', data: '1234567890123', fixed: true, length: 14 }]), [
    'AI (01) 为定长 14 位，实际 13 位：1234567890123',
  ]);
  // 非数字时也不叠加校验位错误（gtinCheckDigit 对字母无定义）
  assert.deepEqual(validateGs1([
    { ai: '01', data: '1234567890123A', fixed: false, length: null },
  ]), [], '变长标记 + 非数字：既不报数字集也不报校验位（定长信息在组件里就丢了）');
});

// ---------------------------------------------------------------------------
// 9. GTIN 校验位（AI (01)/(02)/(00) 与一维码制的共用算法）
// ---------------------------------------------------------------------------

test('校验位-GTIN-14 / EAN-13 / EAN-8 / UPC-A 用同一套 Mod10（3-1 加权从右往左）', () => {
  assert.equal(gtinCheckDigit('1001234560001'), '9'); // GTIN-14（ITF-14 承载）
  assert.equal(gtinCheckDigit('690123456789'), '2');  // EAN-13
  assert.equal(gtinCheckDigit('9638507'), '4');       // EAN-8
  assert.equal(gtinCheckDigit('01234567890'), '5');   // UPC-A 11 位
  assert.equal(gtinCheckDigit('1234567890123'), '1'); // GS1 (01) 数据
  assert.equal(gtinCheckDigit('12345678901234567'), '5'); // SSCC (00) 的前 17 位
});

test('校验位-全 0 与含前导 0 的位数不能被截断（前导 0 是 GTIN 的一部分）', () => {
  assert.equal(gtinCheckDigit('0000000000000'), '0');
  assert.equal(gtinCheckDigit('0123456789012'), '8');
  assert.equal(gtinCheckDigit('00123456789012'), '8');
  // 位数决定加权起点（从右往左 3-1 交替），所以同一段数字多一位前导 0 结果可能不同：
  // 这里如实钉住 12/13 位同值这一事实，任何实现把前导 0 截掉都会改变这些数。
  assert.equal(gtinCheckDigit('123456789012'), gtinCheckDigit('0123456789012'));
  assert.notEqual(gtinCheckDigit('123456789012'), gtinCheckDigit('1234567890123'));
});

// ---------------------------------------------------------------------------
// 10. bwip `^FNC1` 文本改写（P7.8 追加）—— 真缺陷的回归锁，优先级最高
//
// 缺陷本体：bwip-js 的 datamatrix / qrcode / aztec **不解析**括号或方括号 AI。
// 实测（zxing-cpp 3.x 读 bwip-js 4.x 出图，scale=4）：
//   · `(01)04251234567890(10)AB789` + parsefnc → 符号标识 `]d1`（普通 DataMatrix），
//     bytes 里带字面括号 ⇒ AI 结构全丢，扫出来是一整串文本。这就是「数据错但肉眼看不出」。
//   · `[01]…` + parse:true 同样是字面量 ⇒ parse:true 对二维无效。
//   · 只有喂 `^FNC1` + 去括号 AI 链才得到 `]d2`（GS1 DataMatrix）/ `]Q3`（GS1 QR），
//     bytes = `0104251234567890\x1d10AB789`（定长段后不插分隔、末位不插）。
// 本节约的是「AI 链 → ^FNC1 文本」这层纯函数语义；出图端到端由
// backend/scripts/p7-acceptance.sh C 段（zxing-cpp 解码）负责。
// ---------------------------------------------------------------------------

const FNC1_RE = /\^FNC1/g;

test('GS1→bwip FNC1-恒定以 ^FNC1 起始（符号级 FNC1），单字段也不例外', () => {
  const s = gs1ToBwipFnc1(parseGs1(A01));
  assert.equal(s, '^FNC10112345678901231');
  assert.ok(s.startsWith('^FNC1'), s);
  assert.equal(s.match(FNC1_RE)!.length, 1, '只有起始一个：定长 GTIN 之后不需要分隔符');
  // 括号必须被彻底去掉：留下任何一个括号，bwip 就把它当数据编进符号（]d1 而非 ]d2）
  assert.doesNotMatch(s, /[()[\]]/, '文本里不得残留括号/方括号');
});

test('GS1→bwip FNC1-空组件数组仍返回 "^FNC1"，绝不返回空串', () => {
  // 空串 = 连起始 FNC1 都没有 = 静默退化成普通符号。这条比「出图失败」危险得多，钉死。
  assert.equal(gs1ToBwipFnc1([]), '^FNC1');
  assert.equal(gs1ToBwipFnc1([]).match(FNC1_RE)!.length, 1);
});

test('GS1→bwip FNC1-变长 AI 之后才插 ^FNC1；定长之后不插、末位之后不插', () => {
  // (01) 定长 + (10) 变长：变长在末位 ⇒ 全串只有一个标记
  assert.equal(
    gs1ToBwipFnc1(parseGs1('(01)04251234567890(10)AB789')),
    '^FNC1010425123456789010AB789',
  );
  // (10) 变长且后面还有 (30) ⇒ 插一个；(30) 在末位 ⇒ 不插
  assert.equal(gs1ToBwipFnc1(parseGs1('(10)AB789(30)12')), '^FNC110AB789^FNC13012');
  // 三段：01 定长（不插）→ 10 变长非末位（插）→ 37 变长非末位（插）→ 26 末位（不插）
  assert.equal(
    gs1ToBwipFnc1(parseGs1('(01)04251234567890(10)AB789(37)12(26)0315')),
    '^FNC1010425123456789010AB789^FNC13712^FNC1260315',
  );
  // 变长在前、定长在后：分隔符照样要插（否则扫描器无法知道 21 在哪结束）
  assert.equal(
    gs1ToBwipFnc1(parseGs1('(21)SN0007(01)04251234567890')),
    '^FNC121SN0007^FNC10104251234567890',
  );
});

test('GS1→bwip FNC1-标记数 = 1 + 非末位变长 AI 数（与 needsSeparator 同一判据）', () => {
  const corpus = [
    A01, MIX3, '(10)AB(21)CD(30)1', '(21)SN0007', '(21)SN0007(01)04251234567890',
    '(00)123456789012345678', '(410)1234567890123(21)SN', '(8020)x(30)1(10)Z',
  ];
  for (const c of corpus) {
    const comps = parseGs1(c);
    const varNonLast = comps.filter((x, i) => !x.fixed && i < comps.length - 1).length;
    const markers = (gs1ToBwipFnc1(comps).match(FNC1_RE) ?? []).length;
    assert.equal(markers, 1 + varNonLast, `${c} 应有 1 个起始 + ${varNonLast} 个分隔，实得 ${markers - 1}`);
  }
});

test('GS1→bwip FNC1-三种序列化（^FNC1 / >8 / 0x1D）的分隔符位置必须逐条一致', () => {
  // 一条 AI 链在 ZPL 原生、TSPL/EPL 裸流、bwip 位图三条通道上必须表达**同一个**字段边界。
  // 任何一个通道少插/多插一个分隔符，都会让「同一模板打出来的两种标签扫出不同字段」。
  const corpus = [MIX3, '(10)AB(21)CD(30)1', '(21)SN0007(01)04251234567890', A01,
    '(01)04251234567890(10)AB789(37)12(26)0315'];
  for (const c of corpus) {
    const comps = parseGs1(c);
    const sep = (s: string, re: RegExp) => (s.match(re) ?? []).length;
    const zpl = sep(gs1ToZpl(comps), />8/g);
    const raw = sep(gs1ToRawStream(comps), /\u001d/g);
    const fnc = sep(gs1ToBwipFnc1(comps), FNC1_RE) - 1; // 扣掉起始
    assert.equal(zpl, raw, `${c}：ZPL >8=${zpl} 与裸流 GS=${raw} 不一致`);
    assert.equal(zpl, fnc, `${c}：ZPL >8=${zpl} 与 bwip ^FNC1 分隔=${fnc} 不一致`);
  }
});

test('GS1→bwip FNC1-数据里的字面 ^ 必须写成 ^^（否则 bwip 报 bwipp.truncatedFNC）', () => {
  // ^ 在 bwip 的 parsefnc 文本里是 FNC 引导符；不转义会把 'A^B' 里的 '^B' 当残缺标记吃掉。
  assert.equal(gs1ToBwipFnc1(parseGs1('(10)A^B(30)12')), '^FNC110A^^B^FNC13012');
  assert.equal(gs1ToBwipFnc1(parseGs1('(21)A^B^C(30)9')), '^FNC121A^^B^^C^FNC1309');
  // 已经写成 ^^ 的数据不能二次转义成 ^^^^？—— 会：parse 保留数据原样，本函数只管「数据里的 ^」。
  // 这是**如实现状**：调用方喂进来的是逻辑数据（一个 ^），不是 bwip 文本，所以 1 个 ^ → ^^ 是对的。
  assert.equal(gs1ToBwipFnc1(parseGs1('(10)A^^B(30)12')), '^FNC110A^^^^B^FNC13012');
  // 转义必须只作用在数据段：^FNC1 标记本身是字面 5 字符，不能被再转义成 ^^FNC1
  const s = gs1ToBwipFnc1(parseGs1('(10)A^B'));
  assert.ok(s.startsWith('^FNC1'), s);
  assert.equal(s, '^FNC110A^^B');
  // 去掉标记后剩下的 ^ 个数 = 起始 1 个 + 数据转义 ^^ 2 个 = 3；实现漏转义时只会数到 2
  assert.equal(s.replace(/FNC1/g, '').split('^').length - 1, 3, '起始标记 1 个 + 数据里 ^^ 2 个');
  // 剥离标记并把 ^^ 折回 ^ 后，必须精确还原数据（证明转义无损、不多不少）
  const stripped = s.replace(FNC1_RE, '|').replace(/\^\^/g, '^');
  assert.equal(stripped, '|10A^B', stripped);
});

test('GS1→bwip 名单-四种二维 bcid 改写结果一致；PDF417 / gs1-128 明确不在名单', () => {
  assert.deepEqual(BWIP_GS1_2D_BCIDS, ['datamatrix', 'datamatrixrectangular', 'qrcode', 'microqrcode', 'azteccode']);
  const expect = gs1ToBwipFnc1(parseGs1('(01)04251234567890(10)AB789'));
  for (const bcid of ['datamatrix', 'datamatrixrectangular', 'qrcode', 'azteccode']) {
    assert.equal(gs1BwipText(bcid, '(01)04251234567890(10)AB789'), expect, bcid);
  }
  // gs1-128：bwip 自己解析括号 AI（实测 ]C1、bytes 无括号），喂 ^FNC1 反而报 bwipp.GS1aiMissingOpenParen
  assert.equal(gs1BwipText('gs1-128', '(01)04251234567890(10)AB789'), undefined, 'gs1-128 不得被改写');
  // pdf417：GS1 AI 在 PDF417 走 Composite 链接语义，不是「起始 FNC1 + GS 分隔」这套
  assert.equal(gs1BwipText('pdf417', '(01)04251234567890(10)AB789'), undefined, 'pdf417 不在改写名单');
  assert.equal(gs1BwipText('code128', '(01)04251234567890(10)AB789'), undefined, '一维 bcid 一律不改写');
});

test('GS1→bwip 名单-内容没有 (dd) 括号 AI 时返回 undefined（普通文本不得被加 FNC1）', () => {
  for (const t of ['HELLO-1', 'https://example.com/scan-me', 'HELLO (ab)', '(AB)12', '', '   ']) {
    assert.equal(gs1BwipText('datamatrix', t), undefined, `不该改写：${JSON.stringify(t)}`);
  }
  // 4 位 AI 也算 GS1 内容（\(\d{2,4}\)），必须改写，否则 (8020)/(410) 这类会退化成字面括号
  assert.equal(gs1BwipText('datamatrix', '(8020)123'), '^FNC18020123');
  // ⚠️ 如实记录一个缺口：方括号形式 [01]… 正则不认 ⇒ 返回 undefined ⇒ 原文本进 bwip
  // ⇒ 括号被当字面量编进符号（实测仍是 ]d1）。本函数**不**负责兜下方括号，
  // 谁要是把这条改成「undefined 也算改写成功」，这个缺口就会被藏起来。
  assert.equal(gs1BwipText('datamatrix', '[01]04251234567890[10]AB789'), undefined);
});

test('GS1→bwip microqrcode 必须显式拒绝并给出可执行替代（不得悄悄退化成带括号的普通 Micro QR）', () => {
  // 名单里唯一「语义上该支持、本实现做不出来」的一档：bwip-js 对**任何** ^FNC1 文本都报
  // bwipp.qrcodeNoValidSymbol（实测，连 (13)260101 这种最短定长 AI 也一样）。
  // 抛错而不是回退原文本：回退 = 打出 ]Q1 带字面括号的错码。
  for (const content of ['(01)04251234567890(10)AB789', '(13)260101']) {
    assert.throws(
      () => gs1BwipText('microqrcode', content),
      (e: Error) => {
        assert.match(e.message, /Micro QR/);
        assert.match(e.message, /bwipp\.qrcodeNoValidSymbol/, '报错要说清是 bwip 出不了图，不是我们没实现');
        assert.match(e.message, /DATAMATRIX|QRCODE/, '必须给出可执行替代，否则用户只会反复点打印');
        return true;
      },
      content,
    );
  }
  // 非 GS1 内容不进 microqrcode 的抛错分支（普通 Micro QR 是合法的，不该被拒）
  assert.equal(gs1BwipText('microqrcode', 'HELLO-1'), undefined);
});

test('GS1→bwip AI 结构解析失败必须抛错（宁可不打，不打错码）', () => {
  // 括号链不完整 → parseGs1 抛 → gs1BwipText 抛；raster 的 try/catch 把它转成 [位图] warning 并跳过。
  assert.throws(() => gs1BwipText('datamatrix', '(01)04251234567890 junk('), /GS1 内容格式不完整或存在多余字符/);
  assert.throws(() => gs1BwipText('qrcode', '(01)04251234567890(10'), /格式不完整或存在多余字符：\(10/);
  // 已知现状（疑点，非期望）：多余的右括号 / 括号+方括号混写**不**抛错，而是被折进前一个 AI 的数据段，
  // 于是 (01) 的「数据」变成 15 位 / 21 位。validateGs1 能报位数不符，但位图通道不调用它 ⇒ 结构错误
  // 只在原生通道有提示。这两条把「现状确实如此」钉住，将来位图通道补校验时会显式失败。
  assert.equal(gs1BwipText('qrcode', '(01)04251234567890)'), '^FNC10104251234567890)');
  assert.deepEqual(validateGs1(parseGs1('(01)04251234567890)')), [
    'AI (01) 为定长 14 位，实际 15 位：04251234567890)',
  ]);
  const mixed = gs1BwipText('datamatrix', '(01)04251234567890 [10]AB');
  assert.equal(mixed, '^FNC10104251234567890 [10]AB');
  assert.deepEqual(validateGs1(parseGs1('(01)04251234567890 [10]AB')), [
    'AI (01) 为定长 14 位，实际 21 位：04251234567890 [10]AB',
  ]);
});

test('GS1→bwip 接线-barcode-renderer 两条出图路径都必须走 gs1BwipText 并同时开 parsefnc', () => {
  // 只读源码文本（不 import，避免把 @bwip-js / sharp 拉进单元测试）。
  // 缺陷形态：改写了 gs1ToBwipFnc1 却忘了在 option builder 里调用 ⇒ 出图仍是 ]d1 错码，
  // 而 gs1.test.ts 全绿。所以这里锁「调用点存在」，端到端由验收脚本 C 段（zxing-cpp 解出 ]d2/]Q3）锁。
  const src = readFileSync(join(__dirname, '..', 'barcode-renderer.ts'), 'utf8');
  const bw = src.indexOf('export function barcodeBwipOptions');
  const qr = src.indexOf('export function qrcodeBwipOptions');
  const end = src.indexOf('/** 生成 SVG', qr);
  assert.ok(bw > 0 && qr > bw, '两个 option builder 都要找得到');
  const oneD = src.slice(bw, qr);
  const twoD = src.slice(qr, end > 0 ? end : src.length);
  for (const [name, body] of [['barcodeBwipOptions', oneD], ['qrcodeBwipOptions', twoD]] as const) {
    assert.match(body, /bwipGs1Text\(/, `${name} 必须调用 bwipGs1Text（→ gs1BwipText）`);
    assert.match(body, /o\.text = g;/, `${name} 拿到改写文本后必须替换 o.text`);
    assert.match(body, /parsefnc\s*=\s*true/, `${name} 改写后必须开 parsefnc，否则 ^FNC1 会被当字面量`);
  }
  // 一维 gs1-128 走 bwip 自解析：只开 parsefnc、绝不改 text（改了报 bwipp.GS1aiMissingOpenParen）
  assert.match(oneD, /bcid === 'gs1-128'/, 'gs1-128 必须有独立分支');
  const g128 = oneD.slice(oneD.indexOf("bcid === 'gs1-128'"));
  const g128Body = g128.slice(0, g128.indexOf('} else'));
  assert.ok(g128Body.length > 20, 'gs1-128 分支体没切出来');
  assert.doesNotMatch(g128Body, /o\.text\s*=/, 'gs1-128 分支不得替换 text（bwip 自己解析括号 AI）');
  assert.match(g128Body, /parsefnc\s*=\s*true/, 'gs1-128 仍要开 parsefnc');
  // 导入链：barcode-renderer 必须从 ./gs1 拿这两个纯函数（谁哪天顺手改成内联复制，这里就红）
  assert.match(src, /import \{ gs1BwipText \} from '\.\/gs1'/);
  // bwipGs1Text 只是 gs1BwipText 的转发（防止两份名单/两套转义各写一遍）
  const fwd = src.slice(src.indexOf('export function bwipGs1Text'), src.indexOf('// ------', src.indexOf('export function bwipGs1Text')));
  assert.match(fwd, /return gs1BwipText\(bcid, content\);/, 'bwipGs1Text 必须是纯转发');
});

test('GS1→bwip 名单-位图通道不做 validateGs1 结构校验（如实记录现状，补校验时这条会红）', () => {
  // 原生通道（zpl/tspl 生成器）会调 validateGs1 出 warning；位图通道只走 gs1BwipText。
  // 后果：(01) 装了 20 位在原生通道有提示、在位图通道静默出图。这是刻意钉住的**已知不对称**。
  const src = readFileSync(join(__dirname, '..', 'raster.ts'), 'utf8');
  assert.doesNotMatch(src, /validateGs1/, 'raster.ts 目前不校验 GS1 结构：一旦补上，请同时更新本用例与 golden 说明');
  for (const gen of ['zpl-generator.ts', 'tspl-generator.ts']) {
    const g = readFileSync(join(__dirname, '..', gen), 'utf8');
    assert.match(g, /validateGs1\(/, `${gen} 应当继续调用 validateGs1`);
  }
});
