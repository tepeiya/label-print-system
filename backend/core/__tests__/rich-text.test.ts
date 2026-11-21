// 富文本 runs 单一真源单测 + 前后端 parity
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRuns, runsToPlainText, runsOf, renderRunsHtml, validateRuns, type RichTextRun,
} from '../rich-text';
// @ts-ignore 前端 parity 副本
import * as fe from '../../../apps/console/src/views/designer/engine/rich-text.ts';

test('normalizeRuns：非法项过滤、空文本丢弃、长度钳制', () => {
  const runs = normalizeRuns([
    { text: '普通' },
    { text: '粗体', bold: true },
    { text: '' },
    null,
    { text: '红字', color: '#ff0000' },
    { text: '坏色', color: 'red' },   // 非法颜色被丢弃覆盖，但 run 保留
    { text: '上标', script: 'super', size: 8 },
    5,
  ]);
  assert.equal(runs.length, 5);
  assert.deepEqual(runs[0], { text: '普通' });
  assert.equal(runs[1].bold, true);
  assert.equal(runs[3].color, undefined, '非法颜色不写入');
  assert.equal(runs[4].script, 'super');
});

test('normalizeRuns：旧纯文本回退为单 run', () => {
  assert.deepEqual(normalizeRuns(null, '旧文本'), [{ text: '旧文本' }]);
  assert.deepEqual(normalizeRuns([], '旧文本'), [{ text: '旧文本' }]);
  assert.deepEqual(normalizeRuns(null, ''), []);
});

test('runsToPlainText / runsOf：降级与兼容读取', () => {
  const runs: RichTextRun[] = [{ text: 'A' }, { text: 'B', bold: true }];
  assert.equal(runsToPlainText(runs), 'AB');
  assert.equal(runsToPlainText([]), '');
  assert.deepEqual(runsOf(runs), runs);
  assert.deepEqual(runsOf(null, 'fallback'), [{ text: 'fallback' }]);
});

test('renderRunsHtml：run 覆盖优先于 base，script 用 sub/sup + 缩小字号', () => {
  const html = renderRunsHtml(
    [{ text: '价', bold: true }, { text: '2', script: 'super', size: 10 }, { text: '格', color: '#ff0000' }],
    { size: 12, color: '#000000' },
  );
  assert.match(html, /<span style="font-weight:bold;color:#000000">价<\/span>/, 'run 粗体覆盖 + base 颜色继承');
  assert.match(html, /<sup style="color:#000000;font-size:7pt">2<\/sup>/, '上标缩小字号');
  assert.match(html, /<span style="color:#ff0000">格<\/span>/, 'run 颜色覆盖 base');
});

test('renderRunsHtml：interp 与 esc 可注入，占位符被插值且 HTML 被转义', () => {
  const html = renderRunsHtml([{ text: '{{name}}<b>' }], {}, {
    interp: (s) => s.replace('{{name}}', '张三'),
  });
  assert.ok(html.includes('张三'), '占位符被插值');
  assert.ok(html.includes('&lt;b&gt;'), 'HTML 被转义');
});

test('validateRuns：合法/非法校验', () => {
  assert.deepEqual(validateRuns(null), []);
  assert.deepEqual(validateRuns([{ text: 'ok', color: '#fff', script: 'sub' }]), []);
  const errs = validateRuns([{ text: 5 }, { text: 'x', script: 'bad' }, 'str']);
  assert.equal(errs.length, 3);
});

test('parity：前后端 rich-text 纯函数输出完全一致', () => {
  const input = [
    { text: 'A', bold: true }, { text: 'B', italic: true, color: '#123456' },
    { text: 'C', script: 'sub' as const, size: 9 }, { text: 'D', underline: true },
  ];
  assert.deepEqual(fe.normalizeRuns(input), normalizeRuns(input));
  assert.equal(fe.runsToPlainText(normalizeRuns(input)), runsToPlainText(normalizeRuns(input)));
  assert.equal(
    fe.renderRunsHtml(normalizeRuns(input), { size: 10, color: '#000' }),
    renderRunsHtml(normalizeRuns(input), { size: 10, color: '#000' }),
    '前后端 renderRunsHtml 输出必须逐字一致',
  );
  assert.deepEqual(fe.validateRuns(input), validateRuns(input));
});
