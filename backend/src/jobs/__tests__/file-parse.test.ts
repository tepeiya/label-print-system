// P8.1 HotFolder 解析层单测：JSON / CSV / TSV / TXT / 边界与截断
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimited, parseDropFile } from '../file-parse';
import { MAX_DROP_ROWS } from '../trigger.calc';

test('parseDelimited：引号内逗号与换行、"" 转义、CRLF、自动识别分隔符', () => {
  const csv = 'sku,name\r\nA1,"含,逗号"\r\nA2,"含""引号"\r\nA3,"跨\n行"';
  const r = parseDelimited(csv);
  assert.deepEqual(r.header, ['sku', 'name']);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0][1], '含,逗号');
  assert.equal(r.rows[1][1], '含"引号');
  assert.equal(r.rows[2][1], '跨\n行');
  assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t').header, ['a', 'b']);
  assert.deepEqual(parseDelimited('a;b\n1;2').header, ['a', 'b']);
});

test('parseDropFile .json：裸数组 / {rows:[]} / 单对象 三种形态', () => {
  const arr = parseDropFile('a.json', '[{"sku":"A1","qty":2},{"sku":"A2","qty":3}]');
  assert.equal(arr.rows.length, 2);
  assert.deepEqual(arr.columns, ['sku', 'qty']);

  const wrapped = parseDropFile('b.JSON', '{"rows":[{"sku":"B1"}]}');
  assert.equal(wrapped.rows.length, 1);

  const one = parseDropFile('c.json', '{"sku":"C1"}');
  assert.deepEqual(one.rows, [{ sku: 'C1' }]);

  const scalar = parseDropFile('d.json', '[1,2]');
  assert.deepEqual(scalar.rows, [{ value: '1' }, { value: '2' }]);
});

test('parseDropFile .csv：表头映射、空单元格补空串、无表头列自动命名', () => {
  const r = parseDropFile('order.csv', 'sku,qty\nA1,2\nA2,\n');
  assert.deepEqual(r.columns, ['sku', 'qty']);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1].qty, '');

  const noHeader = parseDropFile('x.csv', ',v\nA1,2');
  assert.deepEqual(noHeader.columns, ['col_1', 'v']);
});

test('parseDropFile .tsv / .txt', () => {
  const tsv = parseDropFile('a.tsv', 'sku\tqty\nA1\t2\n');
  assert.equal(tsv.rows[0].qty, '2');
  const txt = parseDropFile('codes.txt', 'A1\n\nA2\n A3 ');
  assert.deepEqual(txt.rows.map((r) => r.value), ['A1', 'A2', 'A3']);
  assert.deepEqual(txt.columns, ['value']);
});

test('parseDropFile：非法扩展名 / 空文件 / 坏 JSON / 无有效行 抛可读错误', () => {
  assert.throws(() => parseDropFile('a.exe', 'x'), /不支持的文件类型/);
  assert.throws(() => parseDropFile('a.csv', '   '), /文件为空/);
  assert.throws(() => parseDropFile('a.json', '{bad'), /JSON 解析失败/);
  assert.throws(() => parseDropFile('a.csv', '\n\n'), /文件为空/, '纯空白在解析前就拦下');
  assert.throws(() => parseDropFile('a.csv', 'sku,qty\n\n'), /无有效数据行/);
  assert.throws(() => parseDropFile('a.txt', '\n\n'), /文件为空/);
});

test('parseDropFile：行数截断与超长单元格截断都给 warnings', () => {
  const many = Array.from({ length: MAX_DROP_ROWS + 5 }, (_, i) => `L${i}`).join('\n');
  const r = parseDropFile('big.txt', many);
  assert.equal(r.rows.length, MAX_DROP_ROWS);
  assert.ok(r.warnings.some((w) => w.includes('超过上限')));

  const long = parseDropFile('long.csv', 'sku\n' + 'x'.repeat(5000));
  assert.equal(long.rows[0].sku.length, 4000);
  assert.ok(long.warnings.some((w) => w.includes('截断')));
});
