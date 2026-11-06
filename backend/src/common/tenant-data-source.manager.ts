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
import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { TenantCtx } from './tenant.context';
import {
  REQUIRED_TABLES, dsnTarget, isPostgresUrl, parseDedicatedDsns, schemaVerdict, validateKey,
} from '../saas/platform-admin/dedicated.calc';

/** 能执行带参 SQL 的对象即可（QueryRunner 和 EntityManager 都有 query()） */
export type SqlRunner = Pick<QueryRunner, 'query'> | EntityManager;

/** withTenantScope 的回调入参：EntityManager（事务内，GUC 已生效）+ 本次是否真的走在 RLS 角色上 */
export interface TenantScopeRun {
  em: EntityManager;
  /** true = 跑在 labelflow_app 这类受 RLS 约束的连接上；false = 降级到主库连接（只有应用层隔离） */
  rlsActive: boolean;
  /** 隔离来源：rls（RLS 角色）/ dedicated（钉在独立库）/ app-only（都没配，降级） */
  mode: 'rls' | 'dedicated' | 'app-only';
}

/** 独立库登记信息（诊断面板用；**不含 DSN**，密码不出进程内存） */
export interface DedicatedInfo {
  key: string;
  host: string;
  port: number;
  database: string;
  user: string;
  registeredAt: string;
  source: 'env' | 'api';
}

@Injectable()
export class TenantDataSourceManager implements OnModuleInit {
  private readonly logger = new Logger(TenantDataSourceManager.name);

  /** RLS 角色连接（懒建，全进程一个池） */
  private rlsDs: DataSource | null = null;
  private rlsInit: Promise<DataSource | null> | null = null;
  private rlsWarned = false;

  /** 独立库（D2）注册表：dataSourceKey → DataSource；由 registerFromUrl() 填充 */
  private readonly dedicated = new Map<string, DataSource>();
  /** key → 脱敏后的目标信息（不含密码） */
  private readonly dedicatedMeta = new Map<string, DedicatedInfo>();
  /** env 里配错的条目（启动告警 + 诊断面板可见），不阻断进程启动 */
  private readonly envErrors: string[] = [];

  constructor(private readonly dataSource: DataSource) {}

  /**
   * 启动时按 env 注册独立库：`DB_DEDICATED_DSNS={"acme":"postgres://user:pw@host:5432/acme"}`。
   * 单条失败只记日志（对应租户的请求会拿到 503，不会静默读共享库），不影响其它 key 与整体启动。
   */
  async onModuleInit(): Promise<void> {
    const { map, errors } = parseDedicatedDsns(process.env.DB_DEDICATED_DSNS);
    if (errors.length) {
      this.envErrors.push(...errors);
      this.logger.error(`DB_DEDICATED_DSNS 有 ${errors.length} 条无法使用：${errors.join('；')}`);
    }
    for (const [key, url] of Object.entries(map)) {
      try {
        await this.registerFromUrl(key, url, 'env');
      } catch (e: any) {
        const msg = `${key}: ${e?.message ?? e}`;
        this.envErrors.push(msg);
        this.logger.error(`独立库 ${key} 注册失败（该 key 的租户会 503）：${msg}`);
      }
    }
  }

  /** env 里解析/连接失败的条目（诊断面板原样透出，别让运维去翻日志） */
  envRegisterErrors(): string[] { return [...this.envErrors]; }

  /**
   * 按上下文取 DataSource。
   * 空或 'default' → 共享库；其它值 → 已注册的独立库（D2，见 registerFromUrl / DB_DEDICATED_DSNS）。
   * 没注册就明确报错，不回退共享库 —— 否则会出现「以为隔离了其实没隔离」的数据事故。
   */
  get(ctx: Pick<TenantCtx, 'dataSourceKey'>): DataSource {
    const key = ctx?.dataSourceKey;
    if (!key || key === 'default') return this.dataSource;
    const ds = this.dedicated.get(key);
    if (ds?.isInitialized) return ds;
    throw new ServiceUnavailableException(
      `独立数据源 "${key}" 未注册或连接失败（tenants.data_source_key="${key}" 的租户需先配 DB_DEDICATED_DSNS 或调 POST /platform/datasources）`,
    );
  }

  /** 当前进程注册了哪些独立库（平台后台健康检查用） */
  dedicatedKeys(): string[] { return [...this.dedicated.keys()]; }

  /** 诊断面板数据（脱敏：只有 host/port/database/user，没有密码） */
  describeDedicated(): DedicatedInfo[] {
    return [...this.dedicated.keys()].map((k) => this.dedicatedMeta.get(k)).filter(Boolean) as DedicatedInfo[];
  }

  /**
   * 按 DSN 注册（env 启动与平台接口共用）。
   * 先连、再自检库结构、最后才落进注册表 —— 半初始化的库不许进来，
   * 否则租户会被导出一个空包还显示成功。
   */
  async registerFromUrl(key: string, url: string, source: 'env' | 'api' = 'api'): Promise<DedicatedInfo> {
    const chk = validateKey(key);
    if (!chk.ok) throw new Error(chk.reason);
    if (!isPostgresUrl(url)) throw new Error('DSN 必须是 postgres:// 连接串');
    const target = dsnTarget(url);
    if (!target) throw new Error('DSN 解析不出目标库（检查是否带了库名）');

    const ds = await this.buildDedicated(key, url);
    try {
      const inspect = await this.inspectSchema(ds);
      const verdict = schemaVerdict(inspect.missing, inspect.tableCount);
      if (!verdict.ok) throw new Error(verdict.message);
      this.logger.log(`独立库已注册：${key} → ${target.host}:${target.port}/${target.database}（${verdict.message}）`);
    } catch (e) {
      await ds.destroy().catch(() => {});
      throw e;
    }
    const old = this.dedicated.get(key);
    if (old?.isInitialized) await old.destroy().catch(() => {});
    this.dedicated.set(key, ds);
    const info: DedicatedInfo = { key, ...target, registeredAt: new Date().toISOString(), source };
    this.dedicatedMeta.set(key, info);
    return info;
  }

  /** 库结构自检：走 pg_catalog（information_schema 会按角色权限过滤，见 docs/10 §10.23.2） */
  async inspectSchema(ds: DataSource): Promise<{ missing: string[]; tableCount: number }> {
    await ds.query('select 1');
    const rows: any[] = await ds.query(
      `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p')`,
    );
    const names = new Set(rows.map((r) => String(r.t)));
    return { missing: REQUIRED_TABLES.filter((t) => !names.has(t)), tableCount: names.size };
  }

  /** 建池（不注册）：拆出来是为了「连得上但结构不合格」时能干净地 destroy */
  private async buildDedicated(key: string, url: string): Promise<DataSource> {
    const ds = new DataSource({
      type: 'postgres',
      url,
      entities: [],                 // 独立库只跑带参原生 SQL，不挂实体元数据（省内存也避免元数据漂移）
      synchronize: false,
      migrationsRun: false,
      logging: false,
      connectTimeoutMS: 5000,
      extra: { max: +(process.env.DB_DEDICATED_POOL || 4), idleTimeoutMillis: 30_000 },
    });
    try {
      await ds.initialize();
      return ds;
    } catch (e: any) {
      this.logger.error(`独立库 ${key} 连接失败：${e?.message ?? e}`);
      throw new ServiceUnavailableException(`独立库 "${key}" 连接失败：${e?.message ?? e}`);
    }
  }

  /** 注销并断开独立库（租户退订/删除时用） */
  async unregisterDedicated(key: string): Promise<void> {
    const ds = this.dedicated.get(key);
    this.dedicatedMeta.delete(key);
    if (!ds) return;
    this.dedicated.delete(key);
    if (ds.isInitialized) await ds.destroy().catch(() => {});
    this.logger.log(`独立库已注销：${key}`);
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
    opts: { dataSource?: DataSource } = {},
  ): Promise<{ result: T; rlsActive: boolean; mode: 'rls' | 'dedicated' | 'app-only' }> {
    if (!tenantId) throw new Error('withTenantScope 需要非 0 的 tenantId（RLS 下无租户标记等于查不到数据）');
    // 独立库（D2）：隔离来自「库边界」，不是 RLS 策略 → rlsActive 如实报 false。
    // 这里仍然打 GUC（applyTenantScope），这样同一套 DDL 复制过去后 RLS 也是生效的（纵深防御）。
    const pinned = opts.dataSource;
    const rls = pinned ? null : await this.getRlsDataSource();
    const ds = pinned ?? rls ?? this.dataSource;
    const mode: 'rls' | 'dedicated' | 'app-only' = pinned ? 'dedicated' : rls ? 'rls' : 'app-only';
    if (!pinned && !rls && !this.rlsWarned) {
      this.rlsWarned = true;
      this.logger.warn('未配置 DB_RLS_USER：withTenantScope 降级为主库连接（只有应用层 where 隔离，RLS 不生效）');
    }
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.applyTenantScope(qr, tenantId);
      const result = await fn({ em: qr.manager, rlsActive: !!rls, mode });
      await qr.commitTransaction();
      return { result, rlsActive: !!rls, mode };
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
    this.dedicatedMeta.clear();
    if (this.rlsDs?.isInitialized) await this.rlsDs.destroy().catch(() => {});
    this.rlsDs = null;
    this.rlsInit = null;
  }
}
