// P6.2 阶段 B 单测：业务读写代理按 TenantCtx.dataSourceKey 路由
// 不启 Nest 容器、不连库：用鸭子类型替身验证「选哪个 DataSource」这一核心判定，
// 对应验收口径「独立库租户建模板，共享库 0 行」的路由层证据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantStorage, TenantCtx } from '../tenant.context';
import { TenantRouting, tenantRepositoryProxy } from '../tenant-routing';

const ctx = (dataSourceKey: string | null, tenantId = 77): TenantCtx => ({
  tenantId, userId: 3, roles: ['admin'], modules: [], permissions: [],
  plan: null, features: {}, dataScopes: null, dataSourceKey,
});

interface FakeRepo { name: string; findOne: (...a: any[]) => any; save: (...a: any[]) => any }
const repo = (name: string): FakeRepo => ({
  name,
  findOne: (...a: any[]) => ({ name, args: a }),
  save: (...a: any[]) => ({ name, args: a, saved: true }),
});

/** 构造一个不依赖 Nest DI 的 TenantRouting 替身（私有字段用 any 注入） */
function fakeRouting(opts: { registered?: Set<string>; throwOn?: string } = {}) {
  const shared = { getRepository: () => repo('shared'), isInitialized: true };
  const dedicated = { getRepository: () => repo('dedicated'), isInitialized: true };
  const calls: { key: string; applyScope?: number }[] = [];
  const r: any = Object.create(TenantRouting.prototype);
  r.defaultDs = shared;
  r.moduleRef = {
    get: () => ({
      get: (c: { dataSourceKey: string }) => {
        const key = c.dataSourceKey;
        if (opts.registered && !opts.registered.has(key)) {
          const e: any = new Error(`独立数据源 "${key}" 未注册`);
          e.status = 503;
          throw e;
        }
        calls.push({ key });
        return dedicated;
      },
      applyTenantScope: async (_runner: any, tenantId: number) => {
        calls.push({ key: 'guc', applyScope: tenantId });
      },
    }),
  };
  return { routing: r as TenantRouting, calls, shared, dedicated };
}

test('dataSource(): default / 空上下文 → 共享库；独立库 key → tdsm.get(ctx)', () => {
  const { routing, calls } = fakeRouting({ registered: new Set(['acme']) });
  assert.equal(routing.dataSource().getRepository({} as any).name, 'shared', '无 ALS 上下文时回落共享库（定时任务/seed 零破坏）');
  tenantStorage.run(ctx('default'), () => {
    assert.equal(routing.dataSource().getRepository({} as any).name, 'shared');
  });
  tenantStorage.run(ctx('acme'), () => {
    assert.equal(routing.dataSource().getRepository({} as any).name, 'dedicated');
    assert.equal(routing.describe().dedicated, true);
  });
  assert.deepEqual(calls, [{ key: 'acme' }]);
});

test('dataSource(): 独立库未注册时抛错，绝不静默回落共享库（红线）', () => {
  const { routing } = fakeRouting({ registered: new Set() });
  tenantStorage.run(ctx('missing'), () => {
    assert.throws(
      () => routing.dataSource(),
      (e: any) => e?.status === 503 && /未注册/.test(e.message),
    );
  });
});

test('tenantRepositoryProxy: 方法调用时才解析底层 Repository，绑定 this 不丢', () => {
  const { routing } = fakeRouting({ registered: new Set(['acme']) });
  const entity = class Template {};
  const proxy = tenantRepositoryProxy<any>(routing, entity);
  assert.equal(proxy.findOne({ where: { id: 1 } }).name, 'shared');
  tenantStorage.run(ctx('acme'), () => {
    assert.equal(proxy.findOne({ where: { id: 1 } }).name, 'dedicated');
    assert.equal(proxy.save({ id: 2 }).saved, true);
  });
  assert.equal(proxy.findOne({}).name, 'shared', '离开上下文后再次回落，不会串味');
});

test('transaction(): 在目标 DataSource 上起事务并打 app.tenant_id GUC', async () => {
  const { routing, calls } = fakeRouting({ registered: new Set(['acme']) });
  const transactions: string[] = [];
  const ds: any = routing.dataSource;
  // 覆盖 dataSource() 用于记录事务归属（保留原有选库逻辑的语义）
  routing.dataSource = () => ({
    ...ds,
    transaction: async (fn: (em: any) => Promise<any>) => {
      transactions.push('called');
      return fn({ query: async () => undefined });
    },
  } as any);
  await tenantStorage.run(ctx('acme'), () => routing.transaction(async (em) => {
    assert.ok(em);
    return 'ok';
  }));
  assert.equal(transactions.length, 1);
  assert.ok(calls.some((c) => c.applyScope === 77), '事务内应打 tenant_id GUC');
});
