// =============================================================================
// DataSourceService —— 数据源业务层（P8.4 从 datasource.module.ts 抽出）
//
// 【为什么抽出】P8.4 自动刷新的 Worker 需要注入本服务执行刷新；若本服务仍内联在
// module 文件里，module → processor → module 会形成 ESM 循环引用。抽出后依赖单向：
//   processor ──→ DataSourceService ──→ DatasourceRefreshService ──→ Queue/catalog
// datasource.module.ts 仍 re-export 本类，外部 import 路径保持兼容。
//
// 【调度接入】saveSql / setRefreshConfig / remove 都调 scheduler.sync/unschedule，
// 但调度失败（Redis 不可用）只告警、不让配置保存失败：配置是可持久化的真值，
// 队列是可重建的派生状态，启动期 bootstrap 会再次对齐。
// =============================================================================
import { Injectable, Logger, Optional, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DataSource as DS, DataRow } from '../entities/print.entity';
import { useTenant, useTenantId } from '../common/tenant.context';
import { AuditService } from '../audit/audit.module';
import { encrypt, decrypt, hasProdKey } from './sql-crypto';
import * as sqlx from './sql-executor';
// P8.4：多驱动方言 / 字段查找 / 刷新计划（纯函数，判定不在 Service 里散写）
import { buildLookupWhere, detectDriver, matchLookup, refreshPlan } from './sql-driver.calc';
import { DatasourceRefreshService } from './refresh-scheduler.service';

/**
 * 健壮 CSV 解析：支持引号包裹、引号内换行/逗号、"" 转义、CRLF，
 * 自动识别分隔符（逗号 / Tab / 分号）。
 * 注意：jobs/file-parse.ts 是 HotFolder 场景的独立实现（流式/文件稳定化语义不同），
 * 两处不共享，改动时请分别确认。
 */
export function parseCsv(text: string, delimiter?: string): { header: string[]; rows: string[][] } {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const delim = delimiter ?? detectDelimiter(raw);
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const cleaned = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!cleaned.length) return { header: [], rows: [] };
  const header = cleaned[0].map((h) => h.trim());
  return { header, rows: cleaned.slice(1) };
}

function detectDelimiter(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
  const counts: Record<string, number> = {
    ',': (firstLine.match(/,/g) ?? []).length,
    '\t': (firstLine.match(/\t/g) ?? []).length,
    ';': (firstLine.match(/;/g) ?? []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

@Injectable()
export class DataSourceService {
  private logger = new Logger('DataSourceService');

  constructor(
    @InjectRepository(DS) private ds: Repository<DS>,
    @InjectRepository(DataRow) private rows: Repository<DataRow>,
    private audit: AuditService,
    // P8.4：可选注入 —— 单测 / 无 Redis 环境下没有调度器也能正常保存配置
    @Optional() private scheduler?: DatasourceRefreshService,
  ) {}

  list() {
    return this.ds.find({ where: { tenantId: useTenantId() }, order: { createdAt: 'DESC' } });
  }

  async get(id: number) {
    const s = await this.ds.findOne({ where: { id, tenantId: useTenantId() } });
    if (!s) throw new NotFoundException('数据源不存在');
    return s;
  }

  async remove(id: number) {
    const src = await this.get(id);
    // SQL 数据源：释放连接池
    if (src.type === 'sql' && src.config?.encryptedUrl) {
      try { await sqlx.releasePool(decrypt(src.config.encryptedUrl)); } catch { /* ignore */ }
    }
    // P8.4：先撤销调度，避免删库后 repeatable 还在触发 404 刷屏
    await this.unschedule(id);
    await this.rows.delete({ sourceId: id, tenantId: useTenantId() });
    await this.ds.delete({ id, tenantId: useTenantId() });
    await this.audit.write(useTenantId(), 'data_source.delete', { id }, undefined, 'data_source', id);
    return { ok: true };
  }

  async saveRows(dto: { name?: string; type?: string; headers?: string[]; rows: any[]; fieldMap?: Record<string, string>; config?: any }) {
    const name = dto.name || `数据源 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const fieldMap = dto.fieldMap ?? {};
    const rawType = String(dto.type ?? 'csv').toLowerCase();
    const type = ['csv', 'excel', 'sql'].includes(rawType) ? rawType : 'csv';
    const payloads = (dto.rows ?? []).map((r) => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(r)) out[fieldMap[k] ?? k] = v;
      return out;
    });
    const src = await this.ds.save({
      tenantId: useTenantId(),
      name,
      type,
      config: { headers: dto.headers ?? Object.keys(payloads[0] ?? {}), fieldMap, sourceType: rawType, ...(dto.config ?? {}) },
    });
    if (payloads.length) {
      await this.rows.save(payloads.map((p) => ({ tenantId: useTenantId(), sourceId: src.id, payload: p })));
    }
    await this.audit.write(useTenantId(), 'data_source.create', { id: src.id, name, rows: payloads.length }, undefined, 'data_source', src.id);
    return { sourceId: src.id, rows: payloads.length, columns: Object.keys(payloads[0] ?? {}), headers: dto.headers ?? [] };
  }

  async uploadCsv(name: string, csvText: string, fieldMap: Record<string, string> = {}) {
    const { header, rows } = parseCsv(csvText);
    if (!header.length) throw new BadRequestException('CSV 内容为空');
    const payloads = rows.map((cells) => {
      const row: Record<string, any> = {};
      header.forEach((h, i) => { row[fieldMap[h] ?? h] = cells[i] ?? ''; });
      return row;
    });
    return this.saveRows({ name, type: 'csv', headers: header, rows: payloads, fieldMap: {} });
  }

  async rowsOf(sourceId: number, limit = 500, offset = 0) {
    await this.get(sourceId);
    return this.rows.find({
      where: { sourceId, tenantId: useTenantId() },
      order: { id: 'ASC' },
      take: Math.min(2000, limit),
      skip: offset,
    });
  }

  preview(sourceId: number, templateId: number, limit = 10) {
    return this.rows.find({ where: { sourceId, tenantId: useTenantId() }, take: limit });
  }

  // ================== SQL 数据源 ==================

  /** P8.4：从已保存的数据源取出「解密连接串 + 驱动」执行配置（DSN 不出现在响应里） */
  private sqlConfig(src: DS): sqlx.SqlExecConfig {
    return {
      connection: decrypt(src.config.encryptedUrl),
      driver: (src.config?.driver as sqlx.SqlExecConfig['driver']) ?? undefined,
    };
  }

  /**
   * P8.4：配置落库后同步 repeatable 调度。
   * 唯一真源是 refreshPlan() 归一化后的 plan，绝不在 Service 里另算 cron/interval。
   * 失败只告警：Redis 不可用时配置仍要能保存，启动期 bootstrap 会重新对齐。
   */
  private async syncSchedule(sourceId: number, plan: ReturnType<typeof refreshPlan>): Promise<void> {
    if (!this.scheduler) return;
    try {
      const key = useTenant().dataSourceKey ?? null;
      await this.scheduler.sync(useTenantId(), sourceId, plan, key);
    } catch (e: any) {
      this.logger.warn(`同步刷新调度失败（配置已保存，待启动期对齐）source=${sourceId}：${e?.message ?? e}`);
    }
  }

  private async unschedule(sourceId: number): Promise<void> {
    if (!this.scheduler) return;
    try { await this.scheduler.unschedule(useTenantId(), sourceId); }
    catch (e: any) { this.logger.warn(`撤销刷新调度失败 source=${sourceId}：${e?.message ?? e}`); }
  }

  /** 保存 SQL 数据源定义（连接串加密）。P8.4：支持 postgres / mysql / mssql */
  async saveSql(dto: { name: string; connectionUrl: string; queryTemplate?: string; description?: string; driver?: string; refresh?: Record<string, any> }) {
    if (!dto.connectionUrl) throw new BadRequestException('缺少 connectionUrl');
    const detected = detectDriver(dto.connectionUrl, dto.driver);
    if (!detected.ok || !detected.driver) throw new BadRequestException(detected.reason);
    // 刷新配置统一过 refreshPlan 夹取，脏配置不落库
    const plan = dto.refresh ? refreshPlan(dto.refresh) : refreshPlan(null);
    const encryptedUrl = encrypt(dto.connectionUrl);
    const src = await this.ds.save({
      tenantId: useTenantId(),
      name: dto.name || `SQL 数据源`,
      type: 'sql',
      config: {
        driver: detected.driver,
        driverDetectedBy: detected.reason,
        encryptedUrl,
        queryTemplate: dto.queryTemplate || '',
        description: dto.description || '',
        createdAt: new Date().toISOString(),
        envKeySet: hasProdKey(),
        ...(dto.refresh ? { refresh: { enabled: plan.enabled, intervalSec: plan.intervalSec, cron: plan.cron, replaceRows: plan.replaceRows } } : {}),
      },
    });
    await this.syncSchedule(src.id, plan);
    await this.audit.write(useTenantId(), 'data_source.save_sql', { id: src.id, name: src.name, driver: detected.driver }, undefined, 'data_source', src.id);
    return { sourceId: src.id, driver: detected.driver, envKeySet: hasProdKey(), refreshWarnings: plan.warnings };
  }

  /** 测试 SQL 数据源连接（按驱动生成 SELECT 1） */
  async testSql(id: number) {
    const src = await this.get(id);
    if (src.type !== 'sql') throw new BadRequestException('该数据源不是 SQL 类型');
    return sqlx.ping(this.sqlConfig(src));
  }

  /** 执行 SQL（参数化 + 只读强制 + P8.4 多驱动 + SQL 级分页） */
  async execSql(id: number, params: any[] = [], limit = 1000, offset = 0): Promise<sqlx.SqlExecResult> {
    const src = await this.get(id);
    if (src.type !== 'sql') throw new BadRequestException('该数据源不是 SQL 类型');
    const query = String(src.config.queryTemplate || '').trim();
    if (!query) throw new BadRequestException('该 SQL 数据源尚未配置查询模板');
    const cfg: sqlx.SqlExecConfig = { ...this.sqlConfig(src), offset: Math.max(0, Math.floor(Number(offset) || 0)) };
    let result: sqlx.SqlExecResult;
    try {
      result = await sqlx.execute(cfg, query, params, limit);
    } catch (e: any) {
      throw new BadRequestException(e?.message || String(e));
    }
    await this.audit.write(useTenantId(), 'data_source.exec_sql', {
      id, driver: cfg.driver, rowCount: result.rowCount, durationMs: result.durationMs,
      paramCount: params.length, offset: cfg.offset, limit,
    }, undefined, 'data_source', id);
    return result;
  }

  /**
   * P8.4 按字段查找：SQL 源先执行查询，CSV/Excel 源读已导入行，再内存过滤。
   * 字段名经 buildLookupWhere 的同一套 SAFE_IDENT 校验，杜绝注入。
   */
  async lookup(sourceId: number, filters: Record<string, any> = {}, limit = 200) {
    const src = await this.get(sourceId);
    const { invalid } = buildLookupWhere(filters, 'postgres');   // 只借列名单校验，不执行 SQL
    if (invalid.length) throw new BadRequestException(invalid.join('；'));
    let payloads: Record<string, any>[];
    if (src.type === 'sql') {
      payloads = (await this.execSql(sourceId, [], 2000)).rows;
    } else {
      const rows = await this.rows.find({ where: { sourceId, tenantId: useTenantId() }, take: 2000 });
      payloads = rows.map((r) => r.payload);
    }
    const matched = payloads.filter((p) => matchLookup(p, filters)).slice(0, Math.min(500, Math.max(1, Math.floor(Number(limit) || 200))));
    return { sourceId, matched, matchedCount: matched.length, scanned: payloads.length, filters };
  }

  /** P8.4：读取自动刷新计划（refreshPlan 夹取，脏配置收敛） */
  async refreshPlanOf(id: number) {
    const src = await this.get(id);
    if (src.type !== 'sql') throw new BadRequestException('自动刷新目前仅支持 SQL 数据源');
    const plan = refreshPlan(src.config?.refresh);
    return {
      sourceId: id, plan,
      lastRefreshAt: src.config?.refresh?.lastRefreshAt ?? null,
      lastRowCount: src.config?.refresh?.lastRowCount ?? null,
      lastError: src.config?.refresh?.lastError ?? null,
      lastErrorAt: src.config?.refresh?.lastErrorAt ?? null,
    };
  }

  /** P8.4：配置自动刷新（写 config.refresh，不新建表；调度计划由 jobs 消费） */
  async setRefreshConfig(id: number, raw: Record<string, any>) {
    const src = await this.get(id);
    if (src.type !== 'sql') throw new BadRequestException('自动刷新目前仅支持 SQL 数据源');
    const plan = refreshPlan(raw);
    const cfg = {
      ...src.config,
      refresh: {
        enabled: plan.enabled, intervalSec: plan.intervalSec, cron: plan.cron,
        replaceRows: plan.replaceRows,
        lastRefreshAt: src.config?.refresh?.lastRefreshAt ?? null,
        lastRowCount: src.config?.refresh?.lastRowCount ?? null,
      },
    };
    // TypeORM 对 jsonb 列的 _QueryDeepPartialEntity 不接受嵌套对象，
    // 这里 cfg 已由 refreshPlan 归一化，用 as any 绕过类型限制（运行时是合法 JSONB）。
    await this.ds.update({ id, tenantId: useTenantId() }, { config: cfg } as any);
    await this.syncSchedule(id, plan);
    await this.audit.write(useTenantId(), 'data_source.refresh_config', {
      id, enabled: plan.enabled, intervalSec: plan.intervalSec, cron: plan.cron,
    }, undefined, 'data_source', id);
    return { sourceId: id, plan, warnings: plan.warnings };
  }

  /**
   * P8.4：手动触发一次刷新 —— 真执行 SQL，把结果落到 data_rows，写审计。
   * 自动刷新的 Worker（refresh.processor.ts）复用同一方法，
   * 区别只在「由 HTTP 请求还是 BullMQ job 提供 TenantCtx」。
   */
  async refresh(id: number) {
    const src = await this.get(id);
    if (src.type !== 'sql') throw new BadRequestException('自动刷新目前仅支持 SQL 数据源');
    const plan = refreshPlan(src.config?.refresh);
    const result = await this.execSql(id, [], 5000);
    const tenantId = useTenantId();
    const rows = result.rows.slice(0, 5000);
    if (plan.replaceRows) await this.rows.delete({ sourceId: id, tenantId });
    if (rows.length) {
      await this.rows.save(rows.map((p) => ({ tenantId, sourceId: id, payload: p })));
    }
    const cfg = {
      ...src.config,
      refresh: {
        ...(src.config?.refresh ?? {}),
        lastRefreshAt: new Date().toISOString(),
        lastRowCount: rows.length,
        lastDurationMs: result.durationMs,
        lastError: null,
        lastErrorAt: null,
      },
    };
    await this.ds.update({ id, tenantId }, { config: cfg } as any);
    await this.audit.write(tenantId, 'data_source.refresh', {
      id, rows: rows.length, durationMs: result.durationMs, replaceRows: plan.replaceRows,
    }, undefined, 'data_source', id);
    return { sourceId: id, rows: rows.length, columns: result.columns, durationMs: result.durationMs, replaceRows: plan.replaceRows, warnings: result.warnings };
  }

  /**
   * P8.4：Worker 刷新失败时写回错误状态（单源失败隔离，不抛给队列反复重试）。
   * 错误进 config.refresh 而不是独立表，运维从 GET /:id/refresh-plan 即可看到。
   */
  async markRefreshError(id: number, message: string) {
    const src = await this.get(id);
    const cfg = {
      ...src.config,
      refresh: {
        ...(src.config?.refresh ?? {}),
        lastError: String(message ?? '').slice(0, 300),
        lastErrorAt: new Date().toISOString(),
      },
    };
    await this.ds.update({ id, tenantId: useTenantId() }, { config: cfg } as any);
  }
}
