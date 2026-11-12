// P6.2 阶段 B 单测：租户上下文必须注入**真实** dataSourceKey（路由闭环的前置）
// 阶段 A 这里硬编码 'default'，导致独立库租户的业务读写仍落共享库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { of } from 'rxjs';
import { tenantStorage } from '../tenant.context';
import { TenantContextInterceptor } from '../tenant-context.interceptor';

const services = () => ({
  modules: { listTenantActive: async () => [], getPlan: async () => null },
  perms: { listByRoles: async () => [] },
  cfg: { featuresFor: async () => ({}), dataScopeFor: async () => null },
} as any);

function execCtx(tenantId: number) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: { tenantId, sub: 3, roles: ['admin'] } }),
    }),
  } as any;
}

async function run(dsRows: any[], tenantId = 5) {
  const s = services();
  const ds = { query: async () => dsRows } as any;
  const interceptor = new TenantContextInterceptor(s.modules, s.perms, s.cfg, ds);
  const obs = await interceptor.intercept(execCtx(tenantId), {
    handle: () => of(tenantStorage.getStore()),
  } as any);
  return new Promise<any>((resolve) => obs.subscribe(resolve));
}

test('登录用户：dataSourceKey 取自目录库 tenants.data_source_key，不再硬编码 default', async () => {
  const store = await run([{ data_source_key: 'acme-prod' }]);
  assert.equal(store.dataSourceKey, 'acme-prod');
  assert.equal(store.tenantId, 5);
});

test('查不到 / 空值一律回落 default（老库没这列也不把请求打挂）', async () => {
  assert.equal((await run([])).dataSourceKey, 'default');
  assert.equal((await run([{ data_source_key: null }])).dataSourceKey, 'default');
  assert.equal((await run([{}])).dataSourceKey, 'default');
});

test('目录库查询抛错时容错降级 default', async () => {
  const s = services();
  const ds = { query: async () => { throw new Error('db down'); } } as any;
  const interceptor = new TenantContextInterceptor(s.modules, s.perms, s.cfg, ds);
  const obs = await interceptor.intercept(execCtx(5), { handle: () => of(tenantStorage.getStore()) } as any);
  const store = await new Promise<any>((resolve) => obs.subscribe(resolve));
  assert.equal(store.dataSourceKey, 'default');
});

test('public 路由（tenantId=0）不查 SaaS 数据，也没有 dataSourceKey', async () => {
  const store = await run([{ data_source_key: 'acme' }], 0);
  assert.equal(store.tenantId, 0);
  assert.equal(store.dataSourceKey, undefined);   // 代理按「空上下文」回落共享库
});
