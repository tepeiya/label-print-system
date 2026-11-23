// UDI 追溯纯函数层单测（node:test）：状态机 / SSCC / 层级树 / 留痕聚合 / CSV
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gs1DateToIso, nextStatus, validateSscc, buildPackTree, ancestorsOf, descendantsOf,
  summarizePrintAudit, csvCell, toCsv, reportFileName,
} from '../udi.trace.calc';

test('状态机：正常链路 REGISTERED→PRINTED→RECEIVED→ISSUED→SHIPPED→RETURN', () => {
  let s = 'REGISTERED';
  for (const [ev, want] of [
    ['PRINT', 'PRINTED'], ['RECEIVE', 'RECEIVED'], ['ISSUE', 'ISSUED'],
    ['SHIP', 'SHIPPED'], ['RETURN', 'RECEIVED'],
  ] as const) {
    const r = nextStatus(s, ev);
    assert.equal(r.ok, true, `${s} + ${ev} 应允许`);
    assert.equal(r.status, want);
    s = r.status;
  }
});

test('状态机：未收货不能发料（飞检最常见的不合规动作）', () => {
  const r = nextStatus('REGISTERED', 'ISSUE');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'REGISTERED');
  assert.match(r.reason!, /RECEIVE/);
});

test('状态机：作废后所有流转被拒（含收货/发料/出库/退货）', () => {
  for (const ev of ['PRINT', 'RECEIVE', 'ISSUE', 'SHIP', 'RETURN', 'BUILD']) {
    assert.equal(nextStatus('VOID', ev).ok, false, `${ev} 应被拒`);
  }
  assert.equal(nextStatus('VOID', 'VOID').ok, true);
});

test('状态机：打印失败回落到 REGISTERED，可重打', () => {
  const r = nextStatus('REGISTERED', 'PRINT_FAIL');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'REGISTERED');
  assert.equal(nextStatus(r.status, 'PRINT').status, 'PRINTED');
});

test('状态机：未知状态/未知事件都给明确原因', () => {
  assert.match(nextStatus('BOGUS', 'PRINT').reason!, /未知当前状态/);
  assert.match(nextStatus('REGISTERED', 'TELEPORT').reason!, /未知事件类型/);
});

test('状态机：REPACK 只换包装不动状态', () => {
  const r = nextStatus('ISSUED', 'REPACK');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ISSUED');
});

test('SSCC：18 位 + 正确校验位通过，错位/短位被拒', () => {
  // 前 17 位 10000000000000001 的模 10 校验位
  const body = '10000000000000001';
  const cd = validateSscc(body + '0');
  // 计算正确校验位：从右往左权重 3/1 交替
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  const right = body + String((10 - (sum % 10)) % 10);
  assert.equal(validateSscc(right).ok, true, `正确码 ${right} 应通过`);
  assert.equal(validateSscc(body + '9').ok, false);
  assert.equal(validateSscc('12345').ok, false);
  assert.match(validateSscc('12345').reason!, /18 位/);
  // 空白/短横线容错
  assert.equal(validateSscc(right.replace(/(\d{4})/g, '$1 ')).normalized, right);
  void cd;
});

test('层级树：单元→中包→托盘的父子关系可组装', () => {
  const tree = buildPackTree([
    { sscc: 'P1', level: 'PALLET' },
    { sscc: 'C1', level: 'CARTON', parentSscc: 'P1' },
    { sscc: 'C2', level: 'CARTON', parentSscc: 'P1' },
    { sscc: 'U1', level: 'UNIT', parentSscc: 'C1' },
  ]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].sscc, 'P1');
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[0].children.find((c) => c.sscc === 'C1')!.children[0].sscc, 'U1');
});

test('层级树：父缺失的行作为根，不丢数据', () => {
  const tree = buildPackTree([{ sscc: 'C9', parentSscc: 'GHOST' }, { sscc: 'P1' }]);
  assert.equal(tree.length, 2);
});

test('祖先链：返回 根→目标 顺序，含目标自身', () => {
  const m = new Map<string, string | null>([['U1', 'C1'], ['C1', 'P1'], ['P1', null]]);
  assert.deepEqual(ancestorsOf('U1', m), ['P1', 'C1', 'U1']);
  assert.deepEqual(ancestorsOf('P1', m), ['P1']);
});

test('祖先链：环状数据不死循环', () => {
  const m = new Map<string, string | null>([['A', 'B'], ['B', 'A']]);
  assert.deepEqual(ancestorsOf('A', m), ['B', 'A']);
});

test('子孙：广度优先取全量（含深两层的单元）', () => {
  const d = descendantsOf('P1', [
    { sscc: 'C1', parentSscc: 'P1' }, { sscc: 'C2', parentSscc: 'P1' },
    { sscc: 'U1', parentSscc: 'C1' }, { sscc: 'U2', parentSscc: 'C1' },
  ]);
  assert.deepEqual(d.sort(), ['C1', 'C2', 'U1', 'U2']);
  assert.deepEqual(descendantsOf('U1', [{ sscc: 'C1', parentSscc: 'P1' }]), []);
});

test('留痕聚合：按天与按模板分别统计，单元数去重', () => {
  const s = summarizePrintAudit([
    { eventType: 'PRINT', day: '2026-11-01', templateCode: 'UDI_UNIT_V1', unitKey: 'A' },
    { eventType: 'PRINT', day: '2026-11-01', templateCode: 'UDI_UNIT_V1', unitKey: 'A' }, // 同单元重打
    { eventType: 'PRINT', day: '2026-11-01', templateCode: 'UDI_UNIT_V1', unitKey: 'B' },
    { eventType: 'PRINT_FAIL', day: '2026-11-02', templateCode: 'UDI_CARTON_V1', unitKey: 'B' },
    { eventType: 'RECEIVE', day: '2026-11-02', unitKey: 'B' },                            // 非打印事件忽略
  ]);
  assert.deepEqual(s.totals, { printed: 3, failed: 1, units: 2 });
  assert.equal(s.byDay.length, 2);
  assert.deepEqual(s.byDay[0], { day: '2026-11-01', printed: 3, failed: 0, units: 2 }); // 打印次数计重打，单元数去重
  assert.deepEqual(s.byDay[1], { day: '2026-11-02', printed: 0, failed: 1, units: 1 });
  assert.equal(s.byTemplate[0].templateCode, 'UDI_UNIT_V1');
  assert.equal(s.byTemplate[0].printed, 3);
});

test('留痕聚合：空数据返回零值而非崩溃', () => {
  const s = summarizePrintAudit([]);
  assert.deepEqual(s.totals, { printed: 0, failed: 0, units: 0 });
  assert.equal(s.byDay.length, 0);
  assert.equal(s.byTemplate.length, 0);
});

test('CSV：含逗号/引号/换行时正确转义', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('CSV：防公式注入（= + - @ 开头前置单引号）', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('+86'), "'+86");
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell('@x'), "'@x");
});

test('CSV：带 BOM、CRLF、结尾换行，Excel 中文不乱码', () => {
  const csv = toCsv([{ key: 'a', title: '批号' }, { key: 'b', title: '数量' }], [{ a: '乙', b: 2 }]);
  assert.equal(csv.startsWith('\uFEFF'), true);
  assert.equal(csv, '\uFEFF批号,数量\r\n乙,2\r\n');
});

test('CSV：可关闭 BOM（给接口/程序消费）', () => {
  const csv = toCsv([{ key: 'a', title: 'a' }], [{ a: 1 }], { bom: false });
  assert.equal(csv, 'a\r\n1\r\n');
});

test('CSV：空行集只输出表头', () => {
  assert.equal(toCsv([{ key: 'a', title: 'a' }], []), '\uFEFFa\r\n');
});

test('文件名：日期压缩为 YYYYMMDD，缺省 all', () => {
  assert.equal(reportFileName('udi-units', '2026-11-01', '2026-11-30'), 'udi-units-20261101-20261130.csv');
  assert.equal(reportFileName('udi-print-audit'), 'udi-print-audit-all-all.csv');
});

test('GS1 日期 → ISO：常规 6 位与 YYMMDD 世纪窗口', () => {
  assert.equal(gs1DateToIso('271231'), '2027-12-31');
  assert.equal(gs1DateToIso('260101'), '2026-01-01');
  assert.equal(gs1DateToIso('991231'), '1999-12-31');   // YY>=50 视为 19YY
  assert.equal(gs1DateToIso('000101'), '2000-01-01');
});

test('GS1 日期 → ISO：DD=00 取当月最后一天（含闰年 2 月）', () => {
  assert.equal(gs1DateToIso('270200'), '2027-02-28');
  assert.equal(gs1DateToIso('280200'), '2028-02-29');   // 2028 闰年
  assert.equal(gs1DateToIso('270400'), '2027-04-30');
  assert.equal(gs1DateToIso('270100'), '2027-01-31');
});

test('GS1 日期 → ISO：非法输入返回 null 不抛错', () => {
  assert.equal(gs1DateToIso('271331'), null);          // 13 月
  assert.equal(gs1DateToIso('271232'), null);          // 12 月 32 日
  assert.equal(gs1DateToIso('2027-12-31'), null);      // 不是 6 位
  assert.equal(gs1DateToIso(''), null);
  assert.equal(gs1DateToIso(null), null);
});
