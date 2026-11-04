// =============================================================================
// sql-executor.test.ts —— SQL 数据源只读强制 + 真实 PG 执行（§10.9 #5）
//   · 纯逻辑：assertReadOnly 覆盖 INSERT / 多语句 / SELECT 三类用例
//   · 集成：ping / execute 跑真实 PG。`DataSourceService.testSql/execSql` 只是
//     get + decrypt + ping/execute 的薄封装，而它所在的 datasource.module.ts 会连带 import
//     TypeORM 实体，tsx（esbuild）不产出装饰器元数据 → 无法在单测里直接实例化，
//     因此覆盖下沉到执行器层（同一套真实 PG 路径 + 同一套加解密）。
//     本地库不可用时自动 skip，不阻塞 CI；可用 TEST_PG_URL 覆盖连接串
// =============================================================================

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { assertReadOnly, execute, ping, releasePool } from '../sql-executor';
import { encrypt, decrypt } from '../sql-crypto';

const PG_URL = process.env.TEST_PG_URL || 'postgresql://labelflow@127.0.0.1:5433/labelflow';
const NO_PG = '本机 PG（默认 127.0.0.1:5433/labelflow）不可用，跳过集成用例';

let pgReachable: boolean | null = null;
async function needPg(t: any): Promise<boolean> {
  if (pgReachable === null) pgReachable = (await ping({ connection: PG_URL })).ok;
  if (!pgReachable) { t.skip(NO_PG); return false; }
  return true;
}

const thrown = (sql: string, skip = false): string | null => {
  try { assertReadOnly(sql, skip); return null; } catch (e: any) { return e.message as string; }
};

// ----------------------------- 1. assertReadOnly -----------------------------
test('只读白名单：SELECT / WITH / VALUES / SHOW / EXPLAIN 放行', () => {
  for (const sql of [
    'SELECT 1',
    'select * from t where id = $1',
    'WITH c AS (SELECT 1) SELECT * FROM c',
    "VALUES (1, 'a')",
    'SHOW server_version',
    'EXPLAIN SELECT 1',
    'SELECT 1;',              // 结尾单个分号是合法写法
    '  SELECT 1  ',
  ]) {
    assert.equal(thrown(sql), null, `应放行：${sql}`);
  }
});

test('写语句 / DDL / 会话语句一律拒绝', () => {
  const forbidden = [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'TRUNCATE t',
    'CREATE TABLE t (id int)',
    'DROP TABLE users',
    'ALTER TABLE t ADD COLUMN c int',
    'GRANT ALL ON t TO bob',
    'SET search_path = public',
    "COPY t TO '/tmp/x.csv'",
    'DO $$ BEGIN END $$',
    'VACUUM',                // 未知前缀同样拒绝
  ];
  for (const sql of forbidden) {
    assert.ok(thrown(sql), `应拒绝：${sql}`);
  }
});

test('多语句注入：一条尾分号两条语句必须拒绝（旧实现按分号计数会放过）', () => {
  const payloads = [
    'SELECT 1; DROP TABLE users',
    'SELECT 1;DROP TABLE users',
    'SELECT 1; DROP TABLE users;',
    'WITH x AS (SELECT 1) SELECT * FROM x; DELETE FROM users',
    '/* ok */ SELECT 1; TRUNCATE audit_log',
  ];
  for (const sql of payloads) {
    const msg = thrown(sql);
    assert.ok(msg, `应拒绝：${sql}`);
    assert.match(msg!, /多语句|禁止执行|未知语句/);
  }
  // 关键回归：分号只出现 1 次，老逻辑的 semiCount > 1 判断挡不住
  assert.match(thrown('SELECT 1; DROP TABLE users')!, /多语句/);
});

test('字符串字面量 / 引号标识符里的分号不算多语句', () => {
  assert.equal(thrown("SELECT 'a;b' AS s"), null);
  assert.equal(thrown('SELECT "x;y" FROM t'), null);
  assert.equal(thrown("SELECT 'it''s; fine' AS s"), null);
});

test('注释不能成为绕过通道', () => {
  assert.match(thrown('--SELECT 1\nDROP TABLE users')!, /禁止执行/);
  assert.match(thrown('/* SELECT 1 */ DROP TABLE users')!, /禁止执行/);
  assert.equal(thrown('SELECT 1 -- ; DROP TABLE users'), null);
});

test('空 SQL 拒绝；skip=true 时全部放行（内部受信源）', () => {
  assert.match(thrown('')!, /为空/);
  assert.match(thrown('   ;  ;  ')!, /为空/);
  assert.equal(thrown('DROP TABLE users', true), null);
});

// ----------------------------- 2. 加解密 -----------------------------
test('连接串 AES-GCM 往返，密文不含明文', () => {
  const enc = encrypt(PG_URL);
  assert.doesNotMatch(enc, /labelflow/);
  assert.equal(decrypt(enc), PG_URL);
});

// ----------------------------- 3. 真实 PG 集成 -----------------------------
test('ping：可用库返回 ok，错误端口返回 ok=false 且带错误信息', async (t) => {
  if (!(await needPg(t))) return;
  const good = await ping({ connection: PG_URL });
  assert.equal(good.ok, true);
  assert.ok(good.durationMs >= 0);

  const badUrl = 'postgresql://labelflow@127.0.0.1:5999/labelflow';
  const bad = await ping({ connection: badUrl });
  await releasePool(badUrl);
  assert.equal(bad.ok, false);
  assert.ok(bad.message && bad.message.length > 0);
});

test('execute：参数化查询返回 columns/rows/rowCount/command', async (t) => {
  if (!(await needPg(t))) return;
  const r = await execute({ connection: PG_URL }, 'SELECT $1::int AS n, $2::text AS t', [7, 'x'], 10);
  assert.deepEqual(r.columns, ['n', 't']);
  assert.equal(r.rowCount, 1);
  assert.equal(Number(r.rows[0].n), 7);
  assert.equal(r.rows[0].t, 'x');
  assert.equal(r.command?.toLowerCase(), 'select');
  assert.equal(r.warnings?.length, 0);
});

test('execute：无 LIMIT 时自动包一层子查询强制截断并给 warning', async (t) => {
  if (!(await needPg(t))) return;
  const r = await execute({ connection: PG_URL }, 'SELECT generate_series(1, 50) AS i', [], 10);
  assert.equal(r.rowCount, 10);
  assert.equal(r.rows.length, 10);
  assert.ok(r.warnings?.some((w) => w.includes('截断')));
});

test('execute：limit 上限钳到 5000，非法值回落 1000', async (t) => {
  if (!(await needPg(t))) return;
  const big = await execute({ connection: PG_URL }, 'SELECT 1 AS a', [], 999_999);
  assert.equal(big.rowCount, 1);                       // 只有 1 行，但 SQL 里 LIMIT 应为 5000
  const r = await execute({ connection: PG_URL }, 'SELECT generate_series(1, 2000) AS i', [], NaN as any);
  assert.equal(r.rowCount, 1000);
});

test('execute：写语句在执行前就被拦下，数据库不受影响', async (t) => {
  if (!(await needPg(t))) return;
  await assert.rejects(
    () => execute({ connection: PG_URL }, 'SELECT 1; DROP TABLE lf_p0_should_not_exist'),
    /多语句/,
  );
  const exists = await execute(
    { connection: PG_URL },
    "SELECT to_regclass('public.lf_p0_should_not_exist') IS NOT NULL AS exists",
  );
  assert.equal(exists.rows[0].exists, false);
});

test('execute：SQL 语法错误透出 pg 错误码', async (t) => {
  if (!(await needPg(t))) return;
  await assert.rejects(() => execute({ connection: PG_URL }, 'SELECT FROM WHERE'), /\[42\d{3}\]/);
});

test('第二道防线：即使绕过 assertReadOnly，pg 扩展协议也拒收多语句', async (t) => {
  if (!(await needPg(t))) return;
  // skipReadOnlyCheck 只用于受信内部源，这里验证驱动层本身也不会执行第二条语句
  await assert.rejects(
    () => execute({ connection: PG_URL, skipReadOnlyCheck: true }, 'SELECT 1; SELECT 2', [], 5),
    /\[42601\]/,
  );
});

after(async () => {
  if (pgReachable !== null) await releasePool(PG_URL).catch(() => {});
});
