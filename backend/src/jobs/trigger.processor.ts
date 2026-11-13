// =============================================================================
// TriggerProcessor —— P8.1 触发队列消费端
//
// 后台事件没有 HTTP 请求上下文，PrintService / Repository 代理都依赖 TenantCtx（AsyncLocalStorage）。
// 这里在消费时显式查目录库构造 ctx 再 tenantStorage.run，保证：
//   1. 业务读写带正确 tenant_id；
//   2. 独立库租户走 tdsm.get(ctx)（dataSourceKey 不能像阶段 A 那样硬编码 'default'，
//      否则触发器会把独立库租户的数据写进共享库 —— 这是 WP4 修过的同类缺口）。
//
// 目录库查询属「平台级运维任务受控例外」：用默认 DataSource 原生 SQL，显式带 id=$1，
// 结果只用于构造上下文，不返回给任何终端用户（与 MaintenanceService 同口径）。
// =============================================================================
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import type { TenantCtx } from '../common/tenant.context';
import { TRIGGER_QUEUE, type TriggerEvent } from './trigger.calc';
import { TriggerService } from './trigger.service';

@Processor(TRIGGER_QUEUE)
export class TriggerProcessor extends WorkerHost {
  private logger = new Logger('TriggerProcessor');

  constructor(
    private triggers: TriggerService,
    @InjectDataSource() private catalog: DataSource,
  ) { super(); }

  async process(job: Job) {
    const event = job.data?.event as TriggerEvent | undefined;
    if (!event || !Number.isInteger(Number(event.tenantId)) || Number(event.tenantId) <= 0) {
      this.logger.warn(`触发事件缺少合法 tenant_id，丢弃 job=${job.id}`);
      return { skipped: 'invalid_event' };
    }
    const ctx = await this.contextFor(Number(event.tenantId));
    return this.triggers.emit(event, ctx);
  }

  private async contextFor(tenantId: number): Promise<TenantCtx> {
    let dataSourceKey: string | null = 'default';
    try {
      // 显式带 tenant_id（这里是主键 id），只取路由键
      const rows = await this.catalog.query(
        `select data_source_key from public.tenants where id = $1`, [tenantId],
      );
      dataSourceKey = rows?.[0]?.data_source_key ?? 'default';
    } catch (e: any) {
      this.logger.warn(`读取租户路由键失败，回落 default（tenant=${tenantId}）：${e?.message ?? e}`);
    }
    return {
      tenantId, userId: 0, roles: ['admin'],
      modules: [], permissions: [], plan: null, features: {}, dataScopes: null,
      dataSourceKey,
    };
  }
}
