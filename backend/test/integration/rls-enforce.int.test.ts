/**
 * D2 真库验收：RLS 在 **labelflow_app 角色连接** 上是否真的兜底（不是 owner/超管绕过）。
 *
 * 三个断言：
 *   R1 不带租户 GUC → 业务表 0 行（策略默认拒绝，不是"忘了开 RLS 却以为安全"）
 *   R2 set_config('app.tenant_id') 后 → 只见本租户行，且另一租户的行确实存在（对照，防止"表是空的所以全绿"）
 *   R3 平台表（tenants）不隔离：登录按 code 查租户必须可见（否则登录都过不了）
 *
 * 只跑原生 SQL，不建夹具：用库里已有的 wms_* 表 + 现造两行不同租户的 stock_batches 再回滚。
 */
import { DataSource } from 'typeorm';

const HOST = process.env.DB_HOST || '127.0.0.1';
const PORT = +(process.env.DB_PORT || 5432);
const DB = process.env.DB_NAME || 'labelflow_test';
const APP_USER = process.env.DB_RLS_USER || 'labelflow_app';
const APP_PASS = process.env.DB_RLS_PASSWORD || 'labelflow_app';

const T1 = 903;
const T2 = 904;

describe('D2 RLS 真库验收（labelflow_app 角色）', () => {
  let appDs: DataSource;

  beforeAll(async () => {
    appDs = new DataSource({
      type: 'postgres',
      host: HOST, port: PORT, username: APP_USER, password: APP_PASS, database: DB,
      entities: [], synchronize: false, logging: false, extra: { max: 3 },
    });
    await appDs.initialize();
  });

  afterAll(async () => {
    if (appDs?.isInitialized) await appDs.destroy();
  });

  it('R1 无租户 GUC：业务表看不见任何行（策略默认拒绝）', async () => {
    for (const table of ['stock_batches', 'stock_moves', 'wms_work_orders', 'udi_units', 'audit_logs']) {
      const rows = await appDs.query(`select count(*)::int as n from ${table}`);
      expect(Number(rows[0].n)).toBe(0);
    }
  });

  it('R2 带 GUC：只见本租户行，另一租户行确实存在（对照）', async () => {
    // 造数据：两个租户各一行（用事务，测完回滚，不留脏数据）
    const qr = appDs.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // 插入也受 WITH CHECK 约束：必须先打上目标租户 GUC，否则策略直接拒（见 R2b）
      // 用 audit_logs（无外键，最干净的 RLS 探针表）
      for (const t of [T1, T2]) {
        await qr.query(`select set_config('app.tenant_id', $1, true)`, [String(t)]);
        await qr.query(
          `insert into audit_logs (tenant_id, action, detail) values ($1, 'rls_probe', $2::jsonb)`,
          [t, JSON.stringify({ probe: `RLS-${t}` })],
        );
      }
      // R2b：GUC=T1 时插 T2 的行必须被 WITH CHECK 拒绝（不是只在读时过滤）
      await qr.query(`select set_config('app.tenant_id', $1, true)`, [String(T1)]);
      // 越权插入会把事务置为 aborted，必须用 savepoint 包住才能继续后续断言
      await qr.query('savepoint sp_cross');
      await expect(
        qr.query(`insert into audit_logs (tenant_id, action, detail)
                 values ($1, 'rls_probe', '{"probe":"RLS-CROSS"}'::jsonb)`, [T2]),
      ).rejects.toThrow(/row-level security/i);
      await qr.query('rollback to savepoint sp_cross');

      // 打 GUC 后读：只应有 T1 的 1 行
      await qr.query(`select set_config('app.tenant_id', $1, true)`, [String(T1)]);
      const mine = await qr.query(`select tenant_id, detail->>'probe' as probe from audit_logs where action='rls_probe'`);
      expect(mine.length).toBe(1);
      expect(mine[0].probe).toBe(`RLS-${T1}`);

      // 切成 T2 再读：只应有 T2 的行（证明不是"恰好只写进了一行"）
      await qr.query(`select set_config('app.tenant_id', $1, true)`, [String(T2)]);
      const other = await qr.query(`select detail->>'probe' as probe from audit_logs where action='rls_probe'`);
      expect(other.length).toBe(1);
      expect(other[0].probe).toBe(`RLS-${T2}`);

      // 同一事务里不带 GUC（清空）：应当 0 行
      await qr.query(`select set_config('app.tenant_id', '', true)`);
      const none = await qr.query(`select id from audit_logs where action='rls_probe'`);
      expect(none.length).toBe(0);
    } finally {
      await qr.rollbackTransaction().catch(() => {});
      await qr.release().catch(() => {});
    }
  });

  it('R3 平台表不隔离：tenants 对 app 角色可读（登录链路依赖）', async () => {
    const rows = await appDs.query(`select count(*)::int as n from tenants`);
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });
});
