// =============================================================================
// tenant-routing.ts —— P6.2 阶段 B：业务读写按租户上下文路由（docs/10 §10.25.8 B1.1）
//
// 【问题】阶段 A 只把「平台侧导出/硬删」按库路由，业务 Repository 仍绑默认 DataSource，
// 于是独立库租户建模板/打库存会写进共享库 —— 客户以为隔离了其实没有，比不做更糟。
//
// 【方案】不改几十个 Service 的每一行，而是在**注入层**做代理：
//   TenantTypeOrmModule.forFeature() 返回的 Repository 是 Proxy，每次方法调用时
//   按当前 ALS 的 TenantCtx.dataSourceKey 解析到 tdsm.get(ctx)，再转发给真正的 Repository。
//   - ctx 为空（平台任务/定时任务/启动 seed/MCP inAgentTenant）→ 回落默认库，零破坏；
//   - ctx 带独立库 key 但库未注册 → tdsm.get() 抛 503，**绝不静默回落共享库**（红线）；
//   - 事务：TenantRouting.transaction() 在目标 DataSource 上起事务并打 app.tenant_id GUC。
//
// 【为什么用 ModuleRef 懒取 TenantDataSourceManager】后者由 SaasModule 提供，
// 而本模块是 @Global（SaasModule 隐式依赖它）。构造期直接注入会形成循环依赖；
// 运行时按需取，拿到的始终是 SaasModule 里那个唯一实例（独立库注册表只有一份）。
// =============================================================================
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, EntityTarget, ObjectLiteral, Repository } from 'typeorm';
import { TenantDataSourceManager } from './tenant-data-source.manager';
import { tenantStorage } from './tenant.context';

/** 事务代理的注入 token（给仍直接注入 DataSource 的 Service 用，见 InventoryService） */
export const TENANT_DATASOURCE = 'TENANT_ROUTING_DATASOURCE';

/** 能安全包进"单次短事务 + GUC"的 Repository 方法（一次调用即完成一次或多条 SQL） */
const RLS_SAFE_METHODS = new Set([
  'find', 'findOne', 'findBy', 'findOneBy', 'findAndCount', 'findAndCountBy',
  'count', 'countBy', 'exists', 'existsBy',
  'save', 'insert', 'update', 'upsert', 'delete', 'softDelete', 'restore', 'remove',
  'preload', 'increment', 'decrement', 'aggregate', 'sum', 'average', 'min', 'max',
]);

@Injectable()
export class TenantRouting {
  private logger = new Logger('TenantRouting');
  private unsafeWarned = new Set<string>();

  constructor(
    @InjectDataSource() private defaultDs: DataSource,
    private moduleRef: ModuleRef,
  ) {}

  private tdsm(): TenantDataSourceManager {
    return this.moduleRef.get(TenantDataSourceManager, { strict: false });
  }

  private ctx() {
    return tenantStorage.getStore() ?? null;
  }

  /** 空上下文 / default → 共享库；独立库 key → tdsm.get()（未注册抛 503，不回落） */
  dataSource(): DataSource {
    const key = this.ctx()?.dataSourceKey;
    if (!key || key === 'default') return this.defaultDs;
    return this.tdsm().get({ dataSourceKey: key });
  }

  repo<T extends ObjectLiteral>(entity: EntityTarget<T>): Repository<T> {
    return this.dataSource().getRepository(entity);
  }

  /**
   * D2：主链路是否走 RLS 角色（默认关）。
   * 需要 DB_RLS_USER（角色凭据）+ DB_RLS_ENFORCE=1 两个条件同时成立才启用，
   * 少一个都维持旧行为（超管连接 + 应用层 where 隔离），绝不"半开"。
   */
  private rlsEnforced(): boolean {
    return process.env.DB_RLS_ENFORCE === '1' && !!process.env.DB_RLS_USER;
  }

  /** 当前是否会走 RLS 角色（健康检查/日志用） */
  rlsMode(): 'rls' | 'superuser' {
    return this.rlsEnforced() ? 'rls' : 'superuser';
  }

  /**
   * 在目标 DataSource 上起事务，并打事务级 app.tenant_id（与 RLS 策略同源）。
   * RLS 强制模式：改在 **RLS 角色连接** 上起事务 —— 只有这条链路里的 SQL 才真被策略兜底。
   */
  async transaction<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    const tenantId = Number(this.ctx()?.tenantId ?? 0);
    if (this.rlsEnforced() && tenantId > 0) {
      const { result } = await this.tdsm().withTenantScope(tenantId, ({ em }) => fn(em), {
        dataSource: this.dedicatedDs(),
      });
      return result;
    }
    const ds = this.dataSource();
    return ds.transaction(async (em) => {
      if (tenantId > 0) await this.tdsm().applyTenantScope(em, tenantId);
      return fn(em);
    });
  }

  /** RLS 模式下的原生 SQL：同样走带 GUC 的短事务（否则策略下查不到任何行） */
  async rlsQuery<T = any>(sql: string, params?: any[]): Promise<T> {
    const tenantId = Number(this.ctx()?.tenantId ?? 0);
    if (!this.rlsEnforced() || tenantId <= 0) return this.dataSource().query(sql, params);
    const { result } = await this.tdsm().withTenantScope(
      tenantId,
      ({ em }) => em.query(sql, params),
      { dataSource: this.dedicatedDs() },
    );
    return result as T;
  }

  /** 独立库租户：库边界即隔离，RLS 只是纵深；共享库租户返回 undefined（让 withTenantScope 用 RLS 池） */
  private dedicatedDs() {
    const key = this.ctx()?.dataSourceKey;
    return key && key !== 'default' ? this.tdsm().get({ dataSourceKey: key }) : undefined;
  }

  /**
   * RLS 模式下的一次 Repository 调用：短事务 + set_config('app.tenant_id') 后执行单个方法。
   *
   * 为什么是"每次调用一个短事务"而不是"整个请求一个事务"：
   *   请求级事务需要能把 255 个端点的执行流全包进同一个 EntityManager，改造面太大且容易漏；
   *   Repository 代理本来就在调用时解析，包一层是唯一"零改端点"的切法。
   * 代价（必须知道）：
   *   · 一次调用多 2 个往返（BEGIN / set_config / COMMIT），写多读少的接口无感，列表页会略慢；
   *   · 一个 Service 方法里的多次 repo 调用**不在同一事务**（现状本来也没有事务），
   *     需要原子的逻辑必须显式用 transaction()（它已在 RLS 连接上跑）。
   */
  async rlsRepoCall<T>(entity: EntityTarget<any>, method: string | symbol, args: any[]): Promise<T> {
    const tenantId = Number(this.ctx()?.tenantId ?? 0);
    if (!this.rlsEnforced() || tenantId <= 0) {
      const repo: any = this.repo(entity);
      return repo[method](...args);
    }
    // 只有"一次调用即完成"的 Repository 方法能进 RLS 短事务。
    // createQueryBuilder 返回的是可链式调用的 builder（生命周期跨多次调用、无法绑定单次事务），
    // 强行包装会变成 Promise（leftJoin is not a function）。这类调用退回主连接，并在启动时 warn 一次。
    if (!RLS_SAFE_METHODS.has(String(method))) {
      if (!this.unsafeWarned.has(String(method))) {
        this.unsafeWarned.add(String(method));
        this.logger.warn(
          `RLS 模式下 Repository.${String(method)} 不在单事务白名单内，本次走主连接（应用层 tenant_id 过滤仍生效，但不受 RLS 兜底）。`
          + ' 需要强隔离的复杂查询请改用 TenantRouting.transaction()。',
        );
      }
      const repo: any = this.repo(entity);
      const fn = repo[method];
      return typeof fn === 'function' ? fn.call(repo, ...args) : (fn as T);
    }
    const { result } = await this.tdsm().withTenantScope(
      tenantId,
      ({ em }) => (em.getRepository(entity) as any)[method](...args),
      { dataSource: this.dedicatedDs() },
    );
    return result as T;
  }

  /** 诊断用：当前请求实际会落到哪个库（不抛错，供健康检查/日志） */
  describe(): { key: string; dedicated: boolean } {
    const key = String(this.ctx()?.dataSourceKey ?? 'default');
    return { key, dedicated: key !== 'default' };
  }
}

/**
 * Repository 动态代理：所有属性/方法在**访问时**才解析底层 Repository。
 * 用 Proxy 而不是手写 20 个转发方法，是为了覆盖未来新增的 Repository API
 * （find/findOne/save/update/delete/insert/create/createQueryBuilder/metadata/manager…）。
 */
export function tenantRepositoryProxy<T extends ObjectLiteral>(
  routing: TenantRouting, entity: EntityTarget<T>,
): Repository<T> {
  return new Proxy({} as Repository<T>, {
    get(_target, prop) {
      const repo: any = routing.repo(entity);
      const value = repo[prop];
      // RLS 强制模式：只有**真正的方法**才包短事务；属性（metadata/target/manager）必须直取，
      // 否则 Nest 的 InstanceLoader / QueryBuilder 拿属性时会得到一个函数，当场炸。
      // 只有白名单方法才包 async 短事务；createQueryBuilder 等链式 API 必须同步返回 builder，
      // 一旦包成 async 立刻变成 Promise（调用方 .leftJoin 直接崩）。
      if (routing.rlsMode() === 'rls' && typeof prop === 'string' && typeof value === 'function'
          && RLS_SAFE_METHODS.has(prop)) {
        return (...args: any[]) => routing.rlsRepoCall(entity, prop, args);
      }
      return typeof value === 'function' ? value.bind(repo) : value;
    },
  });
}

/** DataSource 常用子集代理（InventoryService 等直接注入 DataSource 的旧代码用） */
export function tenantDataSourceProxy(routing: TenantRouting) {
  return {
    transaction: <T>(fn: (em: EntityManager) => Promise<T>) => routing.transaction(fn),
    createQueryBuilder: (...args: any[]) => (routing.dataSource().createQueryBuilder as any)(...args),
    getRepository: <T extends ObjectLiteral>(e: EntityTarget<T>) => routing.repo(e),
    // RLS 强制模式下原生 SQL 也必须带租户 GUC，否则策略下查不到任何行
    query: (sql: string, params?: any[]) => routing.rlsQuery(sql, params),
    get manager() { return routing.dataSource().manager; },
    get isInitialized() { return routing.dataSource().isInitialized; },
  };
}
