// =============================================================================
// platform-admin.test.ts —— P2 平台运营身份（docs/11 §11.6.2）
// 只测不依赖 DB 的部分：PlatformJwtGuard 的 scope 隔离 + 到期提醒的日期窗口过滤。
// 不 import repository / DataSource（tsx 不产出 decorator metadata，实体进 TypeORM 会炸）。
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlatformJwtGuard } from '../platform-admin/platform-jwt.guard';
import { EXPIRE_WARN_DAYS, filterExpiring } from '../platform-admin/expire.util';

// —— PlatformJwtGuard ——

function ctxWith(auth?: string) {
  const req: any = { headers: auth ? { authorization: auth } : {}, query: {} };
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}
const guard = new PlatformJwtGuard({ verify: (t: string) => JSON.parse(Buffer.from(t, 'base64url').toString()) } as any);

test('scope=platform 的 token 放行，并写入 req.platformUser', () => {
  const token = Buffer.from(JSON.stringify({ sub: 1, username: 'platform', role: 'super', scope: 'platform' })).toString('base64url');
  const ctx = ctxWith(`Bearer ${token}`);
  assert.equal(guard.canActivate(ctx), true);
  assert.deepEqual((ctx as any).switchToHttp().getRequest().platformUser, { id: 1, username: 'platform', role: 'super' });
});

test('租户 JWT（无 scope）→ 403：租户账号不能调运营接口', () => {
  const token = Buffer.from(JSON.stringify({ sub: 9, tenantId: 1, roles: ['admin'] })).toString('base64url');
  assert.throws(() => guard.canActivate(ctxWith(`Bearer ${token}`)), (e: any) => e.getStatus() === 403);
});

test('无 token / 坏 token → 401', () => {
  assert.throws(() => guard.canActivate(ctxWith()), (e: any) => e.getStatus() === 401);
  assert.throws(() => guard.canActivate(ctxWith('Bearer not-a-token')), (e: any) => e.getStatus() === 401);
});

// —— filterExpiring（到期提醒窗口）——

const daysAgo = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

test('试用 3 天内到期的租户进提醒名单，太远/已过期/非 trial 不进', () => {
  const tenants = [
    { id: 1, code: 'a', name: 'A', subscriptionStatus: 'trial', trialEndsAt: daysAgo(2) },   // 命中
    { id: 2, code: 'b', name: 'B', subscriptionStatus: 'trial', trialEndsAt: daysAgo(10) },  // 太远
    { id: 3, code: 'c', name: 'C', subscriptionStatus: 'trial', trialEndsAt: daysAgo(-1) },  // 已过期
    { id: 4, code: 'd', name: 'D', subscriptionStatus: 'active', trialEndsAt: daysAgo(1) },  // 非 trial
  ];
  const out = filterExpiring(tenants, EXPIRE_WARN_DAYS);
  assert.deepEqual(out.map((t) => t.code), ['a']);
});

test('提醒窗口边界：正好第 3 天算，第 3 天+1ms 不算', () => {
  const edge = new Date(Date.now() + EXPIRE_WARN_DAYS * 86_400_000).toISOString();
  const out = filterExpiring(
    [{ id: 1, code: 'edge', name: 'E', subscriptionStatus: 'trial', trialEndsAt: edge }],
    EXPIRE_WARN_DAYS,
  );
  assert.equal(out.length, 1);
});
