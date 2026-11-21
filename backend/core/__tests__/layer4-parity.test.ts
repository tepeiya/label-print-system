// =============================================================================
// layer4-parity.test.ts —— 第四层前后端 parity 锁定
//   设计态用 apps/console/.../engine/{rich-text,table-layout}.ts 预览，
//   打印态用 backend/core/{rich-text,table-layout}.ts 求值。二者是同源码 parity 副本，
//   一旦漂移就会出现「预览对、打印错」。本测试用同一批输入同时跑两端并要求输出逐字一致。
//   注：rich-text.ts / table-layout.ts 注释中提到的 parity 锁定即本文件。
//   运行：node --import tsx --test backend/core/__tests__/layer4-parity.test.ts
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRuns as beNormalizeRuns,
  runsToPlainText as bePlain,
  runsOf as beRunsOf,
  renderRunsHtml as beRenderHtml,
  validateRuns as beValidate,
} from '../rich-text';
import {
  normalizeMerges as beNormalizeMerges,
  buildTableLayout as beBuildLayout,
  cellIndexOf as beCellIndex,
} from '../table-layout';
import {
  normalizeRuns as feNormalizeRuns,
  runsToPlainText as fePlain,
  runsOf as feRunsOf,
  renderRunsHtml as feRenderHtml,
  validateRuns as feValidate,
} from '../../../apps/console/src/views/designer/engine/rich-text';
import {
  normalizeMerges as feNormalizeMerges,
  buildTableLayout as feBuildLayout,
  cellIndexOf as feCellIndex,
} from '../../../apps/console/src/views/designer/engine/table-layout';

// ------------------------------ rich-text parity ------------------------------
const RUN_INPUTS: unknown[] = [
  null,
  [],
  'legacy plain text',
  [{ text: 'A', bold: true }, { text: 'B', italic: true }],
  [
    { text: 'SKU:', bold: true },
    { text: '{{code}}', color: '#ff0000', size: 12 },
    { text: '₂', script: 'sub' },
    { text: 'x', script: 'super', color: '#00ff00' },
    { text: '', bold: true }, // 空文本应被过滤
    { text: 'bad', color: 'not-a-color', size: -5 }, // 非法字段被丢弃但 run 保留
  ],
  [{ nope: 1 }, 'string item', null, { text: 123 }], // 脏输入
];

test('parity：normalizeRuns 归一化结果逐字一致', () => {
  for (const input of RUN_INPUTS) {
    assert.deepEqual(feNormalizeRuns(input), beNormalizeRuns(input), `normalizeRuns 漂移: ${JSON.stringify(input)}`);
    assert.deepEqual(feNormalizeRuns(input, 'fallback'), beNormalizeRuns(input, 'fallback'));
  }
});

test('parity：runsToPlainText / runsOf 一致', () => {
  for (const input of RUN_INPUTS) {
    const beRuns = beNormalizeRuns(input);
    const feRuns = feNormalizeRuns(input);
    assert.equal(fePlain(feRuns), bePlain(beRuns));
    assert.deepEqual(feRunsOf(input), beRunsOf(input));
  }
});

test('parity：renderRunsHtml 逐字一致（含 escaping / 上下标 / run 覆盖）', () => {
  const runs = beNormalizeRuns([
    { text: '粗<&"', bold: true },
    { text: '斜', italic: true, color: '#abc' },
    { text: '下', underline: true },
    { text: '小', script: 'sub', size: 10 },
    { text: '上', script: 'super' },
  ]);
  const base = { size: 12, bold: false, color: '#000000' };
  assert.equal(feRenderHtml(runs, base), beRenderHtml(runs, base));
  // 自定义插值/转义也要一致
  const interp = (s: string) => s.replace('X', 'Y');
  const esc = (s: string) => s.replace(/</g, '&lt;');
  assert.equal(feRenderHtml(runs, base, { interp, esc }), beRenderHtml(runs, base, { interp, esc }));
});

test('parity：validateRuns 问题数组一致', () => {
  const cases: unknown[] = [
    null,
    [],
    'not-array',
    [{ text: 'ok' }, { text: 1, color: 'bad', script: 'weird' }],
  ];
  for (const c of cases) assert.deepEqual(feValidate(c), beValidate(c), `validateRuns 漂移: ${JSON.stringify(c)}`);
});

// ------------------------------ table-layout parity ------------------------------
const TABLE_INPUTS: Array<[number, number, unknown]> = [
  [2, 2, null],
  [3, 4, [{ row: 0, col: 0, rowSpan: 2, colSpan: 1 }]],
  [4, 4, [
    { row: 0, col: 0, rowSpan: 2, colSpan: 2 },
    { row: 1, col: 1, rowSpan: 2, colSpan: 2 }, // 与主格重叠，应被丢弃
    { row: 0, col: 0, rowSpan: 1, colSpan: 1 }, // 1x1 丢弃 + 起点重复
    { row: 3, col: 3, rowSpan: 99, colSpan: 99 }, // 越界钳制
  ]],
  [1, 1, [{ row: 0, col: 0, rowSpan: 5, colSpan: 5 }]],
];

test('parity：buildTableLayout 布局逐字一致', () => {
  for (const [r, c, merges] of TABLE_INPUTS) {
    assert.deepEqual(feBuildLayout(r, c, merges), beBuildLayout(r, c, merges), `buildTableLayout 漂移: ${r}x${c}`);
  }
});

test('parity：normalizeMerges / cellIndexOf 一致', () => {
  for (const [r, c, merges] of TABLE_INPUTS) {
    assert.deepEqual(feNormalizeMerges(r, c, merges), beNormalizeMerges(r, c, merges));
  }
  for (const [row, col, cols] of [[0, 0, 4], [2, 3, 4], [5, 1, 6]]) {
    assert.equal(feCellIndex(row, col, cols), beCellIndex(row, col, cols));
  }
});
