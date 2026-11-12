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

@Injectable()
export class TenantRouting {
  private logger = new Logger('TenantRouting');

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

  /** 在目标 DataSource 上起事务，并打事务级 app.tenant_id（与 RLS 策略同源） */
  async transaction<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    const ds = this.dataSource();
    const tenantId = Number(this.ctx()?.tenantId ?? 0);
    return ds.transaction(async (em) => {
      if (tenantId > 0) await this.tdsm().applyTenantScope(em, tenantId);
      return fn(em);
    });
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
    query: (sql: string, params?: any[]) => routing.dataSource().query(sql, params),
    get manager() { return routing.dataSource().manager; },
    get isInitialized() { return routing.dataSource().isInitialized; },
  };
}
