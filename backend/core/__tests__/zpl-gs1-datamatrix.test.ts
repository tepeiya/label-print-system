// =============================================================================
// zpl-gs1-datamatrix.test.ts —— ZPL 通道的 GS1 DataMatrix 内容转码
//
// 背景（真实缺陷）：qrcode 元素原来是 `esc(q.content)` 直接塞进 ^FD，
//   模板里的 "(01){{gtin}}(17){{expiry}}(10){{lot}}" 渲染成 HRI 后带括号进指令，
//   打印机把括号当普通字符编码，扫出来是字面 "(01)0690..."，不是合法 GS1 元素串。
//   2026-11-26 修复：gs1=true 的 DataMatrix 走 encodeGs1 + gs1ToProtocol，
//   与 TSPL 侧 tspl2DContent（~1）同一口径。
//
// 纯函数测试，不 import TypeORM/Nest。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateZpl } from '../zpl-generator';

const DPI = 300;
const contentOf = (zpl: string) => (zpl.match(/\^FD([^\\^~]*)\^FS/g) ?? []).map((m) => m.replace(/^\^FD/, '').replace(/\^FS$/, ''));

function dm(content: string, gs1?: boolean) {
  return [{
    type: 'qrcode' as const, xMm: 2, yMm: 2, hMm: 16,
    qrcode: { sym: 'DATAMATRIX', content, ecc: 'M', moduleSizeMm: 0.3, quietZoneMm: 1, gs1 } as any,
  }] as any;
}

test('GS1 DataMatrix：前导 >8 + 变长 AI 后 >8，括号被剥离', () => {
  const r = generateZpl(dm('(01)12345678901231(10)AB12(17)251231', true), DPI);
  assert.equal(r.warnings.length, 0);
  // (10) 是变长 AI，后面还有 (17) → 中间必须插 FNC1
  assert.match(r.text, /\^FD>8011234567890123110AB12>817251231\^FS/, r.text);
  assert.ok(!r.text.includes('(01)'), 'HRI 括号不应进入数据流');
});

test('GS1 DataMatrix：全定长 AI 只有前导 >8，无多余分隔', () => {
  const r = generateZpl(dm('(01)12345678901231(17)251231', true), DPI);
  assert.match(r.text, /\^FD>8011234567890123117251231\^FS/, r.text);
  assert.equal((r.text.match(/>8/g) ?? []).length, 1);
});

test('非 GS1 的 DataMatrix 原样输出（不误改普通码）', () => {
  const r = generateZpl(dm('LOT-2611/AB12'), DPI);
  assert.match(r.text, /\^FDLOT-2611\/AB12\^FS/);
});

test('gs1 未开启时即使内容像 HRI 也不转码（交给模板作者负责）', () => {
  const r = generateZpl(dm('(01)12345678901231(17)251231'), DPI);
  assert.match(r.text, /\^FD\(01\)12345678901231\(17\)251231\^FS/);
});

test('GS1 数据非法：告警且按原内容输出，不静默改内容', () => {
  const r = generateZpl(dm('(01)123(17)251231', true), DPI);
  assert.ok(r.warnings.some((w) => /GS1 数据存疑/.test(w)), JSON.stringify(r.warnings));
  assert.match(r.text, /\^FD\(01\)123\(17\)251231\^FS/);
});

test('GS1 DataMatrix 内容在 ^FH 转义下不丢字符（含反斜杠/尖号）', () => {
  const r = generateZpl(dm('(01)12345678901231(10)AB^12', true), DPI);
  // ^ 必须被转成 ^FH 十六进制，否则会截断指令
  assert.ok(!r.text.includes('AB^12'), r.text);
  assert.match(r.text, /AB\\\\5E12|AB\\5E12/, r.text);
});
