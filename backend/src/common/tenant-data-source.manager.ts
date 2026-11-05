// 连接池统一入口（docs/11 §11.15.1 硬性约束 1 + D3 + D2 / docs/10 §10.22）
// 约定：新增业务代码取连接一律走 get(ctx)，不要直接 @InjectRepository 之外的方式拿 DataSource，
// 否则接独立库（D2 type='dedicated'）时要全量返工。
//
// P6 起这里提供两个能力：
//   1) applyTenantScope()：在**当前事务**里打上 app.tenant_id（set_config is_local=true，提交即失效，
//      不会污染连接池里其它请求）。owner 角色连库时它只是「预留钩子」，不影响任何结果；
//   2) withTenantScope()：在**独立的 RLS 角色连接**（默认 labelflow_app，非 owner、无 BYPASSRLS）上
//      起一个事务并打上 GUC —— 只有这条路跑的 SQL 才真正被 saas_p6_rls.sql 的策略兜底。
//      没配 RLS 角色时明确降级（回主库事务 + GUC，并置 rlsActive=false），不假装已隔离。
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { TenantCtx } from './tenant.context';

/** 能执行带参 SQL 的对象即可（QueryRunner 和 EntityManager 都有 query()） */
export type SqlRunner = Pick<QueryRunner, 'query'> | EntityManager;

/** withTenantScope 的回调入参：EntityManager（事务内，GUC 已生效）+ 本次是否真的走在 RLS 角色上 */
export interface TenantScopeRun {
  em: EntityManager;
  /** true = 跑在 labelflow_app 这类受 RLS 约束的连接上；false = 降级到主库连接（只有应用层隔离） */
  rlsActive: boolean;
}

@Injectable()
export class TenantDataSourceManager {
  private readonly logger = new Logger(TenantDataSourceManager.name);

  /** RLS 角色连接（懒建，全进程一个池） */
  private rlsDs: DataSource | null = null;
  private rlsInit: Promise<DataSource | null> | null = null;
  private rlsWarned = false;

  /** 独立库（D2）注册表：dataSourceKey → DataSource；由 registerDedicated() 填充 */
  private readonly dedicated = new Map<string, DataSource>();

  constructor(private readonly dataSource: DataSource) {}

  /**
   * 按上下文取 DataSource。
   * 空或 'default' → 共享库；其它值 → 已注册的独立库（D2，见 registerDedicated）。
   * 没注册就明确报错，不回退共享库 —— 否则会出现「以为隔离了其实没隔离」的数据事故。
   */
  get(ctx: Pick<TenantCtx, 'dataSourceKey'>): DataSource {
    const key = ctx?.dataSourceKey;
    if (!key || key === 'default') return this.dataSource;
    const ds = this.dedicated.get(key);
    if (ds?.isInitialized) return ds;
    throw new ServiceUnavailableException(
      `独立数据源 "${key}" 未注册或连接失败（tenants.type=dedicated 的租户需先配 DB_DEDICATED_DSN 或调 registerDedicated）`,
    );
  }

  /** 当前进程注册了哪些独立库（平台后台健康检查用） */
  dedicatedKeys(): string[] { return [...this.dedicated.keys()]; }

  /**
   * 注册一个独立库 DataSource（D2）。key 与 tenants.data_source_key 一致。
   * 已存在同名 key 时先销毁旧的，避免连接泄漏。
   */
  async registerDedicated(key: string, options: ConstructorParameters<typeof DataSource>[0]): Promise<DataSource> {
    if (!key || key === 'default') throw new Error('dataSourceKey 不能是空或 default');
    const old = this.dedicated.get(key);
    if (old?.isInitialized) await old.destroy().catch(() => {});
    const ds = new DataSource({ ...options, synchronize: false });
    await ds.initialize();
    this.dedicated.set(key, ds);
    this.logger.log(`独立数据源已注册：${key}`);
    return ds;
  }

  /** 注销并断开独立库（租户退订/删除时用） */
  async unregisterDedicated(key: string): Promise<void> {
    const ds = this.dedicated.get(key);
    if (!ds) return;
    this.dedicated.delete(key);
    if (ds.isInitialized) await ds.destroy().catch(() => {});
  }

  /**
   * 在当前事务里打上租户标记，供 RLS 策略 / session 变量使用。
   * set_config(..., true) = 事务级，提交或回滚后自动失效，不会污染连接池里其他请求。
   */
  async applyTenantScope(runner: SqlRunner, tenantId: number): Promise<void> {
    if (!tenantId) return;
    await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [String(tenantId)]);
  }

  /** RLS 角色是否可用（配了 DB_RLS_USER 且能连上）；不可用时 withTenantScope 会明确降级 */
  get rlsEnabled(): boolean { return !!process.env.DB_RLS_USER; }

  /**
   * 在带 RLS 兜底的连接上跑一段逻辑。
   * @param tenantId 事务级 app.tenant_id；0/空 → 直接拒绝（否则策略下什么都查不到，静默空结果更难查）
   */
  async withTenantScope<T>(
    tenantId: number,
    fn: (run: TenantScopeRun) => Promise<T>,
  ): Promise<{ result: T; rlsActive: boolean }> {
    if (!tenantId) throw new Error('withTenantScope 需要非 0 的 tenantId（RLS 下无租户标记等于查不到数据）');
    const rls = await this.getRlsDataSource();
    const ds = rls ?? this.dataSource;
    if (!rls && !this.rlsWarned) {
      this.rlsWarned = true;
      this.logger.warn('未配置 DB_RLS_USER：withTenantScope 降级为主库连接（只有应用层 where 隔离，RLS 不生效）');
    }
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.applyTenantScope(qr, tenantId);
      const result = await fn({ em: qr.manager, rlsActive: !!rls });
      await qr.commitTransaction();
      return { result, rlsActive: !!rls };
    } catch (e) {
      await qr.rollbackTransaction().catch(() => {});
      throw e;
    } finally {
      await qr.release().catch(() => {});
    }
  }

  /** 懒建 RLS 角色连接池；连不上就返回 null（让调用方降级 + 告警），不把整个请求打挂 */
  private async getRlsDataSource(): Promise<DataSource | null> {
    if (!this.rlsEnabled) return null;
    if (this.rlsDs?.isInitialized) return this.rlsDs;
    if (!this.rlsInit) {
      this.rlsInit = (async () => {
        const ds = new DataSource({
          type: 'postgres',
          host: process.env.DB_HOST || 'localhost',
          port: +(process.env.DB_PORT || 5432),
          username: process.env.DB_RLS_USER as string,
          password: process.env.DB_RLS_PASSWORD || process.env.DB_RLS_USER || '',
          database: process.env.DB_NAME || 'labelflow',
          entities: [],                 // 只跑带参原生 SQL，不重复挂实体元数据
          synchronize: false,
          migrationsRun: false,
          logging: false,
          connectTimeoutMS: 5000,
          extra: { max: +(process.env.DB_RLS_POOL || 5), idleTimeoutMillis: 30_000 },
        });
        try {
          await ds.initialize();
          this.rlsDs = ds;
          this.logger.log(`RLS 角色连接已建立：${process.env.DB_RLS_USER}`);
          return ds;
        } catch (e: any) {
          this.rlsInit = null;
          this.logger.error(`RLS 角色连接失败（${e?.message ?? e}），withTenantScope 将降级为主库连接`);
          return null;
        }
      })();
    }
    return this.rlsInit;
  }

  /** 进程退出时释放自建连接池（main.ts enableShutdownHooks 会调 onApplicationShutdown） */
  async onApplicationShutdown(): Promise<void> {
    for (const ds of this.dedicated.values()) { if (ds.isInitialized) await ds.destroy().catch(() => {}); }
    this.dedicated.clear();
    if (this.rlsDs?.isInitialized) await this.rlsDs.destroy().catch(() => {});
    this.rlsDs = null;
    this.rlsInit = null;
  }
}
