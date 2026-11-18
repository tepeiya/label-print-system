// =============================================================================
// golden-commands.test.ts —— P7.8 指令 golden file 快照测试
//
// 与 p7-symbology.test.ts 的"结构摘要"（正则匹配头尾/内容）不同，这里把每个码制、
// 每类内容的**完整指令串**落盘为 golden 快照，逐字比对。任何参数漂移（模块宽、
// 静区、旋转、码制映射、FNC1 转义等）都会导致 fail，从而锁死"预览所见 = 打印所得"。
//
// 用法：
//   - 首次运行（golden 不存在）→ 自动生成 baseline 并 pass；
//   - 之后运行 → 与 golden 逐字比对，漂移即 fail；
//   - 确认是有意变更后重生：UPDATE_GOLDEN=1 npm test。
//
// 覆盖：ZPL / TSPL / EPL 三协议 × 各自原生码制 × 3 类内容
//        （短内容 / 边界长度 / 带校验位形式），符合 docs/10 §10.7.3 P7.8 验收口径。
// 纯函数，不 import TypeORM/Nest（docs/10 §10.15.6）。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYMBOLOGIES, hasNative } from '../symbology.capabilities';
import { generateZpl } from '../zpl-generator';
import { buildJob as buildTspl } from '../tspl-generator';
import { buildJob as buildEpl } from '../epl-generator';
import type { BarcodeSpec, QrcodeSpec } from '../types';

const DPI = 300;
const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

const linearSpec = (sym: string, content: string): BarcodeSpec => ({
  sym, content, moduleWidthMm: 0.25, wideRatio: 2.5, heightMm: 10,
  showText: true, textPosition: 'bottom', checksum: true,
});
const qrSpec = (sym: string, content: string): QrcodeSpec => ({
  sym, content, ecc: 'M', moduleSizeMm: 0.4, quietZoneMm: 2,
});

/** 3 类内容：短 / 边界长度 / 带校验位形式（数值固定，保证指令确定性） */
const CASES: Array<{ name: string; linear: string; qr: string }> = [
  { name: 'short', linear: 'A', qr: 'HELLO' },
  { name: 'boundary', linear: 'ABC1234567890123456789', qr: 'HELLO-WORLD-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { name: 'checksum', linear: '69012345678901', qr: '69012345678901' },
];

type Proto = 'zpl' | 'tspl' | 'epl';

/** 生成确定性指令串：直接调生成器，不经过 print.controller（后者注入 UUID/时间戳） */
function render(proto: Proto, sym: string, kind: 'linear' | '2d', content: string): string {
  const el = kind === 'linear'
    ? { type: 'barcode' as const, xMm: 2, yMm: 2, barcode: linearSpec(sym, content) }
    : { type: 'qrcode' as const, xMm: 2, yMm: 2, hMm: 15, qrcode: qrSpec(sym, content) };
  if (proto === 'zpl') return generateZpl([el], DPI).text;
  if (proto === 'tspl') return buildTspl([el as any], DPI, { widthMm: 60, heightMm: 40, gapMm: 2, copies: 1 }).buffer.toString('utf8');
  return buildEpl([el as any], DPI, { widthMm: 60, heightMm: 40, gapMm: 2, copies: 1 }).buffer.toString('ascii');
}

const goldenPath = (proto: Proto) => path.join(GOLDEN_DIR, `${proto}.golden.json`);

function loadGolden(proto: Proto): Record<string, string> {
  const p = goldenPath(proto);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function saveGolden(proto: Proto, data: Record<string, string>): void {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  fs.writeFileSync(goldenPath(proto), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

for (const proto of ['zpl', 'tspl', 'epl'] as Proto[]) {
  test(`P7.8-${proto.toUpperCase()} 逐码制 3 内容指令 golden 快照（防漂移）`, () => {
    const expected = loadGolden(proto);
    const actual: Record<string, string> = {};
    let compared = 0, generated = 0;

    for (const c of Object.values(SYMBOLOGIES)) {
      if (!hasNative(proto, c.sym)) continue;
      for (const cs of CASES) {
        const key = `${c.sym}|${cs.name}`;
        const content = c.kind === 'linear' ? cs.linear : cs.qr;
        actual[key] = render(proto, c.sym, c.kind, content);
        if (expected[key] !== undefined) {
          assert.equal(actual[key], expected[key],
            `${proto} ${key} 指令漂移。若为有意变更请用 UPDATE_GOLDEN=1 重生 golden。`);
          compared++;
        } else {
          generated++;
        }
      }
    }

    // 首次 bootstrap 或显式更新：合并写回（保留已有条目 + 新增码制）
    if (UPDATE || generated > 0) saveGolden(proto, { ...expected, ...actual });
    assert.ok(compared + generated > 0, `${proto.toUpperCase()} 应至少生成一个 golden 条目`);
  });
}
