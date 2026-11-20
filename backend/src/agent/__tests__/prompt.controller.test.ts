// Prompt 库增强的接线守卫测试：版本/回滚端点权限 + roles DTO 校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';

import { PromptsController } from '../prompts.controller';
import { PERMISSION_KEY } from '../../common/permission.guard';
import { MODULE_KEY } from '../../common/module.guard';
import { UpsertPromptDto } from '../dto/agent.dto';

const reflector = new Reflector();

test('Prompt 控制器模块门 agent + 类级权限 sys:prompt:manage', () => {
  assert.deepEqual(reflector.get(MODULE_KEY, PromptsController), ['agent']);
  assert.deepEqual(reflector.get(PERMISSION_KEY, PromptsController), ['sys:prompt:manage']);
});

test('版本历史与回滚端点存在，且受类级权限保护', () => {
  const versions = (PromptsController.prototype as any).versions;
  const rollback = (PromptsController.prototype as any).rollback;
  assert.equal(typeof versions, 'function', '缺少版本历史端点');
  assert.equal(typeof rollback, 'function', '缺少回滚端点');
  // 端点未单独覆盖权限 → 继承类级 sys:prompt:manage
  assert.equal(reflector.get(PERMISSION_KEY, versions), undefined);
  assert.equal(reflector.get(PERMISSION_KEY, rollback), undefined);
});

test('UpsertPromptDto 接受合法 roles，拒绝非字符串/超限', async () => {
  const good = Object.assign(new UpsertPromptDto(), {
    title: '标题', content: '这是一段足够长的提示词正文内容', roles: ['manager', 'purchaser'],
  });
  assert.deepEqual(await validate(good), []);

  const bad = Object.assign(new UpsertPromptDto(), {
    title: '标题', content: '这是一段足够长的提示词正文内容', roles: [123, 'x'.repeat(50)],
  });
  assert.ok((await validate(bad)).length > 0, '非字符串角色码应被拒绝');

  const tooMany = Object.assign(new UpsertPromptDto(), {
    title: '标题', content: '这是一段足够长的提示词正文内容',
    roles: Array.from({ length: 25 }, (_, i) => `r${i}`),
  });
  assert.ok((await validate(tooMany)).length > 0, '超过 20 个角色应被拒绝');
});
