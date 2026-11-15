// B2.6 护栏 7 单测：Agent 工具返回字段脱敏（纯函数，不 import Nest / 不连库）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DEPTH, maskValue, redact, redactionWarning, shouldRedact,
} from '../redaction.calc';

test('maskValue: 保留「有值 + 类型 + 长度量级」，不泄露原文', () => {
  assert.equal(maskValue(null), null);
  assert.equal(maskValue(undefined), undefined);
  assert.equal(maskValue(''), '');
  assert.equal(maskValue('13800138000'), '1***(11)');
  assert.equal(maskValue(true), true);            // 布尔无敏感信息，保留供模型推理
  assert.equal(maskValue(12345), '~10000(number)');
  assert.equal(maskValue(-12345), '~-10000(number)');
  assert.equal(maskValue(0), '~0(number)');
  assert.equal(maskValue(Infinity), '***');
  assert.equal(maskValue({ a: 1 }), '***');
});

test('redact: 深度脱敏命中敏感 key，结构与非敏感字段保留', () => {
  const input = {
    id: 42,
    status: 'ok',
    customer_name: '深圳市某某科技有限公司',
    phone: '13800138000',
    unit_price: 88.5,
    nested: { address: '广东省深圳市南山区', count: 3, rows: [{ email: 'a@b.com' }, { email: 'c@d.com' }] },
  };
  const snapshot = JSON.stringify(input);
  const r = redact(input);
  assert.equal(r.redacted, true);
  assert.equal(r.data.id, 42);
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.nested.count, 3);
  assert.equal(r.data.customer_name, '深***(11)');
  assert.equal(r.data.phone, '1***(11)');
  assert.equal(r.data.unit_price, '~10(number)');
  assert.equal(r.data.nested.rows[0].email, 'a***(7)');
  assert.equal(JSON.stringify(input), snapshot, '输入对象不得被修改');
  assert.ok(r.redactedFields.includes('customer_name'));
  assert.ok(r.redactedFields.includes('nested.address'));
  assert.ok(r.redactedFields.some((p) => p.includes('rows[0].email')));
});

test('redact: 白名单结构字段不脱敏（否则 Agent 无法继续编排）', () => {
  const r = redact({ id: 1, tenantId: 9, status: 'ok', code: 4037, total: 3, createdAt: 'x', warnings: [] });
  assert.equal(r.redacted, false);
  assert.deepEqual(r.data, { id: 1, tenantId: 9, status: 'ok', code: 4037, total: 3, createdAt: 'x', warnings: [] });
});

test('redact: 命名变体（下划线/驼峰/大小写）统一归一化匹配', () => {
  const r = redact({ CustomerName: '张三', API_KEY: 'sk-abc', 'post-code': '518000', id_card: '4403...' });
  assert.equal(r.data.CustomerName, '***(2)');   // 短串全掩码，不保留首字
  assert.notEqual(r.data.API_KEY, 'sk-abc');
  assert.notEqual(r.data['post-code'], '518000');
  assert.notEqual(r.data.id_card, '4403...');
});

test('redact: 循环引用与深度上限不会栈溢出', () => {
  const cyc: any = { id: 1, phone: '138' };
  cyc.self = cyc;
  assert.equal(redact(cyc).data.self, '[circular]');

  let deep: any = { password: 'x' };
  for (let i = 0; i < MAX_DEPTH + 5; i++) deep = { level: i, child: deep };
  assert.doesNotThrow(() => redact(deep));
  const shallow = redact(deep, { maxDepth: 2 });
  assert.equal(typeof shallow.data, 'object');
  assert.ok(JSON.stringify(shallow.data).includes('[depth-limit]'));
});

test('redact: redactedFields 去重且最多 50 条', () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 80; i++) many[`phone_${i}`] = `1380000${i}`;
  const r = redact(many);
  assert.equal(r.redactedFields.length, 50);
  assert.equal(r.data.phone_0, '1***(8)');
});

test('shouldRedact: 元数据工具跳过，业务工具必须脱敏', () => {
  assert.equal(shouldRedact('help'), false);
  assert.equal(shouldRedact('whoami'), false);
  assert.equal(shouldRedact('list_tools'), false);
  assert.equal(shouldRedact('list_modules'), false);
  assert.equal(shouldRedact('explain_capabilities'), false);
  assert.equal(shouldRedact('inventory.query_stock'), true);
  assert.equal(shouldRedact('print.submit_job'), true);
  assert.equal(shouldRedact('templates.search'), true);
  assert.equal(shouldRedact(''), true);   // 未知工具按最严处理
});

test('redactionWarning: 未脱敏返回 null，脱敏时列出字段数与前几个路径', () => {
  assert.equal(redactionWarning(redact({ id: 1 })), null);
  const w = redactionWarning(redact({ phone: '138', email: 'a@b.com' }));
  assert.ok(w?.includes('护栏7'));
  assert.ok(w?.includes('2 个字段'));
  assert.ok(w?.includes('敏感原值未下发'));
});
