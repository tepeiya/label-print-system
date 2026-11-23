// UDI 数据层单测（纯函数，不连库不触网）
import test from 'node:test';
import assert from 'node:assert/strict';
import { gtinCheckDigit } from '../../../core/checksum';
import {
  normalizeGtin, formatGs1Date, buildUdi, parseUdi, parseElementString, udiUnitKey,
} from '../udi.calc';

const body = '0690123456789';
const gtin14 = body + gtinCheckDigit(body); // 06901234567890

test('GTIN：14 位有效 → 原样通过且校验位正确', () => {
  const r = normalizeGtin(gtin14);
  assert.equal(r.gtin14, gtin14);
  assert.equal(r.checkDigitOk, true);
  assert.deepEqual(r.errors, []);
});

test('GTIN：13 位左补零到 14 位，校验位仍有效', () => {
  const r = normalizeGtin('6901234567892');
  assert.equal(r.gtin14, '06901234567892');
  assert.equal(r.checkDigitOk, true);
});

test('GTIN：12 位左补两位零，校验位不变', () => {
  const b12 = '69012345678';
  const g12 = b12 + gtinCheckDigit(b12);
  const r = normalizeGtin(g12);
  assert.equal(r.gtin14, '00' + g12);
  assert.equal(r.gtin14.length, 14);
  assert.equal(r.checkDigitOk, true);
});

test('GTIN：校验位错误要报错并给出正确值', () => {
  const wrong = gtin14.slice(0, -1) + ((+gtin14.slice(-1) + 1) % 10);
  const r = normalizeGtin(wrong);
  assert.equal(r.checkDigitOk, false);
  assert.match(r.errors.join(), /校验位错误/);
  assert.match(r.errors.join(), new RegExp(gtin14));
});

test('GTIN：含空格/短横线自动剥离非数字', () => {
  const r = normalizeGtin('0690 1234-5678 92');
  assert.equal(r.gtin14, gtin14);
  assert.equal(r.checkDigitOk, true);
});

test('GTIN：空值与非法长度报错', () => {
  assert.match(normalizeGtin('').errors.join(), /为空/);
  assert.match(normalizeGtin('12345').errors.join(), /长度/);
});

test('日期：YYYY-MM-DD → YYMMDD', () => {
  assert.equal(formatGs1Date('2027-12-31').value, '271231');
});

test('日期：YYYYMMDD 与 YYMMDD 都接受', () => {
  assert.equal(formatGs1Date('20271231').value, '271231');
  assert.equal(formatGs1Date('271231').value, '271231');
});

test('日期：YYYY-MM 输出 YYMM00（GS1 月末语义）', () => {
  assert.equal(formatGs1Date('2027-12').value, '271200');
});

test('日期：非法月份/日拒绝', () => {
  assert.match(formatGs1Date('2027-13-01').errors.join(), /月份/);
  assert.match(formatGs1Date('2027-02-30').errors.join(), /日期不存在/);
  assert.match(formatGs1Date('271232').errors.join(), /日不合法/);
});

test('日期：闰年判定', () => {
  assert.equal(formatGs1Date('2028-02-29').value, '280229');
  assert.match(formatGs1Date('2027-02-29').errors.join(), /日期不存在/);
});

test('日期：无法识别格式报错', () => {
  assert.match(formatGs1Date('12/31/2027').errors.join(), /无法识别/);
});

test('构造：完整 UDI 字段顺序为 01→17→10→21', () => {
  const r = buildUdi({ gtin: gtin14, expiry: '2027-12-31', lot: 'LOT01', serial: 'SN0001' });
  assert.equal(r.ok, true);
  assert.equal(r.hri, `(01)${gtin14}(17)271231(10)LOT01(21)SN0001`);
  assert.deepEqual(r.fields.map((f) => f.ai), ['01', '17', '10', '21']);
});

test('构造：DI 与 PI 拆分正确', () => {
  const r = buildUdi({ gtin: gtin14, expiry: '2027-12-31', lot: 'LOT01' });
  assert.equal(r.di, `(01)${gtin14}`);
  assert.equal(r.pi, '(17)271231(10)LOT01');
  assert.equal(r.hasPi, true);
});

test('构造：元素串在变长 AI 后插 FNC1，定长 AI 不插', () => {
  const r = buildUdi({ gtin: gtin14, expiry: '2027-12-31', lot: 'LOT01', serial: 'SN0001' });
  assert.equal(r.elementString, `01${gtin14}1727123110LOT01\u001D21SN0001`);
  assert.ok(r.elementString.includes('\u001D'));
});

test('构造：缺少 GTIN 直接判失败', () => {
  const r = buildUdi({ gtin: '', lot: 'A1' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /缺少 DI/);
});

test('构造：无 PI 只给 warning（免于实施情形可接受）', () => {
  const r = buildUdi({ gtin: gtin14 });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(), /缺少 PI/);
});

test('构造：批号超 20 位报错', () => {
  const r = buildUdi({ gtin: gtin14, lot: 'A'.repeat(21) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /最长 20 位/);
});

test('构造：批号含括号会破坏 AI 分段，必须报错', () => {
  const r = buildUdi({ gtin: gtin14, lot: 'A(1)' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /含有/);
});

test('构造：批号+序列号并存给 warning 但不拦', () => {
  const r = buildUdi({ gtin: gtin14, lot: 'L1', serial: 'S1' });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(), /同时含批号/);
});

test('构造：附加 AI 追加在 21 之后，且重复 AI 报错', () => {
  const ok = buildUdi({ gtin: gtin14, lot: 'L1', extra: [{ ai: '240', value: 'EXT01' }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.hri.endsWith('(240)EXT01'), true);
  const dup = buildUdi({ gtin: gtin14, lot: 'L1', extra: [{ ai: '10', value: 'L2' }] });
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(), /重复/);
});

test('构造：GTIN 校验位错误 → ok=false 且仍给出规范串', () => {
  const wrong = gtin14.slice(0, -1) + ((+gtin14.slice(-1) + 1) % 10);
  const r = buildUdi({ gtin: wrong, lot: 'L1' });
  assert.equal(r.ok, false);
  assert.equal(r.gtin14, wrong);
  assert.equal(r.gtin14.length, 14);
});

test('解析：HRI 括号串 → 字段与 udi 值', () => {
  const r = parseUdi(`(01)${gtin14}(17)271231(10)LOT01(21)SN0001`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.udi, {
    gtin: gtin14, expiry: '271231', production: null, lot: 'LOT01', serial: 'SN0001',
  });
});

test('解析：原始元素串（含 FNC1）断句正确', () => {
  const raw = `01${gtin14}1727123110LOT01\u001D21SN0001`;
  const r = parseUdi(raw);
  assert.equal(r.ok, true);
  assert.equal(r.udi.lot, 'LOT01');
  assert.equal(r.udi.serial, 'SN0001');
  assert.equal(r.hri, `(01)${gtin14}(17)271231(10)LOT01(21)SN0001`);
});

test('解析：<GS> 占位符等价于 FNC1', () => {
  const raw = `01${gtin14}10LOT01<GS>21SN0001`;
  const r = parseUdi(raw);
  assert.equal(r.ok, true);
  assert.equal(r.udi.serial, 'SN0001');
});

test('解析：非 GS1 内容报错', () => {
  const r = parseUdi('HELLO-WORLD');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /不是 GS1|未解析/);
});

test('解析：缺少 01 报错（不是标准 UDI）', () => {
  const r = parseUdi('(10)LOT01(21)SN01');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /缺少 AI 01/);
});

test('解析：定长 AI 值长度不足要报错', () => {
  const p = parseElementString('1727');
  assert.match(p.errors.join(), /长度不足/);
});

test('单元键：DI+批号+序列号+有效期可稳定定位单品', () => {
  const r = buildUdi({ gtin: gtin14, expiry: '2027-12-31', lot: 'L1', serial: 'S1' });
  assert.equal(udiUnitKey(r), `${gtin14}|L1|S1|271231`);
});
