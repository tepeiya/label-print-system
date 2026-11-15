// =============================================================================
// DatasourceRefreshService —— P8.4 自动刷新调度注册层（真实 BullMQ 接入）
//
// 【职责边界】这里只管「队列里有哪些 repeatable job」，不执行任何 SQL：
//   - 执行 SQL 是 DataSourceService.refresh()；
//   - 何时 add / remove / 保持不变是 refresh-scheduler.calc.ts 的纯函数；
//   - 三层分开，是为了让「配置重复保存会不会多注册一个任务」这种事故可单测。
//
// 【为什么放在 DataSourceModule 而不是 JobsModule】
//   Worker 需要注入 DataSourceService 才能执行刷新；若把本服务放 JobsModule，
//   JobsModule → DataSourceModule（拿 service），而 DataSourceService 又要反向注入
//   本服务做配置变更同步，就形成循环 DI。全部收在本模块内，依赖是单向的：
//     DataSourceService ──→ DatasourceRefreshService ──→ Queue / catalog
//     DatasourceRefreshProcessor ──→ DataSourceService / catalog
//   Processor 不被任何 service 注入，无环（P8.3 建立单向依赖时同款约定）。
//
// 【多租户红线】跨租户扫描是平台级运维任务的受控例外（与 MaintenanceService 同口径）：
//   1. 扫描结果只进进程内日志与聚合计数，绝不返回终端用户；
//   2. 每个 job name 显式带 tenant_id + source_id，job.data 再带一次，Worker 双重校验；
//   3. 独立库租户：catalog 目录库扫不到其 data_sources（在独立库），
//      故 bootstrap 只覆盖共享库租户 —— 该边界在 docs/10 §10.29 明确标注，不假装覆盖。
// =============================================================================
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import type { RefreshPlan } from './sql-driver.calc';
import {
  MAX_BOOTSTRAP_SOURCES, REFRESH_JOB_PREFIX, REFRESH_QUEUE, REFRESH_SCHEDULER_ENV,
  bootstrapCandidates, reconcileRepeat, refreshJobData, refreshJobName,
  repeatFromBull, repeatOfPlan, toBullRepeat,
} from './refresh-scheduler.calc';

export interface SyncReport {
  name: string;
  action: string;
  reason: string;
  removed: number;
  added: boolean;
}

export interface BootstrapReport {
  job: string;
  at: string;
  scanned: number;
  candidates: number;
  added: number;
  unchanged: number;
  replaced: number;
  removed: number;
  failed: number;
  disabled: boolean;
  error?: string;
}

/** 启动期对齐扫描：只取 SQL 源里已启用 refresh 的行，显式带 tenant_id */
const BOOTSTRAP_SQL = `
SELECT ds.tenant_id        AS "tenantId",
       ds.id               AS "sourceId",
       ds.config->'refresh' AS refresh,
       t.data_source_key   AS "dataSourceKey"
FROM public.data_sources ds
LEFT JOIN public.tenants t ON t.id = ds.tenant_id
WHERE ds.type = 'sql'
  AND ds.config->'refresh'->>'enabled' = 'true'
  AND ds.tenant_id IS NOT NULL
ORDER BY ds.id ASC
LIMIT $1
`;

@Injectable()
export class DatasourceRefreshService implements OnModuleInit {
  private logger = new Logger('DatasourceRefreshService');

  constructor(
    @InjectQueue(REFRESH_QUEUE) private queue: Queue,
    @InjectDataSource() private catalog: DataSource,
  ) {}

  /**
   * 应用启动后对齐一次已有调度。
   * 用 try/catch 兜住整段：沙盒 / 无 Redis 环境下注册失败只告警，
   * 绝不阻断应用启动（这是「启动期加固」的同一条纪律）。
   */
  async onModuleInit() {
    try {
      const r = await this.bootstrap();
      this.logger.log(`数据源自动刷新调度对齐：${JSON.stringify(r)}`);
    } catch (e: any) {
      this.logger.warn(`数据源自动刷新调度对齐失败（不阻断启动）：${e?.message ?? e}`);
    }
  }

  /** 读取队列中本数据源已有的 repeatable（按 name 精确匹配，跨租户不会误删） */
  private async repeatableFor(name: string): Promise<any[]> {
    const all = await this.queue.getRepeatableJobs();
    return (all ?? []).filter((j: any) => j?.name === name);
  }

  /**
   * 配置变更后对齐调度：唯一入口，saveSql / setRefreshConfig / bootstrap 都调它。
   * 「参数没变 → 什么都不做」是防重复注册的关键；参数变了必须 remove 再 add，
   * 因为 BullMQ repeatable key 由 name + repeat 参数生成，改参数会生成新 key。
   */
  async sync(
    tenantId: number, sourceId: number, plan: RefreshPlan, dataSourceKey: string | null = null,
  ): Promise<SyncReport> {
    const name = refreshJobName(tenantId, sourceId);
    const next = repeatOfPlan(plan);
    const existing = await this.repeatableFor(name);
    const prev = existing.length ? repeatFromBull(existing[0]) : null;
    const verdict = reconcileRepeat(prev, next);

    let removed = 0;
    if (verdict.remove) {
      for (const j of existing) {
        try { await this.queue.removeRepeatableByKey(j.key); removed += 1; }
        catch (e: any) { this.logger.warn(`撤销旧调度失败 ${name} key=${j.key}：${e?.message ?? e}`); }
      }
    }
    let added = false;
    const bullRepeat = toBullRepeat(next);
    if (verdict.add && bullRepeat) {
      await this.queue.add(name, refreshJobData(tenantId, sourceId, dataSourceKey), {
        repeat: bullRepeat,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 20 },
      });
      added = true;
    }
    return { name, action: verdict.action, reason: verdict.reason, removed, added };
  }

  /** 关闭刷新 / 删除数据源时彻底撤销（不依赖当前配置，直接按 name 清） */
  async unschedule(tenantId: number, sourceId: number): Promise<number> {
    const name = refreshJobName(tenantId, sourceId);
    const existing = await this.repeatableFor(name);
    let removed = 0;
    for (const j of existing) {
      try { await this.queue.removeRepeatableByKey(j.key); removed += 1; }
      catch (e: any) { this.logger.warn(`撤销调度失败 ${name} key=${j.key}：${e?.message ?? e}`); }
    }
    return removed;
  }

  /** 运维可见：当前队列里登记了哪些刷新任务（只暴露 name 与周期，不返回 DSN） */
  async scheduled(limit = 100): Promise<{ name: string; repeat: string; next?: number }[]> {
    const all = await this.queue.getRepeatableJobs();
    return (all ?? [])
      .filter((j: any) => String(j?.name ?? '').startsWith(`${REFRESH_JOB_PREFIX}:`))
      .slice(0, Math.max(1, Math.floor(Number(limit) || 100)))
      .map((j: any) => ({
        name: String(j.name),
        repeat: 'pattern' in (repeatFromBull(j) ?? {}) ? `pattern:${j.pattern}` : `every:${j.every ?? ''}`,
        next: j.next,
      }));
  }

  /** 启动期 / 手动触发：把库里「已启用」的配置对齐到队列，单源失败不影响其它源 */
  async bootstrap(): Promise<BootstrapReport> {
    const at = new Date().toISOString();
    if (String(process.env[REFRESH_SCHEDULER_ENV] ?? '1') === '0') {
      return { job: 'datasource.refresh_bootstrap', at, scanned: 0, candidates: 0, added: 0,
        unchanged: 0, replaced: 0, removed: 0, failed: 0, disabled: true };
    }
    // 把「扫描失败」当成一种返回值而不是控制流跳转：无真库 / 无 catalog 表时只告警，
    // 调度注册退化为「配置变更时即时 sync」，仍是可用链路，不假装启动期扫描成功。
    const scanned = await (async (): Promise<{ rows: any[]; error?: string }> => {
      try { return { rows: await this.catalog.query(BOOTSTRAP_SQL, [MAX_BOOTSTRAP_SOURCES]) }; }
      catch (e: any) { return { rows: [], error: String(e?.message ?? e) }; }
    })();
    if (scanned.error) {
      return { job: 'datasource.refresh_bootstrap', at, scanned: 0, candidates: 0, added: 0,
        unchanged: 0, replaced: 0, removed: 0, failed: 0, disabled: false,
        error: `catalog 扫描不可用：${scanned.error}` };
    }
    const rows = scanned.rows;
    const candidates = bootstrapCandidates(rows, MAX_BOOTSTRAP_SOURCES);
    const report: BootstrapReport = {
      job: 'datasource.refresh_bootstrap', at, scanned: rows.length, candidates: candidates.length,
      added: 0, unchanged: 0, replaced: 0, removed: 0, failed: 0, disabled: false,
    };
    for (const c of candidates) {
      try {
        const r = await this.sync(c.tenantId, c.sourceId, c.plan, c.dataSourceKey);
        if (r.action === 'add') report.added += 1;
        else if (r.action === 'replace') report.replaced += 1;
        else if (r.action === 'remove') report.removed += 1;
        else report.unchanged += 1;
      } catch (e: any) {
        report.failed += 1;
        this.logger.warn(`注册刷新调度失败 tenant=${c.tenantId} source=${c.sourceId}：${e?.message ?? e}`);
      }
    }
    return report;
  }
}
