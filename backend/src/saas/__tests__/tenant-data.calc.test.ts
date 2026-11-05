// tenant-data.calc 单测（P6 导出/删除的纯函数部分，docs/10 §10.22.2）
// 只 import 纯函数：单测跑在 tsx + node:test，不加载 TypeORM 实体（§10.15.6 脚注）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS, EXPORT_ROW_CAP, PURGE_WARN_DAYS, RETENTION_DAYS,
  assertPurgeAllowed, backupName, deleteOrder, filterTables, retentionOf,
} from '../platform-admin/tenant-data.calc';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

test('retentionOf: 退订后 90 天才能硬删，期间给出剩余天数', () => {
  const r = retentionOf(daysAgo(10), NOW);
  assert.equal(r.hardDeleteAt?.toISOString(), new Date(daysAgo(10).getTime() + RETENTION_DAYS * DAY_MS).toISOString());
  assert.equal(r.daysLeft, 80);
  assert.equal(r.due, false);
  assert.equal(r.warn, false);
});

test('retentionOf: 7 天提醒窗口（D12 合同条款）与到期边界', () => {
  assert.equal(retentionOf(daysAgo(RETENTION_DAYS - PURGE_WARN_DAYS), NOW).warn, true);   // 正好第 7 天
  assert.equal(retentionOf(daysAgo(RETENTION_DAYS - PURGE_WARN_DAYS - 1), NOW).warn, false);
  assert.equal(retentionOf(daysAgo(RETENTION_DAYS), NOW).daysLeft, 0);
  assert.equal(retentionOf(daysAgo(RETENTION_DAYS), NOW).due, true);       // 到期即可删
  assert.equal(retentionOf(daysAgo(RETENTION_DAYS + 5), NOW).daysLeft, -5); // 过期若干天仍是 due
  assert.equal(retentionOf(daysAgo(RETENTION_DAYS + 5), NOW).due, true);
});

test('retentionOf: 未退订 / 脏值一律视为不可删，不抛异常', () => {
  for (const v of [null, undefined, '', 'not-a-date']) {
    const r = retentionOf(v as any, NOW);
    assert.equal(r.hardDeleteAt, null);
    assert.equal(r.daysLeft, null);
    assert.equal(r.due, false, `脏值 ${JSON.stringify(v)} 不应判成到期`);
  }
});

test('assertPurgeAllowed: 确认串必须先过，且逐字等于租户 code（去首尾空格）', () => {
  const base = { code: 'p6aa', canceledAt: daysAgo(120), now: NOW };
  assert.deepEqual(assertPurgeAllowed({ ...base, confirm: 'p6aa' }), { ok: true });
  assert.deepEqual(assertPurgeAllowed({ ...base, confirm: ' p6aa ' }), { ok: true });
  const bad = assertPurgeAllowed({ ...base, confirm: 'p6ab' });
  assert.equal(bad.ok, false);
  assert.match((bad as any).reason, /p6aa/);
  assert.equal(assertPurgeAllowed({ ...base }).ok, false);            // 没填 confirm
  const noCode = assertPurgeAllowed({ code: '', canceledAt: null, confirm: '' });
  assert.equal(noCode.ok, false);
  assert.match((noCode as any).reason, /租户不存在/);
});

test('assertPurgeAllowed: 保留期内拒绝，force 才放行；未退订同样要 force', () => {
  const inWindow = assertPurgeAllowed({ code: 'p6aa', canceledAt: daysAgo(30), confirm: 'p6aa', now: NOW });
  assert.equal(inWindow.ok, false);
  assert.match((inWindow as any).reason, /60 天保留期/);
  assert.deepEqual(assertPurgeAllowed({ code: 'p6aa', canceledAt: daysAgo(30), confirm: 'p6aa', force: true, now: NOW }), { ok: true });

  const never = assertPurgeAllowed({ code: 'p6aa', canceledAt: null, confirm: 'p6aa', now: NOW });
  assert.equal(never.ok, false);
  assert.match((never as any).reason, /尚未退订/);
  assert.deepEqual(assertPurgeAllowed({ code: 'p6aa', canceledAt: null, confirm: 'p6aa', force: true, now: NOW }), { ok: true });
  // force 也不能跳过确认串
  assert.equal(assertPurgeAllowed({ code: 'p6aa', canceledAt: null, confirm: 'x', force: true, now: NOW }).ok, false);
});

test('deleteOrder: 先删子表再删父表，顺序确定', () => {
  const tables = ['boms', 'bom_items', 'templates', 'materials'];
  const edges = [
    { child: 'bom_items', parent: 'boms' },
    { child: 'bom_items', parent: 'materials' },
  ];
  const { ordered, cyclic } = deleteOrder(tables, edges);
  assert.deepEqual(cyclic, []);
  assert.ok(ordered.indexOf('bom_items') < ordered.indexOf('boms'), `bom_items 必须早于 boms：${ordered}`);
  assert.ok(ordered.indexOf('bom_items') < ordered.indexOf('materials'), `bom_items 必须早于 materials：${ordered}`);
  // 同一批输入两次结果一致（验收脚本要能比对明细）
  assert.deepEqual(deleteOrder(tables, edges).ordered, ordered);
  assert.deepEqual(deleteOrder([...tables].reverse(), edges).ordered.length, ordered.length);
});

test('deleteOrder: 外键环不假装解决，单独列出来', () => {
  const { ordered, cyclic } = deleteOrder(['a', 'b'], [
    { child: 'a', parent: 'b' }, { child: 'b', parent: 'a' },
  ]);
  assert.deepEqual(cyclic.sort(), ['a', 'b']);
  assert.equal(ordered.length, 2);          // 仍然给出一个可执行顺序（按原序追加）
  assert.deepEqual(ordered, ['a', 'b']);
});

test('deleteOrder: 范围外的外键边与自引用忽略', () => {
  const { ordered, cyclic } = deleteOrder(['users'], [
    { child: 'users', parent: 'tenants' },   // tenants 不在删除范围
    { child: 'users', parent: 'users' },     // 自引用不算依赖
    { child: 'x', parent: 'y' },             // 两头都不在范围
  ]);
  assert.deepEqual(ordered, ['users']);
  assert.deepEqual(cyclic, []);
});

test('filterTables / backupName / 常量口径', () => {
  assert.deepEqual(filterTables(['tenant_backups', 'users', 'templates'], ['tenant_backups']), ['users', 'templates']);
  assert.deepEqual(filterTables(['tenants', 'modules'], ['tenants', 'modules']), []);
  assert.equal(backupName('p6aa', 'export', NOW), 'p6aa-export-2026-11-05');
  assert.equal(backupName('p6aa', 'purge-pre', NOW), 'p6aa-purge-pre-2026-11-05');
  assert.equal(RETENTION_DAYS, 90);           // D12
  assert.equal(EXPORT_ROW_CAP, 50_000);       // 单表封顶，超出标 truncated 而不是 OOM
});
