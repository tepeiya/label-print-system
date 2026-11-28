// P8.4 GS1 AI 字典与合规校验单测（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GS1_AI, lookupAi, gs1Catalog, gs1FieldHelp, validateAiValue, validateGs1, stripEmptyGs1Ais,
} from '../gs1-ai';
import { encodeGs1 } from '../symbology.capabilities';

// ------------------------------ 字典自洽 ------------------------------
test('字典自洽：AI 为 2–4 位数字、定长/变长互斥、无重复', () => {
  const list = Object.values(GS1_AI);
  assert.ok(list.length >= 50, `常用 AI 数量应 >= 50，实际 ${list.length}`);
  const seen = new Set<string>();
  for (const a of list) {
    assert.match(a.ai, /^\d{2,4}$/);
    assert.ok(!seen.has(a.ai), `AI ${a.ai} 重复`);
    seen.add(a.ai);
    assert.ok(!!a.fixedLen !== !!a.maxLen, `AI(${a.ai}) 必须且只能有一种长度约束`);
    if (a.fixedLen) assert.ok(a.fixedLen > 0 && a.fixedLen <= 34);
    if (a.maxLen) assert.ok(a.maxLen > 0 && a.maxLen <= 90);
  }
});

test('lookupAi：精确命中 + 4 位模式族 + 未登记返回 null', () => {
  assert.equal(lookupAi('01')?.title.includes('GTIN'), true);
  assert.equal(lookupAi('3102')?.fixedLen, 6, '31xx 度量族为 4 位 AI + 6 位值');
  assert.match(lookupAi('3902')?.title ?? '', /金额/);
  assert.equal(lookupAi('415')?.fixedLen, 13, '41x GLN 族');
  assert.equal(lookupAi('7031')?.group, '追溯');
  assert.equal(lookupAi('95')?.group, '内部');
  assert.equal(lookupAi('9999'), null);
  assert.equal(lookupAi(''), null);
});

test('gs1Catalog：分组完整、含免责声明与模式族说明', () => {
  const c = gs1Catalog();
  assert.ok(c.groups.length >= 5);
  assert.ok(c.groups.every((g) => g.items.length > 0));
  assert.equal(c.totalExact, Object.keys(GS1_AI).length);
  assert.ok(c.patterns.length >= 4);
  assert.match(c.disclaimer, /非 GS1 General Specifications 全量/);
});

// ------------------------------ 单字段校验 ------------------------------
test('validateAiValue：定长 AI 长度、字符集、空值', () => {
  assert.equal(validateAiValue('01', '12345678901231').errors.length, 0);
  assert.match(validateAiValue('01', '123').errors.join(' '), /应为 14 位/);
  assert.match(validateAiValue('01', '1234567890123A').errors.join(' '), /仅允许数字/);
  assert.match(validateAiValue('10', '').errors.join(' '), /值为空/);
  assert.equal(validateAiValue('10', 'AB12').errors.length, 0);
  assert.match(validateAiValue('10', 'A'.repeat(21)).errors.join(' '), /最长 20 位/);
});

test('validateAiValue：值含括号会破坏 AI 分段，必须拒绝', () => {
  assert.match(validateAiValue('10', 'AB(12').errors.join(' '), /\(/);
});

test('validateAiValue：YYMMDD 日期月/日范围', () => {
  assert.equal(validateAiValue('17', '251231').errors.length, 0);
  assert.match(validateAiValue('17', '251332').errors.join(' '), /月\/日不合法/);
  assert.match(validateAiValue('17', '250032').errors.join(' '), /月\/日不合法/);
  assert.match(validateAiValue('17', '2512AB').errors.join(' '), /仅允许数字/);
});

test('validateAiValue：模 10 校验位（GTIN/SSCC/GLN）', () => {
  const ok = validateAiValue('01', '12345678901231');
  assert.equal(ok.checkDigitOk, true);
  const bad = validateAiValue('01', '12345678901232');
  assert.equal(bad.checkDigitOk, false);
  assert.match(bad.errors.join(' '), /校验位错误/);
  // SSCC 18 位同样校验
  assert.equal(validateAiValue('00', '123456789012345675').checkDigitOk, true);
});

test('validateAiValue：未登记 AI 只给 warning，不冒充已校验', () => {
  const v = validateAiValue('8888', 'ABC');
  assert.equal(v.errors.length, 0);
  assert.match(v.warnings.join(' '), /未在本产品字典登记/);
  assert.match(v.hint, /未登记/);
});

test('gs1FieldHelp：已登记给出定长/变长提示与示例；未登记明确提示', () => {
  assert.match(gs1FieldHelp('01').hint, /定长 14 位/);
  assert.match(gs1FieldHelp('10').hint, /最长 20 位/);
  assert.equal(gs1FieldHelp('01').example, '12345678901231');
  assert.equal(gs1FieldHelp('9999').found, false);
});

// ------------------------------ 整串校验 ------------------------------
test('validateGs1：P7 golden 内容仍合法（委托后行为不变）', () => {
  const v = validateGs1('(01)12345678901231(17)251231');
  assert.equal(v.ok, true);
  assert.equal(v.errors.length, 0);
  assert.equal(v.separators, 0);
  assert.equal(v.data, '011234567890123117251231');
  assert.equal(v.fnc1Prefix, true);
  assert.equal(v.fields.length, 2);
  assert.equal(v.fields[0].checkDigitOk, true);
  assert.equal(v.humanReadable, '(01)12345678901231(17)251231');
});

test('validateGs1：变长 AI 后插 FNC1，作为最后一个不插', () => {
  const mid = validateGs1('(01)12345678901231(10)AB12(17)251231');
  assert.equal(mid.separators, 1);
  assert.ok(mid.data.includes('\u001D'));
  const tail = validateGs1('(01)12345678901231(10)AB12');
  assert.equal(tail.separators, 0);
  assert.ok(!tail.data.includes('\u001D'));
});

test('validateGs1：错误累积（长度 + 校验位 + 日期），ok=false 但 data 仍产出供排查', () => {
  const v = validateGs1('(01)123(17)251332');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /AI\(01\)/.test(e)));
  assert.ok(v.errors.some((e) => /月\/日不合法/.test(e)));
  assert.ok(v.data.length > 0);
});

test('validateGs1：不带括号按原始数据流处理，只给 warning', () => {
  const v = validateGs1('011234567890123117251231');
  assert.equal(v.ok, true);
  assert.equal(v.data, '011234567890123117251231');
  assert.equal(v.fields.length, 0);
  assert.match(v.warnings.join(' '), /未做字段级校验/);
});

test('validateGs1：空内容 / 无法解析片段显式报错', () => {
  assert.equal(validateGs1('').ok, false);
  const bad = validateGs1('(01)12345678901231 garbage');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /无法解析/.test(e)));
});

test('validateGs1：未登记 AI 只进 warnings、不进 errors（保持 encodeGs1 兼容）', () => {
  const v = validateGs1('(8888)ABC(17)251231');
  assert.equal(v.ok, true);
  assert.match(v.warnings.join(' '), /未在本产品字典登记/);
  assert.equal(encodeGs1('(8888)ABC(17)251231').invalid.length, 0);
  assert.equal(encodeGs1('(8888)ABC(17)251231').separators, 1, '未登记 AI 按变长处理插 FNC1');
});

test('encodeGs1 委托契约：invalid 只含 errors（P7 兼容）', () => {
  assert.equal(encodeGs1('(01)12345678901231(17)251231').invalid.length, 0);
  assert.ok(encodeGs1('(01)123(17)251231').invalid.some((m) => /AI\(01\)/.test(m)));
  assert.equal(encodeGs1('').invalid[0], 'GS1 内容为空');
});

// ------------------------------ 第三层：GS1 官方全量字典 ------------------------------
import { GS1_AI_FULL } from '../gs1-ai.full';

test('L3 全量字典：GS1 官方数据集 541 项，字段自洽', () => {
  const list = Object.values(GS1_AI_FULL);
  assert.ok(list.length >= 500, `官方全量应 >= 500，实际 ${list.length}`);
  const seen = new Set<string>();
  for (const a of list) {
    assert.match(a.ai, /^\d{2,4}$/);
    assert.ok(!seen.has(a.ai), `AI ${a.ai} 重复`);
    seen.add(a.ai);
    assert.ok(a.title.length > 0, `AI(${a.ai}) 缺标题`);
    assert.ok(!!a.fixedLen !== !!a.maxLen, `AI(${a.ai}) 长度约束需唯一`);
  }
});

test('L3 长尾 AI 可查：医药/物流/度量族走官方全量层', () => {
  // 精调层没有的老长尾 AI
  assert.equal(lookupAi('8112')?.kind, 'alphanumeric', '北美优惠文件码（官方英文标题）；此处精调层无 8112');
  assert.ok(lookupAi('3624'), '物流容积夸脱（4 位 AI）应可查');
  assert.equal(lookupAi('3624')?.fixedLen, 6, 'N4+N6 度量值为 6 位');
  assert.equal(lookupAi('415')?.checkDigit, true, 'GLN 家族带校验位');
  assert.equal(GS1_AI_FULL['255']?.checkDigit, true, 'GCN(255) 官方全量层带校验位派生');
});

test('L3 精调层优先于全量层：中文标题/示例不被官方英文覆盖', () => {
  // 01 在两层都有；精调层是中文「GTIN 全球贸易项目代码」+ 示例
  assert.equal(lookupAi('01')?.title, 'GTIN 全球贸易项目代码');
  assert.equal(lookupAi('01')?.example, '12345678901231');
  assert.notEqual(GS1_AI_FULL['01'].title, lookupAi('01')?.title, '全量层为英文，精调层为中文');
});

test('L3 gs1Catalog.totalFull 反映全量合并数，disclaimer 标注官方来源', () => {
  const c = gs1Catalog();
  assert.ok(c.totalFull >= 500, `totalFull 应 >= 500，实际 ${c.totalFull}`);
  assert.ok(c.totalFull > c.totalExact, '全量数应大于精调数');
  assert.match(c.disclaimer, /GS1 官方/);
});

test('L3 全量长尾 AI 参与字符/长度校验', () => {
  // 8112 变长 alphanumeric 最长 70
  assert.equal(validateAiValue('8112', 'OFFER123').errors.length, 0);
  assert.match(validateAiValue('8112', 'A'.repeat(71)).errors.join(' '), /最长 70 位/);
  // 3624 定长 6 位数字
  assert.equal(validateAiValue('3624', '123456').errors.length, 0);
  assert.match(validateAiValue('3624', '123').errors.join(' '), /应为 6 位/);
  assert.match(validateAiValue('3624', '12AB56').errors.join(' '), /仅允许数字/);
});

// ------------------------------ 空值 AI 段剔除 ------------------------------
test('stripEmptyGs1Ais：没填序列号时去掉孤立 (21)', () => {
  assert.equal(
    stripEmptyGs1Ais('(01)06901234567892(17)271031(10)PF2601(21)'),
    '(01)06901234567892(17)271031(10)PF2601',
  );
  // 多行 HRI（换行分隔）同样处理
  assert.equal(
    stripEmptyGs1Ais('(01)06901234567892\n(17)271031\n(10)PF2601\n(21)'),
    '(01)06901234567892\n(17)271031\n(10)PF2601',
  );
});

test('stripEmptyGs1Ais：值齐全/纯数据流时不动', () => {
  const full = '(01)06901234567892(17)271031(10)PF2601(21)SN9001';
  assert.equal(stripEmptyGs1Ais(full), full);
  const sscc = '(00)069012340000000016';
  assert.equal(stripEmptyGs1Ais(sscc), sscc);
  assert.equal(stripEmptyGs1Ais('010690123456789221SN9'), '010690123456789221SN9');
});
