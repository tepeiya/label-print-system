// dedicated.calc 单测（P6.2 D2 的纯函数部分）
// 只 import 纯函数：单测跑 tsx + node:test，不加载 TypeORM（docs/10 §10.15.6）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_RE, REQUIRED_TABLES, dsnTarget, isPostgresUrl, maskDsn, parseDedicatedDsns, schemaVerdict, validateKey,
} from '../platform-admin/dedicated.calc';

test('validateKey: 小写字母开头、a-z0-9-、2~64；default 保留给共享库', () => {
  for (const k of ['acme', 'a1', 'acme-corp', 'x'.repeat(64)]) {
    assert.deepEqual(validateKey(k), { ok: true }, k);
  }
  assert.equal(validateKey('').ok, false);
  assert.equal(validateKey('default').ok, false);
  assert.match(validateKey('default').reason!, /default/);
  for (const k of ['A', 'Acme', '1acme', 'a', 'ac_me', 'acme corp', 'x'.repeat(65), 'acme.']) {
    assert.equal(validateKey(k).ok, false, `应拒绝 ${k}`);
  }
  assert.equal(KEY_RE.test('acme-1'), true);
  assert.ok(REQUIRED_TABLES.includes('tenants'));
});

test('isPostgresUrl: 只认 postgres(ql)://，其它协议一律拒', () => {
  assert.equal(isPostgresUrl('postgres://u:p@h:5432/db'), true);
  assert.equal(isPostgresUrl('postgresql://u:p@h/db'), true);
  assert.equal(isPostgresUrl('POSTGRES://u:p@h/db'), true);
  for (const u of ['', 'mysql://h/db', 'file:/tmp/x', 'h:5432/db', 'postgres://', ' postgres://h/db x']) {
    assert.equal(isPostgresUrl(u), false, `应拒绝 ${JSON.stringify(u)}`);
  }
});

test('dsnTarget: 拆 host/port/database/user，默认端口 5432', () => {
  assert.deepEqual(dsnTarget('postgres://acme:pw@db.example.com:6543/acme_prod?sslmode=require'), {
    host: 'db.example.com', port: 6543, database: 'acme_prod', user: 'acme',
  });
  assert.deepEqual(dsnTarget('postgresql://u@localhost/acme'), {
    host: 'localhost', port: 5432, database: 'acme', user: 'u',
  });
  assert.equal(dsnTarget('postgres://h:5432'), null);        // 没库名
  assert.equal(dsnTarget('mysql://h/db'), null);
});

test('maskDsn: 密码绝不出现在返回值里', () => {
  const masked = maskDsn('postgres://acme:s3cr3t-P@ss@db.example.com:6543/acme');
  assert.equal(masked, 'postgres://acme:***@db.example.com:6543/acme');
  assert.ok(!masked.includes('s3cr3t'));
  assert.equal(maskDsn('not-a-url'), '(invalid-dsn)');
  assert.equal(maskDsn('postgres://h/db'), 'postgres://user:***@h:5432/db');
});

test('parseDedicatedDsns: 合法条目进 map，坏条目单独报错不连坐', () => {
  const { map, errors } = parseDedicatedDsns(JSON.stringify({
    acme: 'postgres://u:p@h1:5432/acme',
    'bad_key': 'postgres://u:p@h2:5432/x',
    other: 'mysql://h3/db',
    beta: 'postgres://u:p@h4/acme2',
  }));
  assert.deepEqual(Object.keys(map).sort(), ['acme', 'beta']);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.startsWith('bad_key')));
  assert.ok(errors.some((e) => e.startsWith('other')));
});

test('parseDedicatedDsns: 空值/坏 JSON/数组都返回空 map，不抛', () => {
  for (const raw of [undefined, null, '', '   ']) {
    assert.deepEqual(parseDedicatedDsns(raw as any), { map: {}, errors: [] });
  }
  assert.match(parseDedicatedDsns('{oops').errors[0], /不是合法 JSON/);
  assert.match(parseDedicatedDsns('["postgres://h/db"]').errors[0], /必须是对象/);
});

test('schemaVerdict: 缺表优先报缺表，表太少也判不合格', () => {
  const missing = schemaVerdict(['tenant_backups'], 40);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /tenant_backups/);
  const thin = schemaVerdict([], 3);
  assert.equal(thin.ok, false);
  assert.match(thin.message, /只有 3 张表/);
  const good = schemaVerdict([], REQUIRED_TABLES.length);
  assert.equal(good.ok, true);
  assert.match(good.message, new RegExp(`${REQUIRED_TABLES.length} 张表`));
});
