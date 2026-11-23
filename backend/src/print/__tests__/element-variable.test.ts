// =============================================================================
// element-variable.test.ts —— 「一键把元素设为变量」回归
//   前端无测试基建，沿用 frontend-print.test.ts 的方式借后端 tsx runner 直接跑纯 TS。
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore 前端纯 TS 模块
import {
  isValidVariableName,
  planElementVariable,
  renamePlaceholdersInElement,
} from '../../../../apps/console/src/views/designer/engine/element-variable.ts';

function el(type: string, patch: Record<string, unknown> = {}): any {
  return { id: `e-${type}`, type, x: 1, y: 1, w: 20, h: 8, ...patch };
}

function okPlan(target: any, existing: string[] = []): any {
  const plan = planElementVariable(target, existing);
  assert.ok(plan.ok, plan.ok ? '' : plan.reason);
  return plan;
}

// ------------------------------ 命名 ------------------------------
test('变量名规则与 VariablesPanel 同口径', () => {
  assert.equal(isValidVariableName('产品名称'), true);
  assert.equal(isValidVariableName('sku_2'), true);
  assert.equal(isValidVariableName('2sku'), false);
  assert.equal(isValidVariableName('@serial'), false);
  assert.equal(isValidVariableName('产品 名称'), false);
  assert.equal(isValidVariableName('{{sku}}'), false);
});

test('文本「标签：示例」→ 变量名取标签，原内容作示例值', () => {
  const target = el('text', { text: '产品名称：示例产品' });
  const plan = okPlan(target);
  assert.equal(plan.name, '产品名称');
  assert.equal(plan.sample, '产品名称：示例产品');
  plan.apply(target);
  assert.equal(target.text, '{{产品名称}}');
});

test('内容为空时按类型兜底，并避开已有变量', () => {
  const target = el('text', { text: '' });
  const plan = okPlan(target, ['文本1']);
  assert.equal(plan.name, '文本2');
  plan.apply(target);
  assert.equal(target.text, '{{文本2}}');
});

test('数字开头的内容补「字段」前缀', () => {
  assert.equal(okPlan(el('text', { text: '123456' })).name, '字段123456');
});

test('图层名可作变量名（优先级高于内容）', () => {
  const target = el('text', { name: '批次号', text: 'B-001' });
  assert.equal(okPlan(target).name, '批次号');
});

// ------------------------------ 各类型绑定 ------------------------------
test('富文本：绑定首个片段，保留其样式，其余片段清空', () => {
  const target = el('richtext', {
    text: 'AB',
    runs: [{ text: 'A', bold: true }, { text: 'B', italic: true }],
  });
  const plan = okPlan(target);
  plan.apply(target);
  assert.deepEqual(target.runs, [{ text: '{{AB}}', bold: true }]);
  assert.equal(target.text, '{{AB}}');
});

test('一维码 / 二维码：写到 content', () => {
  const bc = el('barcode', { barcode: { sym: 'CODE128', content: '产品编码' } });
  okPlan(bc).apply(bc);
  assert.equal(bc.barcode.content, '{{产品编码}}');

  const qr = el('qrcode', { qrcode: { content: '产品编码' } });
  okPlan(qr).apply(qr);
  assert.equal(qr.qrcode.content, '{{产品编码}}');
});

test('图片：地址作示例值，变量名走兜底（不拿 data URL 当名字）', () => {
  const target = el('image', { src: 'data:image/png;base64,AAAA' });
  const plan = okPlan(target);
  assert.equal(plan.name, '图片1');
  assert.equal(plan.sample, 'data:image/png;base64,AAAA');
  plan.apply(target);
  assert.equal(target.src, '{{图片1}}');
});

test('表格：跳过表头，绑定首个正文格并回报位置', () => {
  const target = el('table', {
    rows: 3, cols: 3, headerRow: true,
    cells: ['列1', '列2', '列3', '产品编码', '', '', '', '', ''],
  });
  const plan = okPlan(target);
  assert.equal(plan.slot, '表格 R2C1');
  assert.equal(plan.name, '产品编码');
  plan.apply(target);
  assert.equal(target.cells[3], '{{产品编码}}');
  assert.equal(target.cells[0], '列1');
});

test('表格：跳过被合并覆盖的格子', () => {
  const target = el('table', {
    rows: 3, cols: 3, headerRow: true,
    cells: ['列1', '列2', '列3', '', '', 'X', '', '', ''],
    mergedCells: [{ row: 1, col: 0, rowSpan: 1, colSpan: 2 }],
  });
  const plan = okPlan(target);
  assert.equal(plan.slot, '表格 R2C3');
  assert.equal(plan.name, 'X');
});

// ------------------------------ 拒绝场景 ------------------------------
test('图形与系统生成类元素拒绝绑定，并说明原因', () => {
  const rect = planElementVariable(el('rect'));
  assert.equal(rect.ok, false);
  assert.match((rect as any).reason, /矩形/);

  const serial = planElementVariable(el('serial'));
  assert.equal(serial.ok, false);
  assert.match((serial as any).reason, /流水号/);
});

test('已绑定 / 混排占位不覆盖，避免丢静态文字', () => {
  const bound = planElementVariable(el('text', { text: '{{sku}}' }));
  assert.equal(bound.ok, false);
  assert.match((bound as any).reason, /已绑定/);

  const mixed = planElementVariable(el('text', { text: 'SKU: {{sku}}' }));
  assert.equal(mixed.ok, false);
  assert.match((mixed as any).reason, /占位符/);
});

// ------------------------------ 改名同步 ------------------------------
test('变量改名：同步元素内所有占位与同名图层', () => {
  const target = el('table', {
    name: '产品名称',
    cells: ['{{产品名称}}', 'x'],
    printIf: '{{产品名称}} != ""',
    qrcode: { content: '{{产品名称}}' },
  });
  const changed = renamePlaceholdersInElement(target, '产品名称', '品名');
  assert.equal(changed, true);
  assert.equal(target.name, '品名');
  assert.equal(target.cells[0], '{{品名}}');
  assert.equal(target.printIf, '{{品名}} != ""');
  assert.equal(target.qrcode.content, '{{品名}}');
});

test('变量改名不误伤相似变量名', () => {
  const target = el('text', { text: '{{产品名称}}{{产品名称备注}}' });
  renamePlaceholdersInElement(target, '产品名称', '品名');
  assert.equal(target.text, '{{品名}}{{产品名称备注}}');
});
