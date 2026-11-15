// P6.2 阶段 B 单测：运维面配置 + 退库回收巡检（纯函数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POOL_DEFAULT, POOL_MAX, POOL_MIN, poolEnvName, dedicatedPoolOptions,
  healthVerdict, reclaimScan, canReclaimAfterPurge,
} from '../platform-admin/dedicated.ops.calc';

const env = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv;

test('poolEnvName: key 里的连字符转成下划线，全部大写', () => {
  assert.equal(poolEnvName('acme-prod'), 'DB_DEDICATED_POOL_ACME_PROD');
  assert.equal(poolEnvName('t1'), 'DB_DEDICATED_POOL_T1');
});

test('dedicatedPoolOptions: 默认 4，全局可覆盖，脏值回落，越界夹紧', () => {
  assert.equal(dedicatedPoolOptions('t1', env()).max, POOL_DEFAULT);
  assert.equal(dedicatedPoolOptions('t1', env({ DB_DEDICATED_POOL: '10' })).max, 10);
  assert.equal(dedicatedPoolOptions('t1', env({ DB_DEDICATED_POOL: 'abc' })).max, POOL_DEFAULT);
  assert.equal(dedicatedPoolOptions('t1', env({ DB_DEDICATED_POOL: '999' })).max, POOL_MAX);
  assert.equal(dedicatedPoolOptions('t1', env({ DB_DEDICATED_POOL: '0' })).max, POOL_DEFAULT, '0/负值视为误配，回退默认而不是把池锁死');
  assert.equal(dedicatedPoolOptions('t1', env({ DB_DEDICATED_POOL: '-3' })).max, POOL_DEFAULT);
  assert.equal(POOL_MIN, 1);
});

test('dedicatedPoolOptions: per-key 优先级高于 JSON 与全局', () => {
  const e = env({
    DB_DEDICATED_POOL: '6',
    DB_DEDICATED_POOLS: '{"acme-prod": 12}',
    [poolEnvName('acme-prod')]: '20',
  });
  assert.equal(dedicatedPoolOptions('acme-prod', e).max, 20);
  assert.equal(dedicatedPoolOptions('other', e).max, 6, '不影响别的 key');
  assert.equal(dedicatedPoolOptions('acme-prod', env({ DB_DEDICATED_POOLS: '{"acme-prod": 12}', DB_DEDICATED_POOL: '6' })).max, 12);
  assert.equal(dedicatedPoolOptions('acme-prod', env({ DB_DEDICATED_POOLS: 'not-json' })).max, POOL_DEFAULT,
    '坏 JSON 不拖垮注册');
});

test('dedicatedPoolOptions: SSL 默认关，开启后默认严格校验证书', () => {
  assert.equal(dedicatedPoolOptions('x', env()).ssl, undefined);
  assert.equal(dedicatedPoolOptions('x', env({ DB_DEDICATED_SSL: '1' })).ssl?.rejectUnauthorized, true);
  assert.equal(dedicatedPoolOptions('x', env({ DB_DEDICATED_SSL: 'true', DB_DEDICATED_SSL_REJECT: '0' })).ssl?.rejectUnauthorized, false);
  assert.equal(dedicatedPoolOptions('x', env({ DB_DEDICATED_SSL: '0' })).ssl, undefined);
});

test('dedicatedPoolOptions: 超时与空闲回收可配且有上下限', () => {
  const o = dedicatedPoolOptions('x', env({ DB_DEDICATED_IDLE_MS: '60000', DB_DEDICATED_CONNECT_MS: '3000' }));
  assert.equal(o.idleTimeoutMillis, 60000);
  assert.equal(o.connectTimeoutMS, 3000);
  assert.equal(dedicatedPoolOptions('x', env({ DB_DEDICATED_IDLE_MS: '1' })).idleTimeoutMillis, 1000);
  assert.equal(dedicatedPoolOptions('x', env({ DB_DEDICATED_CONNECT_MS: '999999' })).connectTimeoutMS, 30000);
});

test('healthVerdict: 连不通/缺表 unhealthy，慢或表少 degraded，其余 healthy', () => {
  assert.equal(healthVerdict({ reachable: false }).level, 'unhealthy');
  assert.equal(healthVerdict({ reachable: true, missing: ['templates'] }).level, 'unhealthy');
  assert.equal(healthVerdict({ reachable: true, latencyMs: 2000, tableCount: 40 }).level, 'degraded');
  assert.equal(healthVerdict({ reachable: true, latencyMs: 20, tableCount: 2 }).level, 'degraded');
  assert.equal(healthVerdict({ reachable: true, latencyMs: 20, tableCount: 40 }).level, 'healthy');
  assert.equal(healthVerdict({ reachable: true, latencyMs: 20, tableCount: 40 }).ok, true);
  assert.match(healthVerdict({ reachable: true, missing: ['users'] }).message, /users/);
});

test('reclaimScan: 找出「库还在但租户已删」与「租户引用但未注册」', () => {
  const scan = reclaimScan(
    [{ key: 'acme', source: 'api' }, { key: 'ghost', source: 'env' }, { key: 'shared-x', source: 'api' }],
    [
      { code: 'acme001', dataSourceKey: 'acme' },
      { code: 'zombie', dataSourceKey: 'lost-key' },   // 引用了未注册的 key
      { code: 'normal', dataSourceKey: 'default' },    // 共享库不算占用
    ],
  );
  assert.deepEqual(scan.orphanKeys.map((o) => o.key), ['ghost', 'shared-x']);
  assert.equal(scan.orphanKeys[0].source, 'env');
  assert.match(scan.orphanKeys[0].hint, /不会自动删库/);
  assert.deepEqual(scan.inUseKeys.map((i) => i.key), ['acme', 'lost-key']);
  assert.deepEqual(scan.unregisteredRefs.map((u) => u.key), ['lost-key']);
  assert.deepEqual(scan.unregisteredRefs[0].tenantCodes, ['zombie']);
});

test('reclaimScan: 空输入安全', () => {
  const s = reclaimScan([], []);
  assert.deepEqual(s, { orphanKeys: [], unregisteredRefs: [], inUseKeys: [] });
});

test('canReclaimAfterPurge: 只有再无其它活跃租户引用才允许回收', () => {
  const tenants = [
    { code: 'b', dataSourceKey: 'acme' },
    { code: 'c', dataSourceKey: 'default' },
  ];
  assert.equal(canReclaimAfterPurge('acme', tenants), false);
  assert.equal(canReclaimAfterPurge('acme', [{ code: 'c', dataSourceKey: 'default' }]), true);
  assert.equal(canReclaimAfterPurge('acme', []), true);
  assert.equal(canReclaimAfterPurge('default', []), false, '共享库永不回收');
  assert.equal(canReclaimAfterPurge('', []), false);
});
