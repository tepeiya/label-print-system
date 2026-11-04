// 连接池统一入口（docs/11 §11.15.1 硬性约束 1 + D3）
// 约定：新增业务代码取连接一律走 get(ctx)，不要直接 @InjectRepository 之外的方式拿 DataSource，
// 否则 P6 接独立库（D2 type='dedicated'）时要全量返工。
// 同时提供 applyTenantScope()：在事务里打上 app.tenant_id，为 P6 的 RLS 策略预留会话变量。
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { TenantCtx } from './tenant.context';

/** 能执行带参 SQL 的对象即可（QueryRunner 和 EntityManager 都有 query()） */
export type SqlRunner = Pick<QueryRunner, 'query'> | EntityManager;

@Injectable()
export class TenantDataSourceManager {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * 按上下文取 DataSource。
   * P0：dataSourceKey 为空或 'default' → 共享库；
   * 其它值代表该租户要连独立库（D2 / P6）。当前尚未接入独立库，这里明确报错而不是静默回退共享库，
   * 否则会出现「以为隔离了其实没隔离」的数据事故。
   */
  get(ctx: Pick<TenantCtx, 'dataSourceKey'>): DataSource {
    const key = ctx?.dataSourceKey;
    if (!key || key === 'default') return this.dataSource;
    throw new ServiceUnavailableException(
      `独立数据源 "${key}" 尚未接入（P6 落地），请先移除该租户的 dataSourceKey`,
    );
  }

  /**
   * 在当前事务里打上租户标记，供 RLS 策略 / session 变量使用。
   * set_config(..., true) = 事务级，提交或回滚后自动失效，不会污染连接池里其他请求。
   * P0 只写入不消费（RLS 策略在 P6 建），但必须现在就调用，避免 P6 补的时候到处找事务入口。
   */
  async applyTenantScope(runner: SqlRunner, tenantId: number): Promise<void> {
    if (!tenantId) return;
    await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [String(tenantId)]);
  }
}
