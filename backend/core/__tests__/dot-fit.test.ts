// P0-3：设计 mm 与打印 dot 一致性 —— 纯函数单测
import test from 'node:test';
import assert from 'node:assert/strict';
import { dotMm, dotFit, snapToDot, analyzeDotFit, summarizeDotFit } from '../dot-fit';

test('每点毫米：203/300/600dpi', () => {
  assert.equal(Math.round(dotMm(203) * 10000) / 10000, 0.1251);
  assert.equal(Math.round(dotMm(300) * 10000) / 10000, 0.0847);
  assert.equal(Math.round(dotMm(600) * 10000) / 10000, 0.0423);
});

test('0.30mm @203dpi = 2 点 = 0.25mm（缩水 16.7%）', () => {
  const f = dotFit(0.3, 203);
  assert.equal(f.dots, 2);
  assert.equal(f.actualMm, 0.25);
  assert.equal(f.exact, false);
  assert.ok(Math.abs(f.deltaPct + 0.1665) < 0.002, `deltaPct=${f.deltaPct}`);
});

test('整点值不报偏差：0.25mm、0.375mm @203dpi', () => {
  assert.equal(dotFit(0.25, 203).exact, true);
  assert.equal(dotFit(0.375, 203).dots, 3);
  assert.equal(dotFit(0.375, 203).exact, true);
});

test('建议值取最近的整点毫米', () => {
  assert.equal(snapToDot(0.3, 203), 0.25);
  assert.equal(snapToDot(0.32, 203), 0.375); // 2.56 点，四舍五入到 3 点
  assert.equal(snapToDot(0.35, 203), 0.375);
  assert.equal(snapToDot(0.3, 600), 0.296); // 600dpi 一个点 0.0423，7 点 = 0.296
});

test('小于 1 点：直接警告画不出来', () => {
  const issues = analyzeDotFit([{ id: 'l1', type: 'line', stroke: { width: 0.05 } }], 203);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'warn');
  assert.equal(issues[0].dots, 0);
  assert.match(issues[0].message, /画不出来/);
});

test('条码模块宽 0.3mm @203dpi 报警，条高/静区按偏差分级', () => {
  const els = [{ id: 'b1', type: 'barcode', barcode: { moduleWidthMm: 0.3, heightMm: 9, quietZoneMm: 2 } }];
  const issues = analyzeDotFit(els, 203);
  const mw = issues.find((i) => i.field === 'moduleWidthMm')!;
  assert.equal(mw.level, 'warn');
  assert.match(mw.message, /0\.3mm/);
  assert.match(mw.message, /0\.25mm/);
  assert.match(mw.message, /细 16\.6%/);
  assert.match(mw.message, /建议改成 0\.25mm/);
  // 条高 9mm → 72 点 = 9.008mm，偏差 <5% 只算 info
  const h = issues.find((i) => i.field === 'heightMm');
  if (h) assert.equal(h.level, 'info');
});

test('DataMatrix 模块尺寸 0.3mm @300dpi 通过（0.0847×4=0.339 偏差以外…按实际算）', () => {
  const issues = analyzeDotFit([{ id: 'q1', type: 'qrcode', qrcode: { moduleSizeMm: 0.339, quietZoneMm: 1.016 } }], 300);
  assert.equal(issues.length, 0, '0.339mm 在 300dpi 下正好 4 点');
  const bad = analyzeDotFit([{ id: 'q1', type: 'qrcode', qrcode: { moduleSizeMm: 0.3, quietZoneMm: 1.016 } }], 300);
  assert.equal(bad.find((i) => i.field === 'moduleSizeMm')!.level, 'warn');
});

test('文案汇总：有 warn 时优先报 warn', () => {
  const s = summarizeDotFit(analyzeDotFit([{ id: 'b', type: 'barcode', barcode: { moduleWidthMm: 0.3 } }], 203), 203);
  assert.equal(s.warns, 1);
  assert.match(s.text, /取整后偏差较大/);
  const ok = summarizeDotFit([], 203);
  assert.equal(ok.text, '');
  assert.equal(ok.total, 0);
});
