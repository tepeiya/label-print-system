// =============================================================================
// roles.guard.test.ts —— RolesGuard 4 条规则 + D11 新旧角色码兼容（§10.9 #5）
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';

import { RolesGuard, effectiveRoles } from '../roles.guard';

/** 最小 Reflector 替身：只关心 @Roles 元数据 */
function guardWith(declared?: string[]) {
  const reflector: any = { getAllAndOverride: () => declared };
  return new RolesGuard(reflector);
}

/** 最小 ExecutionContext 替身：只喂一个 req.user.roles */
function ctxOf(roles?: string[]): any {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
  };
}

test('规则1：路由没写 @Roles → 放行（对未标记接口零侵入）', () => {
  assert.equal(guardWith(undefined).canActivate(ctxOf([])), true);
  assert.equal(guardWith([]).canActivate(ctxOf(['viewer'])), true);
});

test('规则2：admin 对任何 @Roles 声明无条件放行', () => {
  assert.equal(guardWith(['admin']).canActivate(ctxOf(['admin'])), true);
  assert.equal(guardWith(['admin', 'operator']).canActivate(ctxOf(['admin'])), true);
});

test('规则3：命中声明角色放行', () => {
  assert.equal(guardWith(['admin', 'operator']).canActivate(ctxOf(['operator'])), true);
  assert.equal(guardWith(['sql']).canActivate(ctxOf(['sql'])), true);
});

test('规则4：未命中抛 Forbidden，且消息带上需要的角色', () => {
  assert.throws(
    () => guardWith(['admin', 'operator']).canActivate(ctxOf(['viewer'])),
    (err: any) => {
      assert.ok(err instanceof ForbiddenException);
      assert.match(err.message, /admin \/ operator/);
      return true;
    },
  );
});

test('兼容期：tenant_admin 视同 admin，manager 视同 sql（D11）', () => {
  assert.equal(guardWith(['admin']).canActivate(ctxOf(['tenant_admin'])), true);
  assert.equal(guardWith(['sql']).canActivate(ctxOf(['manager'])), true);
  assert.equal(guardWith(['tenant_admin']).canActivate(ctxOf(['admin'])), true);
});

test('未登录（无 roles）时按声明拒绝', () => {
  assert.throws(() => guardWith(['operator']).canActivate(ctxOf(undefined)), ForbiddenException);
});

test('effectiveRoles 双向展开旧码/新码', () => {
  const s = effectiveRoles(['admin']);
  assert.deepEqual([...s].sort(), ['admin', 'tenant_admin']);
  assert.deepEqual([...effectiveRoles(['viewer'])], ['viewer']);
});
