// =============================================================================
// backup.service.ts —— 整租户备份 / 恢复
//
// 设计：TypeORM query(`SELECT * FROM <表> WHERE tenant_id = $1`) 拉租户数据 →
//   JSON.stringify → zlib.gzip → 存 TenantBackup.data (bytea)。
// restore 时反过来 gunzip → upsert 回每张表。
// =============================================================================

import { Injectable, NotFoundException, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { gzipSync, gunzipSync } from 'zlib';
import { TenantBackup } from '../entities/print.entity';
import { useTenant, useTenantId } from '../common/tenant.context';
import { AuditService } from '../audit/audit.module';

/** 需要备份的表（带 tenant_id）。顺序：先主表，后外键引用表 */
const TENANT_TABLES = [
  'tenants',
  'users', 'user_roles', 'refresh_tokens',
  'printers',
  'templates', 'template_versions', 'template_assets', 'template_shares',
  'serial_sequences', 'serial_usage_log',
  'data_sources', 'data_rows',
  'ai_model_configs', 'ai_template_jobs',
  'print_jobs', 'print_logs',
  'audit_logs',
];

@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger('Backup');
  constructor(
    @InjectRepository(TenantBackup) private backups: Repository<TenantBackup>,
    private audit: AuditService,
  ) {}

  async onModuleInit() { /* no-op */ }

  /** 列出本租户所有备份 */
  list() {
    const tenantId = useTenantId();
    return this.backups.find({ where: { tenantId }, order: { createdAt: 'DESC' } });
  }

  /** 创建整租户备份 */
  async create(name?: string) {
    const ctx = useTenant();
    const tenantId = ctx.tenantId;
    const t0 = Date.now();

    // 1. dump 所有表数据
    const dump: Record<string, any[]> = {};
    for (const table of TENANT_TABLES) {
      try {
        if (table === 'tenants') {
          dump[table] = await this.backups.manager.query(`SELECT * FROM ${table} WHERE id = $1`, [tenantId]).catch(() => []);
        } else {
          dump[table] = await this.backups.manager.query(`SELECT * FROM ${table} WHERE tenant_id = $1`, [tenantId]).catch(() => []);
        }
      } catch (e) {
        this.logger.warn(`[backup] 表 ${table} dump 失败，跳过：${(e as Error).message}`);
        dump[table] = [];
      }
    }

    // 2. 序列化 + gzip
    const payload = {
      schemaVersion: 1,
      tenantId,
      createdAt: new Date().toISOString(),
      tables: dump,
    };
    const json = JSON.stringify(payload);
    const compressed = gzipSync(Buffer.from(json, 'utf-8'));
    const sizeBytes = compressed.length;

    // 3. 存记录
    const finalName = name ?? `备份-${new Date().toISOString().slice(0, 10)}`;
    const record = await this.backups.save({
      tenantId, name: finalName,
      storageKey: `manual/${Date.now()}.json.gz`,
      sizeBytes,
      kind: 'manual',
      createdBy: ctx.userId ?? undefined,
      data: compressed,
    });

    await this.audit.write(tenantId, 'backup.create', { backupId: record.id, name: finalName, sizeBytes, durationMs: Date.now() - t0 }, ctx.userId);
    return {
      id: record.id, name: finalName, sizeBytes, createdAt: record.createdAt,
      tableCounts: Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, v.length])),
      durationMs: Date.now() - t0,
    };
  }

  /** 恢复备份（upsert 所有表）。危险操作——只允许 admin 调用 */
  async restore(id: number) {
    const ctx = useTenant();
    const tenantId = ctx.tenantId;
    const admin = ctx.roles?.includes('admin');
    if (!admin) throw new BadRequestException('只有 admin 才能执行恢复操作');

    const record = await this.backups.findOne({ where: { id, tenantId } });
    if (!record) throw new NotFoundException('备份不存在');
    if (!record.data) throw new BadRequestException('备份数据为空');

    // 1. 解压
    const json = gunzipSync(record.data).toString('utf-8');
    const payload = JSON.parse(json);
    if (payload.schemaVersion !== 1) throw new BadRequestException(`不支持的备份版本: ${payload.schemaVersion}`);
    if (payload.tenantId && payload.tenantId !== tenantId) throw new BadRequestException('备份租户与当前租户不匹配');

    // 2. 事务内清空 + 写回（外键顺序：先删引用表，再删主表；插入反过来）
    const trx = this.backups.manager.connection.createQueryRunner();
    await trx.connect();
    await trx.startTransaction();
    const t0 = Date.now();
    const tableCounts: Record<string, number> = {};

    try {
      // 先禁用外键约束（PG）
      await trx.query('SET session_replication_role = replica');

      // 删除顺序（被引用表先删）
      const deleteOrder = [...TENANT_TABLES].reverse();
      for (const table of deleteOrder) {
        if (table === 'tenants') continue; // 不删 tenants 自己
        const whereCol = table === 'tenants' ? 'id' : 'tenant_id';
        await trx.query(`DELETE FROM ${table} WHERE ${whereCol} = $1`, [tenantId]).catch(() => {});
      }

      // 插入顺序（主表先插）
      for (const table of TENANT_TABLES) {
        const rows: any[] = payload.tables?.[table] ?? [];
        if (!rows.length) continue;
        for (const row of rows) {
          // 去掉 id 字段让 DB 自增（避免冲突）
          if (row.id && table !== 'tenants') delete row.id;
          const cols = Object.keys(row);
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
          const values = Object.values(row);
          await trx.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, values).catch((e: any) => {
            // 单行插入失败不阻塞整批（可能是唯一约束冲突 / 列类型不匹配）
            this.logger.warn(`[restore] ${table} 单行插入跳过: ${e?.message}`);
          });
        }
        tableCounts[table] = rows.length;
      }

      await trx.query('SET session_replication_role = origin');
      await trx.commitTransaction();
    } catch (e) {
      await trx.rollbackTransaction();
      await trx.query('SET session_replication_role = origin').catch(() => {});
      throw e;
    } finally {
      await trx.release();
    }

    await this.audit.write(tenantId, 'backup.restore', { backupId: id, name: record.name, tableCounts, durationMs: Date.now() - t0 }, ctx.userId);
    return { id, tableCounts, durationMs: Date.now() - t0 };
  }

  /** 下载备份（返回 gzip 原始数据 + 文件名） */
  async download(id: number) {
    const tenantId = useTenantId();
    const record = await this.backups.findOne({ where: { id, tenantId } });
    if (!record) throw new NotFoundException('备份不存在');
    return record;
  }

  /** 删除备份 */
  async remove(id: number) {
    const ctx = useTenant();
    const tenantId = ctx.tenantId;
    const record = await this.backups.findOne({ where: { id, tenantId } });
    if (!record) throw new NotFoundException('备份不存在');
    await this.backups.delete({ id });
    await this.audit.write(tenantId, 'backup.delete', { backupId: id, name: record.name }, ctx.userId);
    return { ok: true };
  }
}
