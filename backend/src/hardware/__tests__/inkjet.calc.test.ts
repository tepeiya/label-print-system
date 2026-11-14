// P8.5 喷码机输出协议单测（纯函数，不需要真机）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INKJET_MAX_CHARS_PER_LINE, INKJET_MAX_ITEMS, INKJET_MAX_LINES,
  expandInkjetText, inkjetJob, inkjetPayload, validateInkjetJob,
} from '../inkjet.calc';

test('expandInkjetText：{{name}} 同源占位，缺值记 warning，控制字符剔除', () => {
  const r = expandInkjetText('批号 {{lot}} / 日期 {{date}}', { lot: 'A001', date: '2026-01-01' });
  assert.equal(r.text, '批号 A001 / 日期 2026-01-01');
  assert.deepEqual(r.missing, []);
  const m = expandInkjetText('{{a}}{{b}}{{a}}', { a: '1' });
  assert.equal(m.text, '11', '同一变量出现两次应各展开一次');
  assert.deepEqual(m.missing, ['b'], '缺值去重');
  assert.equal(expandInkjetText('A\x01B\nC', {}).text, 'ABC', '控制字符不能进设备');
});

test('inkjetJob：一模板多数据生成逐件作业，触发参数夹取', () => {
  const j = inkjetJob(7, 100, [{ lot: 'A1' }, { lot: 'A2' }], {
    lines: [{ text: 'LOT {{lot}}', fontHeightMm: 3, bold: 2, delayMm: 5 }],
    dpi: 300, direction: 180, triggerMode: 'encoder', pulsesPerMm: 99999, debounceMs: -5,
  });
  assert.equal(j.items.length, 2);
  assert.equal(j.items[0].lines[0].text, 'LOT A1');
  assert.equal(j.items[1].lines[0].text, 'LOT A2');
  assert.equal(j.direction, 180);
  assert.equal(j.trigger.mode, 'encoder');
  assert.equal(j.trigger.pulsesPerMm, 1000, '超上限夹取');
  assert.equal(j.trigger.debounceMs, 0, '负延时夹到 0');
  assert.ok(j.jobKey.length > 0);
  assert.equal(validateInkjetJob(j).ok, true);
});

test('inkjetJob：超长/超行/超件数都夹取并显式 warning，不静默', () => {
  const lines = Array.from({ length: INKJET_MAX_LINES + 3 }, (_, i) => ({ text: `L${i}` }));
  const over = inkjetJob(1, 1, [{ x: 'x'.repeat(INKJET_MAX_CHARS_PER_LINE + 50) }], {
    lines: [{ text: '{{x}}' }, ...lines],
    triggerMode: 'unknown-mode',
  });
  assert.equal(over.items[0].lines.length, INKJET_MAX_LINES);
  assert.equal(over.items[0].lines[0].text.length, INKJET_MAX_CHARS_PER_LINE);
  assert.match(over.warnings.join(' '), /超过 .* 行/);
  assert.match(over.warnings.join(' '), /截断/);
  assert.match(over.warnings.join(' '), /未知触发模式/);
  assert.equal(over.trigger.mode, 'sensor');
  assert.equal(validateInkjetJob(over).ok, true, '夹取后必须是合法作业');

  const rows = Array.from({ length: INKJET_MAX_ITEMS + 10 }, (_, i) => ({ n: i }));
  const many = inkjetJob(1, 2, rows, { lines: [{ text: '{{n}}' }] });
  assert.equal(many.items.length, INKJET_MAX_ITEMS);
  assert.match(many.warnings.join(' '), /数据行超过/);
});

test('inkjetJob：缺变量 fail-visible，jobKey 内容相同幂等', () => {
  const cfg = { lines: [{ text: '{{missing}}' }] };
  const a = inkjetJob(3, 9, [{}], cfg);
  assert.equal(a.items[0].lines[0].text, '');
  assert.match(a.warnings.join(' '), /缺少变量/);
  assert.equal(a.jobKey, inkjetJob(3, 9, [{}], cfg).jobKey);
  assert.notEqual(a.jobKey, inkjetJob(3, 9, [{ missing: 'X' }], cfg).jobKey);
  assert.notEqual(a.jobKey, inkjetJob(4, 9, [{}], cfg).jobKey);
});

test('validateInkjetJob：非法作业 fail-closed', () => {
  assert.equal(validateInkjetJob(inkjetJob(0, 1, [{ a: 1 }], { lines: [{ text: 'x' }] })).ok, false, 'tenant_id 非法');
  assert.equal(validateInkjetJob(inkjetJob(1, 1, [], { lines: [{ text: 'x' }] })).ok, false, '无内容');
  const j = inkjetJob(1, 1, [{ a: 1 }], { lines: [{ text: 'x' }] });
  (j as any).trigger.mode = 'bogus';
  assert.equal(validateInkjetJob(j).ok, false);
});

test('inkjetPayload：厂商中立文本载荷，头部/逐件行结构可被代理解析', () => {
  const j = inkjetJob(7, 100, [{ lot: 'A1' }, { lot: 'A2' }], {
    lines: [{ text: 'LOT {{lot}}', fontHeightMm: 3 }, { text: 'LINE2', bold: 2 }],
    triggerMode: 'sensor',
  });
  const p = inkjetPayload(j);
  assert.match(p, /^#LABELFLOW-INKJET\/1\.0/);
  assert.match(p, /#JOBKEY /);
  assert.match(p, /#TRIGGER sensor /);
  assert.match(p, /#ITEMS 2/);
  assert.match(p, /ITEM 1 LINES 2/);
  assert.match(p, /\|LOT A1$/m);
  assert.match(p, /\|b=2\|d=0\|r=0\|LINE2$/m);
  assert.equal(p.split('\n').filter((l) => l.startsWith('ITEM ')).length, 2);
  assert.equal(p.includes('{{'), false, '占位必须已展开，不能把模板变量发给设备');
});
