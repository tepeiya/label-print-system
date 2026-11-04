// =============================================================================
// errors.filter.test.ts —— 业务码透出契约（§11.11.1 要求响应体 code=4031/4032）
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AllExceptionsFilter } from '../errors.filter';
import { ModuleNotSubscribedException, PermissionDeniedException } from '../business.errors';

/**  captured 里拿到最终写出的 status + body */
function runFilter(exception: unknown) {
  let captured: { status?: number; body?: any } = {};
  const response = {
    status: (s: number) => {
      captured.status = s;
      return { json: (b: any) => { captured.body = b; } };
    },
  };
  const host: any = { switchToHttp: () => ({ getResponse: () => response }) };
  const filter = new AllExceptionsFilter();

  // 过滤器对未处理异常会 console.error，测试里静音，避免污染输出
  const origin = console.error;
  console.error = () => {};
  try {
    filter.catch(exception, host);
  } finally {
    console.error = origin;
  }
  return captured;
}

test('模块未订阅 → HTTP 403 + code 4031 + detail 展开', () => {
  const r = runFilter(new ModuleNotSubscribedException(['backup'], 'BASIC'));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 4031);
  assert.equal(r.body.data, null);
  assert.match(r.body.message, /未开通模块: backup/);
  assert.equal(r.body.action, 'upgrade');
  assert.equal(r.body.plan, 'BASIC');
  assert.deepEqual(r.body.modules, ['backup']);
});

test('权限不足 → HTTP 403 + code 4032', () => {
  const r = runFilter(new PermissionDeniedException(['audit:export']));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 4032);
  assert.equal(r.body.action, 'contact_admin');
});

test('普通 Nest 异常仍按 HTTP 状态码回填 code（回归保护）', () => {
  assert.equal(runFilter(new BadRequestException('参数不对')).body.code, 400);
  assert.equal(runFilter(new NotFoundException('没找到')).body.code, 404);
});

test('裸 Error → 500 + 统一中文提示（业务代码禁止抛裸 Error）', () => {
  const r = runFilter(new Error('boom'));
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 500);
  assert.equal(r.body.message, '服务器内部错误');
});
