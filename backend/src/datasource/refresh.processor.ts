// =============================================================================
// DatasourceRefreshProcessor —— P8.4 自动刷新队列消费端
//
// 后台任务没有 HTTP 请求上下文，而 DataSourceService.refresh() 依赖
// useTenantId()（AsyncLocalStorage）与按 TenantCtx.dataSourceKey 路由的 Repository 代理。
// 这里显式构造 ctx 再 tenantStorage.run，保证：
//   1. data_rows 写入带正确 tenant_id；
//   2. 独立库租户走 tdsm.get(ctx)，不会把数据写进共享库
//      （与 WP4 修过的 TenantContextInterceptor 硬编码 'default' 是同一类缺口）；
//   3. job name 与 job.data 双重校验，跨租户串号直接丢弃。
//
// 【失败策略】单个数据源刷新失败只写回 lastError 并告警，不把异常抛给 BullMQ：
//   - 一个租户的库连不上，不能让队列反复重试拖住其它租户的刷新；
//   - 下一轮周期会自然重试（周期本身就是重试机制）；
//   - 错误留在 config.refresh.lastError，运维从 refresh-plan 端点可见。
// =============================================================================
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { tenantStorage, type TenantCtx } from '../common/tenant.context';
import { DataSourceService } from './datasource.service';
import { REFRESH_QUEUE, parseRefreshJobName, validRefreshJobData } from './refresh-scheduler.calc';

@Processor(REFRESH_QUEUE)
export class DatasourceRefreshProcessor extends WorkerHost {
  private logger = new Logger('DatasourceRefreshProcessor');

  constructor(
    private sources: DataSourceService,
    @InjectDataSource() private catalog: DataSource,
  ) { super(); }

  async process(job: Job): Promise<Record<string, any>> {
    const parsed = parseRefreshJobName(String(job.name ?? ''));
    if (!parsed) {
      this.logger.warn(`未知刷新任务 ${job.name}（id=${job.id}），跳过`);
      return { skipped: 'unknown_job' };
    }
    if (!validRefreshJobData(job.data)) {
      this.logger.warn(`刷新任务 data 非法 ${job.name}（id=${job.id}），跳过`);
      return { skipped: 'invalid_data' };
    }
    // name 与 data 必须一致：防止队列里被塞入伪造 data 指向别的租户/数据源
    if (parsed.tenantId !== Number(job.data.tenantId) || parsed.sourceId !== Number(job.data.sourceId)) {
      this.logger.warn(`刷新任务 name/data 不一致 ${job.name}（id=${job.id}），丢弃`);
      return { skipped: 'mismatch' };
    }

    const ctx = await this.contextFor(parsed.tenantId, job.data.dataSourceKey);
    return tenantStorage.run(ctx, async () => {
      try {
        const r = await this.sources.refresh(parsed.sourceId);
        return { ok: true, tenantId: parsed.tenantId, sourceId: parsed.sourceId, rows: r.rows, durationMs: r.durationMs };
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 300);
        this.logger.warn(`自动刷新失败 tenant=${parsed.tenantId} source=${parsed.sourceId}：${msg}`);
        try { await this.sources.markRefreshError(parsed.sourceId, msg); }
        catch (inner: any) { this.logger.warn(`写回刷新错误状态失败：${inner?.message ?? inner}`); }
        return { ok: false, tenantId: parsed.tenantId, sourceId: parsed.sourceId, error: msg };
      }
    });
  }

  /**
   * 构造后台 TenantCtx。dataSourceKey 优先取注册时存进 job.data 的值（bootstrap 已 join 目录库），
   * 为空再回落目录库实时查询 —— 与 TriggerProcessor.contextFor() 同口径。
   * 查询属平台级运维受控例外，显式带 id=$1，结果不返回终端用户。
   */
  private async contextFor(tenantId: number, hintedKey?: string | null): Promise<TenantCtx> {
    let dataSourceKey: string | null = hintedKey ? String(hintedKey) : 'default';
    if (!hintedKey) {
      try {
        const rows = await this.catalog.query(
          `select data_source_key from public.tenants where id = $1`, [tenantId],
        );
        dataSourceKey = rows?.[0]?.data_source_key ?? 'default';
      } catch (e: any) {
        this.logger.warn(`读取租户路由键失败，回落 default（tenant=${tenantId}）：${e?.message ?? e}`);
      }
    }
    return {
      tenantId, userId: 0, roles: ['admin'],
      modules: [], permissions: [], plan: null, features: {}, dataScopes: null,
      dataSourceKey,
    };
  }
}
