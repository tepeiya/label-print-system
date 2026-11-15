// P8.4 SQL 方言层单测（纯函数，不需要真实数据库）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVER_PROFILES, MAX_REFRESH_SEC, MIN_REFRESH_SEC, buildLookupWhere,
  convertPlaceholders, detectDriver, isCronLike, matchLookup, namedParams,
  paginateSql, placeholder, quoteIdentifier, refreshPlan, wrapLimit,
} from '../sql-driver.calc';

// ------------------------------ 驱动判定 ------------------------------
test('detectDriver：三种前缀 + 显式优先 + 未知拒绝', () => {
  assert.equal(detectDriver('postgresql://u:p@h/db').driver, 'postgres');
  assert.equal(detectDriver('postgres://h/db').driver, 'postgres');
  assert.equal(detectDriver('mysql://h/db').driver, 'mysql');
  assert.equal(detectDriver('mariadb://h/db').driver, 'mysql');
  assert.equal(detectDriver('mssql://h/db').driver, 'mssql');
  assert.equal(detectDriver('sqlserver://h/db').driver, 'mssql');
  assert.equal(detectDriver('whatever', 'mysql').driver, 'mysql', '显式 driver 优先');
  assert.equal(detectDriver('mysql://h/db', 'mssql').driver, 'mssql');
  assert.equal(detectDriver('oracle://h/db').ok, false);
  assert.equal(detectDriver('whatever', 'oracle').ok, false);
  assert.match(detectDriver('whatever', 'oracle').reason, /仅支持/);
});

test('驱动档案自洽', () => {
  for (const d of Object.values(DRIVER_PROFILES)) {
    assert.ok(d.identifierQuote.length === 2);
    assert.ok(['limit-offset', 'offset-fetch'].includes(d.limitStyle));
  }
  assert.equal(DRIVER_PROFILES.mssql.allowShowValues, false);
});

// ------------------------------ 占位符 ------------------------------
test('convertPlaceholders：$1 → ? / @p1，PG 恒等', () => {
  const sql = 'SELECT * FROM t WHERE a = $1 AND b = $2';
  assert.equal(convertPlaceholders(sql, 'postgres'), sql);
  assert.equal(convertPlaceholders(sql, 'mysql'), 'SELECT * FROM t WHERE a = ? AND b = ?');
  assert.equal(convertPlaceholders(sql, 'mssql'), 'SELECT * FROM t WHERE a = @p1 AND b = @p2');
});

test('convertPlaceholders：跳过字符串字面量里的 $1、处理双引号转义', () => {
  const sql = `SELECT '$1' AS note, "a$2" AS x FROM t WHERE v = $3`;
  const out = convertPlaceholders(sql, 'mysql');
  assert.match(out, /'\$1'/, '单引号字面量不该被替换');
  assert.match(out, /"a\$2"/, '双引号里的 $2 不该被替换');
  assert.match(out, /v = \?/, '真正的参数要替换');
  const tricky = `SELECT 'it''s $9' FROM t WHERE a = $1`;
  assert.match(convertPlaceholders(tricky, 'mssql'), /'it''s \$9'/);
  assert.match(convertPlaceholders(tricky, 'mssql'), /@p1/);
});

test('placeholder / namedParams：索引从 1 开始，顺序稳定', () => {
  assert.equal(placeholder(1, 'postgres'), '$1');
  assert.equal(placeholder(3, 'mysql'), '?');
  assert.equal(placeholder(2, 'mssql'), '@p2');
  assert.deepEqual(namedParams(['a', 7, true]), { p1: 'a', p2: 7, p3: true });
  assert.deepEqual(namedParams([]), {});
});

// ------------------------------ 标识符与分页 ------------------------------
test('quoteIdentifier：三种引用 + 注入防护', () => {
  assert.equal(quoteIdentifier('sku', 'postgres'), '"sku"');
  assert.equal(quoteIdentifier('order', 'mysql'), '`order`');
  assert.equal(quoteIdentifier('select', 'mssql'), '[select]');
  assert.throws(() => quoteIdentifier('a; DROP TABLE t', 'postgres'), /非法字段名/);
  assert.throws(() => quoteIdentifier('a-b', 'mysql'), /非法字段名/);
  assert.throws(() => quoteIdentifier('1abc', 'mssql'), /非法字段名/);
});

test('wrapLimit：PG/MySQL LIMIT OFFSET 与 SQL Server OFFSET FETCH', () => {
  const pg = wrapLimit('SELECT * FROM t', 'postgres', 100, 20);
  assert.equal(pg, 'SELECT * FROM (SELECT * FROM t) AS _lf LIMIT 100 OFFSET 20');
  assert.equal(wrapLimit('SELECT 1;', 'mysql', 10), 'SELECT * FROM (SELECT 1) AS _lf LIMIT 10');
  const ms = wrapLimit('SELECT * FROM t', 'mssql', 50, 10);
  assert.match(ms, /OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY/);
  assert.match(ms, /ORDER BY \(SELECT NULL\)/, 'SQL Server 语法要求 ORDER BY');
});

test('wrapLimit：数量夹取（防负数/超界/NaN 注入到 SQL 文本）', () => {
  assert.match(wrapLimit('SELECT 1', 'postgres', -5), /LIMIT 1/);
  assert.match(wrapLimit('SELECT 1', 'postgres', 99999), /LIMIT 5000/);
  assert.match(wrapLimit('SELECT 1', 'postgres', Number.NaN), /LIMIT 1000/);
  assert.match(wrapLimit('SELECT 1', 'mysql', 5, -100), /LIMIT 5(?! OFFSET)/);
  assert.ok(!wrapLimit('SELECT 1', 'mssql', 5, -1).includes('OFFSET -1'));
});

test('paginateSql：一次完成占位符转换 + 分页 + 参数透传', () => {
  const p = paginateSql('SELECT * FROM t WHERE id = $1', 'mssql', { limit: 20, offset: 40, params: [7] });
  assert.match(p.sql, /@p1/);
  assert.match(p.sql, /OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY/);
  assert.deepEqual(p.params, [7]);
  assert.equal(p.limit, 20);
  assert.equal(p.offset, 40);
  const pg = paginateSql('SELECT * FROM t WHERE id = $1', 'postgres', { params: ['x'] });
  assert.match(pg.sql, /LIMIT 1000/);
  assert.ok(!pg.sql.includes('OFFSET'), 'offset=0 时不写 OFFSET');
});

// ------------------------------ 字段查找 ------------------------------
test('buildLookupWhere：列名引用 + 值参数化 + 索引偏移', () => {
  const w = buildLookupWhere({ sku: 'A1', qty: 3 }, 'mysql', 2);
  assert.equal(w.clause, ' WHERE `sku` = ? AND `qty` = ?');
  assert.deepEqual(w.params, ['A1', 3]);
  assert.equal(w.invalid.length, 0);
  const m = buildLookupWhere({ sku: 'A1' }, 'mssql', 1);
  assert.equal(m.clause, ' WHERE [sku] = @p1');
  const p = buildLookupWhere({ sku: 'A1' }, 'postgres', 1);
  assert.equal(p.clause, ' WHERE "sku" = $1');
});

test('buildLookupWhere：非法字段名/空值/对象值显式 invalid，不拼进 SQL', () => {
  const w = buildLookupWhere({ 'a;DROP': 'x', sku: null as any, obj: { a: 1 } as any, ok: 'Y' }, 'postgres');
  assert.equal(w.invalid.length, 3);
  assert.equal(w.clause, ' WHERE "ok" = $1');
  assert.deepEqual(w.params, ['Y']);
  assert.equal(buildLookupWhere({}, 'mysql').clause, '');
});

test('matchLookup：大小写不敏感、空条件忽略、多条件 AND', () => {
  const row = { sku: 'A1', qty: 3, name: ' widget ' };
  assert.equal(matchLookup(row, { sku: 'a1' }), true);
  assert.equal(matchLookup(row, { sku: 'a1', qty: '3' }), true);
  assert.equal(matchLookup(row, { sku: 'B2' }), false);
  assert.equal(matchLookup(row, { sku: '', qty: null as any }), true, '空条件全部忽略');
});

// ------------------------------ 自动刷新计划 ------------------------------
test('isCronLike：5/6 段合法，注入字符拒绝', () => {
  assert.equal(isCronLike('0 * * * *'), true);
  assert.equal(isCronLike('*/5 0 * * 1-5'), true);
  assert.equal(isCronLike('0 0 * * * *'), true);
  assert.equal(isCronLike('0 0 * * *; rm -rf'), false);
  assert.equal(isCronLike('* * *'), false);
});

test('refreshPlan：关闭 / 默认每小时 / 间隔夹取 / cron 优先', () => {
  const off = refreshPlan({ enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.repeat, null);
  const on = refreshPlan({ enabled: true, intervalSec: 30 });
  assert.equal(on.intervalSec, MIN_REFRESH_SEC, '低于 60s 夹到下限');
  assert.deepEqual(on.repeat, { everyMs: MIN_REFRESH_SEC * 1000 });
  assert.match(on.warnings.join(' '), /低于下限/);
  const valid = refreshPlan({ enabled: true, intervalSec: 300 });
  assert.equal(valid.intervalSec, 300, '5 分钟是合法间隔，原样保留');
  assert.deepEqual(valid.repeat, { everyMs: 300 * 1000 });
  assert.equal(valid.warnings.length, 0);
  const huge = refreshPlan({ enabled: true, intervalSec: 1e9 });
  assert.equal(huge.intervalSec, MAX_REFRESH_SEC);
  const cron = refreshPlan({ enabled: true, cron: '0 2 * * *', intervalSec: 300 });
  assert.deepEqual(cron.repeat, { pattern: '0 2 * * *' }, 'cron 优先于 intervalSec');
  const badCron = refreshPlan({ enabled: true, cron: 'bad cron' });
  assert.equal(badCron.cron, null);
  assert.deepEqual(badCron.repeat, { everyMs: 3600 * 1000 });
  assert.match(badCron.warnings.join(' '), /默认每小时/);
  assert.equal(refreshPlan(null).replaceRows, true);
  assert.equal(refreshPlan({ replaceRows: false }).replaceRows, false);
});
