// =============================================================================
// lookup-table.parity.test.ts —— 查表纯函数前后端一致性锁定（第五层）
//   设计态用 apps/console/.../engine/lookup-table.ts 预览，打印态用 backend/core/lookup-table.ts。
//   二者是同源码 parity 副本，本测试用同一批输入跑两端并要求输出逐字一致。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTable as beParse, lookup as beLookup, vlookup as beVlookup,
} from '../lookup-table';
import {
  parseTable as feParse, lookup as feLookup, vlookup as feVlookup,
} from '../../../apps/console/src/views/designer/engine/lookup-table';

const INPUTS: unknown[] = [
  '{"A100":12.5,"B200":9.9}',
  '[["A100","MAT1","E"],["B200","MAT2","W"]]',
  'A100=7.5;B200=8.8; C300:MAT3|W',
  'X=1\nY=2',
  { a: 1, b: 'two', n: -3.14, t: true },
  [['k', 'v1', 'v2'], 'solo'],
  null, undefined, 42, '', '   ', 'no-separator', ':::bad',
];

test('parity：parseTable 解析结果两端逐字一致', () => {
  for (const input of INPUTS) {
    const be = beParse(input);
    const fe = feParse(input);
    assert.deepEqual([...fe.entries()], [...be.entries()], `parseTable 漂移: ${JSON.stringify(input)}`);
  }
});

test('parity：lookup 结果两端一致', () => {
  for (const input of INPUTS) {
    const bt = beParse(input);
    const ft = feParse(input);
    for (const key of ['A100', 'B200', 'a', 'k', 'X', 'MISS']) {
      assert.equal(feLookup(ft, key, 'fb'), beLookup(bt, key, 'fb'), `lookup 漂移: ${JSON.stringify(input)} key=${key}`);
      assert.equal(feLookup(ft, key), beLookup(bt, key));
    }
  }
});

test('parity：vlookup 各列与越界两端一致', () => {
  for (const input of INPUTS) {
    const bt = beParse(input);
    const ft = feParse(input);
    for (const key of ['A100', 'k', 'MISS']) {
      for (const col of [undefined, 1, 2, 3]) {
        assert.equal(
          feVlookup(ft, key, col, 'fb'),
          beVlookup(bt, key, col, 'fb'),
          `vlookup 漂移: ${JSON.stringify(input)} key=${key} col=${col}`,
        );
      }
    }
  }
});
