// =============================================================================
// saas-guards.test.ts —— ModuleGuard / PermissionGuard 的业务码契约
// 对应 §11.11.1 验收标准：未订阅 → 403 + code 4031；无权限点 → 403 + code 4032
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ModuleGuard } from '../module.guard';
import { PermissionGuard } from '../permission.guard';
import { BizCode } from '../business.errors';

function ctxOf(user: any): any {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  };
}

function moduleGuard(declared: string[], active: string[], plan: string | null = 'BASIC') {
  const reflector: any = { getAllAndOverride: () => declared };
  const svc: any = {
    listTenantActive: async () => active,
    getPlan: async () => (plan ? { code: plan, name: `${plan} 版` } : null),
  };
  return new ModuleGuard(reflector, svc);
}

function permissionGuard(declared: string[], perms: string[], called: { current: boolean }) {
  const reflector: any = { getAllAndOverride: () => declared };
  const svc: any = {
    listByRoles: async () => {
      called.current = true;
      return perms;
    },
  };
  return new PermissionGuard(reflector, svc);
}

// ---------------- ModuleGuard ----------------

test('未声明 @RequireModule → 放行', async () => {
  assert.equal(await moduleGuard([], ['print']).canActivate(ctxOf({ tenantId: 1 })), true);
});

test('public 路由（无 tenantId）→ 放行，不查订阅', async () => {
  assert.equal(await moduleGuard(['audit'], []).canActivate(ctxOf({})), true);
});

test('模块已订阅 → 放行', async () => {
  assert.equal(await moduleGuard(['print'], ['print', 'templates']).canActivate(ctxOf({ tenantId: 1 })), true);
});

test('多模块声明满足其一即可', async () => {
  assert.equal(await moduleGuard(['inventory', 'print'], ['print']).canActivate(ctxOf({ tenantId: 1 })), true);
});

test('未订阅 → 403 + code 4031 + 提示升级', async () => {
  await assert.rejects(
    () => moduleGuard(['audit'], ['print', 'templates']).canActivate(ctxOf({ tenantId: 2 })),
    (err: any) => {
      assert.equal(err.getStatus(), 403);
      assert.equal(err.bizCode, BizCode.MODULE_NOT_SUBSCRIBED);
      assert.equal(err.bizCode, 4031);
      assert.match(err.message, /未开通模块: audit/);
      assert.equal(err.detail.action, 'upgrade');
      assert.equal(err.detail.plan, 'BASIC');
      assert.deepEqual(err.detail.modules, ['audit']);
      return true;
    },
  );
});

// ---------------- PermissionGuard ----------------

test('未声明 @RequirePermission → 放行', async () => {
  const called = { current: false };
  assert.equal(await permissionGuard([], ['*'], called).canActivate(ctxOf({ roles: ['operator'] })), true);
  assert.equal(called.current, false, '没声明权限点时不该查库');
});

test('超管（admin / tenant_admin）直接放行，不查权限表', async () => {
  const called = { current: false };
  assert.equal(await permissionGuard(['audit:export'], [], called).canActivate(ctxOf({ roles: ['admin'] })), true);
  assert.equal(await permissionGuard(['audit:export'], [], called).canActivate(ctxOf({ roles: ['tenant_admin'] })), true);
  assert.equal(called.current, false);
});

test('命中权限点 → 放行（含通配）', async () => {
  const called = { current: false };
  assert.equal(
    await permissionGuard(['print:job:submit'], ['print:*'], called).canActivate(ctxOf({ roles: ['operator'] })),
    true,
  );
});

test('权限不足 → 403 + code 4032 + 提示找管理员', async () => {
  const called = { current: false };
  await assert.rejects(
    () => permissionGuard(['audit:export'], ['audit:read'], called).canActivate(ctxOf({ roles: ['viewer'] })),
    (err: any) => {
      assert.equal(err.getStatus(), 403);
      assert.equal(err.bizCode, BizCode.PERMISSION_DENIED);
      assert.equal(err.bizCode, 4032);
      assert.match(err.message, /缺少权限: audit:export/);
      assert.equal(err.detail.action, 'contact_admin');
      return true;
    },
  );
});

test('无角色用户放行给 RolesGuard 兜底（守卫职责不重叠）', async () => {
  const called = { current: false };
  assert.equal(await permissionGuard(['audit:read'], [], called).canActivate(ctxOf({ roles: [] })), true);
  assert.equal(called.current, false);
});
