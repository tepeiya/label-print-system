// 第三层：MaxiCode 原生 ^BD 指令构造单测（对照 Zebra 官方样例）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  zplHexEscape, buildHighPriorityMessage, buildMaxicodeZpl,
  UPS_LPM_HEADER, type StructuredMaxicode,
} from '../maxicode';

test('zplHexEscape：GS/RS/EOT/括号/下划线转义，常规字符保留', () => {
  assert.equal(zplHexEscape('ABC-123'), 'ABC-123');
  assert.equal(zplHexEscape('\u001D'), '_1D');
  assert.equal(zplHexEscape('\u001E'), '_1E');
  assert.equal(zplHexEscape('\u0004'), '_04');
  assert.equal(zplHexEscape('[)>'), '_5B)>', '官方样例 [)> 仅 [ 转义，)> 保留');
  assert.equal(zplHexEscape('A_B'), 'A_5FB');
  assert.equal(zplHexEscape(']_'), '_5D_5F');
});

test('buildHighPriorityMessage：Mode 2 美国数字邮编（官方样例 002840100450000）', () => {
  const r = buildHighPriorityMessage({
    mode: 2, serviceClass: '002', countryCode: '840', postalCode: '10045', postalExtension: '0000',
  });
  assert.equal(r.ok, true);
  assert.equal(r.hpm, '002840100450000');
});

test('buildHighPriorityMessage：Mode 3 非美国邮编（官方样例 066826RS19__）', () => {
  const r = buildHighPriorityMessage({
    mode: 3, serviceClass: '066', countryCode: '826', postalCode: 'RS19',
  });
  assert.equal(r.ok, true);
  assert.equal(r.hpm, '066826RS19  ');
});

test('buildHighPriorityMessage：非法参数被拒（服务等级/国家码/邮编）', () => {
  assert.equal(buildHighPriorityMessage({ mode: 2, serviceClass: '00', countryCode: '840', postalCode: '10045' }).ok, false);
  assert.equal(buildHighPriorityMessage({ mode: 2, serviceClass: '002', countryCode: '84A', postalCode: '10045' }).ok, false);
  assert.equal(buildHighPriorityMessage({ mode: 2, serviceClass: '002', countryCode: '840', postalCode: 'ABCDE' }).ok, false);
  assert.equal(buildHighPriorityMessage({ mode: 2, serviceClass: '002', countryCode: '840', postalCode: '10045', postalExtension: 'AB' }).ok, false);
});

test('buildMaxicodeZpl：Mode 4 自由数据（^BY 无效，无旋转）', () => {
  const r = buildMaxicodeZpl('MaxiCode sample', { mode: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 4);
  assert.equal(r.zpl, '^BD4,1,1^FH^FDMaxiCode sample^FS');
  assert.ok(r.warnings.some((w) => /固定/.test(w)), '应提示固定尺寸/无旋转');
  assert.ok(!r.zpl.includes('^BY'), '不得输出 ^BY（对 MaxiCode 无效）');
});

test('buildMaxicodeZpl：Mode 2 结构化含 n/t 序号与转义数据', () => {
  const spec: StructuredMaxicode = {
    mode: 2, serviceClass: '002', countryCode: '840', postalCode: '10045', postalExtension: '0000',
    lowPriority: UPS_LPM_HEADER + '1Z00136071',
  };
  const r = buildMaxicodeZpl(spec, { n: 1, t: 3 });
  assert.equal(r.ok, true);
  assert.match(r.zpl, /^\^BD2,1,3\^FH\^FD/);
  assert.match(r.zpl, /002840100450000/, '含高优先级消息');
  assert.match(r.zpl, /_1E01_1D96/, 'RS/GS 已十六进制转义');
  assert.ok(r.warnings.some((w) => /承运商/.test(w)), '应提示格式错误会被拒收');
});

test('buildMaxicodeZpl：自由字符串传 Mode 2/3 被拒并引导结构化', () => {
  const r = buildMaxicodeZpl('plain text', { mode: 2 });
  assert.equal(r.ok, false);
  assert.match(r.warnings.join(' '), /结构化/);
});

test('buildMaxicodeZpl：n/t 夹取到 1-8', () => {
  const r = buildMaxicodeZpl('X', { mode: 4, n: 99, t: 0 });
  assert.equal(r.zpl, '^BD4,8,1^FH^FDX^FS');
});

test('buildMaxicodeZpl：空内容被拒', () => {
  assert.equal(buildMaxicodeZpl('', { mode: 4 }).ok, false);
});

// ------------------------------ ZPL 生成器 opt-in 集成 ------------------------------
import { generateZpl } from '../zpl-generator';

test('ZPL 生成器：MAXICODE 默认仍走 warning + 跳过（安全的预览仅默认）', () => {
  const out = generateZpl([{
    type: 'qrcode', xMm: 10, yMm: 10, hMm: 25,
    qrcode: { sym: 'MAXICODE', content: 'FREE', ecc: 'M', moduleSizeMm: 0.5, quietZoneMm: 2 },
  } as any], 203);
  assert.ok(!out.text.includes('^BD'), '默认不应输出 ^BD');
  assert.ok(out.warnings.some((w) => /暂未覆盖|\^BD/.test(w)), '应给暂未覆盖引导');
});

test('ZPL 生成器：显式 maxicode opt-in 输出原生 ^BD', () => {
  const out = generateZpl([{
    type: 'qrcode', xMm: 10, yMm: 10, hMm: 25,
    qrcode: { sym: 'MAXICODE', content: 'FREE-TEXT', ecc: 'M', moduleSizeMm: 0.5, quietZoneMm: 2 },
    maxicode: { mode: 4 },
  } as any], 203);
  assert.match(out.text, /\^FO\d+,\d+\^BD4,1,1\^FH\^FDFREE-TEXT\^FS/);
  assert.ok(out.warnings.some((w) => /固定/.test(w)));
});

test('ZPL 生成器：结构化 maxicode opt-in 输出 ^BD2 + 转义', () => {
  const out = generateZpl([{
    type: 'qrcode', xMm: 10, yMm: 10, hMm: 25,
    qrcode: { sym: 'MAXICODE', content: '', ecc: 'M', moduleSizeMm: 0.5, quietZoneMm: 2 },
    maxicode: { mode: 2, serviceClass: '002', countryCode: '840', postalCode: '10045', postalExtension: '0000' },
  } as any], 203);
  assert.match(out.text, /\^BD2,1,1\^FH\^FD002840100450000/);
  assert.ok(out.warnings.some((w) => /承运商/.test(w)));
});
