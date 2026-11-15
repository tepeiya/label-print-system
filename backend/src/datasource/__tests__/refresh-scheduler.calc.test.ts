// P8.4 数据源自动刷新调度判定层单测（纯函数，不需要 Redis / 真库）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BOOTSTRAP_SOURCES, REFRESH_JOB_PREFIX, bootstrapCandidates,
  parseRefreshJobName, reconcileRepeat, refreshJobData, refreshJobName,
  repeatFromBull, repeatKey, repeatOfPlan, toBullRepeat, validRefreshJobData,
} from '../refresh-scheduler.calc';
import { MIN_REFRESH_SEC, refreshPlan } from '../sql-driver.calc';

// ------------------------------ job name 与租户隔离 ------------------------------
test('refreshJobName：显式带 tenant_id + source_id，反解自洽', () => {
  const n = refreshJobName(12, 34);
  assert.equal(n, `${REFRESH_JOB_PREFIX}:12:34`);
  assert.deepEqual(parseRefreshJobName(n), { tenantId: 12, sourceId: 34 });
});

test('parseRefreshJobName：非法格式 / 非正整数 fail-closed', () => {
  assert.equal(parseRefreshJobName(''), null);
  assert.equal(parseRefreshJobName('unknown.job'), null);
  assert.equal(parseRefreshJobName('refresh_source:0:1'), null, 'tenant_id=0 非法');
  assert.equal(parseRefreshJobName('refresh_source:1:0'), null, 'source_id=0 非法');
  assert.equal(parseRefreshJobName('refresh_source:1.5:2'), null, '非整数拒绝');
  assert.equal(parseRefreshJobName('refresh_source:1:2:3'), null);
});

test('refreshJobData / validRefreshJobData：跨租户串号被拒', () => {
  const d = refreshJobData(7, 9, 'tenant_ds_7');
  assert.deepEqual(d, { tenantId: 7, sourceId: 9, dataSourceKey: 'tenant_ds_7' });
  assert.equal(validRefreshJobData(d), true);
  assert.equal(validRefreshJobData(null), false);
  assert.equal(validRefreshJobData({ tenantId: 0, sourceId: 1 }), false);
  assert.equal(validRefreshJobData({ tenantId: 1, sourceId: -3 }), false);
  assert.equal(validRefreshJobData({ tenantId: 1 }), false);
});

// ------------------------------ repeat 形状转换 ------------------------------
test('repeatKey / toBullRepeat / repeatFromBull：三种形状往返一致', () => {
  const specs = [
    { everyMs: MIN_REFRESH_SEC * 1000 },
    { pattern: '0 2 * * *' },
    null,
  ] as const;
  for (const s of specs) {
    const bull = toBullRepeat(s as any);
    if (!s) {
      assert.equal(bull, null);
      assert.equal(repeatKey(s as any), '');
      continue;
    }
    assert.deepEqual(repeatFromBull(bull as any), s, 'BullMQ 往返后形状不变');
    assert.ok(repeatKey(s as any).length > 0);
  }
  assert.equal(repeatKey({ everyMs: 60000 }), 'every:60000');
  assert.equal(repeatKey({ pattern: '0 2 * * *' }), 'pattern:0 2 * * *');
  assert.equal(repeatFromBull({}), null, '脏返回项不产生调度');
  assert.equal(repeatFromBull({ every: 0 }), null);
});

test('repeatOfPlan：唯一真源是 refreshPlan().repeat，未启用恒为 null', () => {
  assert.deepEqual(repeatOfPlan(refreshPlan({ enabled: true, intervalSec: 300 })), { everyMs: 300000 });
  assert.deepEqual(repeatOfPlan(refreshPlan({ enabled: true, cron: '*/5 * * * *' })), { pattern: '*/5 * * * *' });
  assert.equal(repeatOfPlan(refreshPlan({ enabled: false, intervalSec: 300 })), null, '关掉刷新不留调度');
  assert.equal(repeatOfPlan(refreshPlan(null)), null);
  // 非法 cron 被 refreshPlan 夹成默认每小时，调度参数与配置口径完全一致
  assert.deepEqual(repeatOfPlan(refreshPlan({ enabled: true, cron: 'nope' })), { everyMs: 3600000 });
});

// ------------------------------ 对齐判定（核心防重复注册） ------------------------------
test('reconcileRepeat：五种分支覆盖，参数相同绝不重复注册', () => {
  const a = { everyMs: 300000 };
  const b = { pattern: '*/5 * * * *' };
  assert.deepEqual(
    { a: reconcileRepeat(null, null).action, r: reconcileRepeat(null, null) },
    { a: 'none', r: { action: 'none', remove: false, add: false, reason: '刷新未启用，无需调度' } },
  );
  const add = reconcileRepeat(null, a);
  assert.equal(add.action, 'add');
  assert.equal(add.add, true);
  assert.equal(add.remove, false);

  const remove = reconcileRepeat(a, null);
  assert.equal(remove.action, 'remove');
  assert.equal(remove.remove, true);
  assert.equal(remove.add, false);

  const same = reconcileRepeat(a, { everyMs: 300000 });
  assert.equal(same.action, 'none', '重复保存配置 / 多实例 bootstrap 必须幂等');
  assert.equal(same.remove, false);
  assert.equal(same.add, false);

  const replace = reconcileRepeat(a, b);
  assert.equal(replace.action, 'replace');
  assert.equal(replace.remove, true);
  assert.equal(replace.add, true);
  assert.match(replace.reason, /先撤销旧 key/, '必须说明为什么要先删');
});

test('reconcileRepeat：cron 与 interval 互换、间隔变化都触发 replace', () => {
  assert.equal(reconcileRepeat({ everyMs: 60000 }, { everyMs: 300000 }).action, 'replace');
  assert.equal(reconcileRepeat({ pattern: '0 2 * * *' }, { pattern: '0 3 * * *' }).action, 'replace');
  assert.equal(reconcileRepeat({ everyMs: 60000 }, { pattern: '0 2 * * *' }).action, 'replace');
});

// ------------------------------ 启动期 bootstrap ------------------------------
test('bootstrapCandidates：只保留已启用且能生成 repeat 的源，脏行跳过', () => {
  const rows = [
    { tenantId: 1, sourceId: 10, refresh: { enabled: true, intervalSec: 300 } },
    { tenantId: 1, sourceId: 11, refresh: { enabled: false, intervalSec: 300 } },
    { tenantId: 2, sourceId: 20, refresh: { enabled: true, cron: '0 2 * * *' }, dataSourceKey: 'dedicated_2' },
    { tenantId: 0, sourceId: 30, refresh: { enabled: true, intervalSec: 300 } },   // 脏 tenant
    { tenantId: 3, sourceId: -1, refresh: { enabled: true, intervalSec: 300 } },   // 脏 source
    { tenantId: 4, sourceId: 40, refresh: 'garbage' },                              // 脏配置
  ];
  const got = bootstrapCandidates(rows as any);
  assert.equal(got.length, 2);
  assert.deepEqual(
    got.map((c) => [c.tenantId, c.sourceId, c.dataSourceKey]),
    [[1, 10, null], [2, 20, 'dedicated_2']],
  );
  assert.deepEqual(got[0].plan.repeat, { everyMs: 300000 });
  assert.deepEqual(got[1].plan.repeat, { pattern: '0 2 * * *' });
});

test('bootstrapCandidates：低间隔与非法 cron 走同一真源夹取，且遵守上限', () => {
  const one = bootstrapCandidates([{ tenantId: 1, sourceId: 1, refresh: { enabled: true, intervalSec: 10 } }] as any);
  assert.deepEqual(one[0].plan.repeat, { everyMs: MIN_REFRESH_SEC * 1000 });
  assert.match(one[0].plan.warnings.join(' '), /低于下限/);

  const many = Array.from({ length: 20 }, (_, i) => ({
    tenantId: 1, sourceId: i + 1, refresh: { enabled: true, intervalSec: 300 },
  }));
  assert.equal(bootstrapCandidates(many as any, 5).length, 5);
  assert.equal(bootstrapCandidates(many as any, 0).length, MAX_BOOTSTRAP_SOURCES >= 20 ? 20 : MAX_BOOTSTRAP_SOURCES,
    'limit 非正数回落到默认上限');
  assert.equal(bootstrapCandidates([]).length, 0);
  assert.equal(bootstrapCandidates(null as any).length, 0);
});
