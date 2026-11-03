import { Module, Injectable, Controller, Get, Post, Query, Body, Res, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Response } from 'express';
import { AuditLog } from '../entities/print.entity';
import { TenantGuard } from '../common/tenant.guard';
import { Roles } from '../common/roles.guard';
import { useTenantId } from '../common/tenant.context';

/** 审计写入（操作/打印日志统一入口） */
@Injectable()
export class AuditService {
  constructor(@InjectRepository(AuditLog) private repo: Repository<AuditLog>) {}
  write(tenantId: number, action: string, detail: Record<string, any> = {}, actorId?: number, targetType?: string, targetId?: number) {
    return this.repo.save({ tenantId, action, detail, actorId, targetType, targetId });
  }

  /** 查询（分页） */
  find(q: { action?: string; page?: number; pageSize?: number }) {
    const where: any = { tenantId: useTenantId() };
    if (q.action) where.action = q.action;
    return this.repo.find({
      where, order: { createdAt: 'DESC' },
      skip: ((q.page ?? 1) - 1) * (q.pageSize ?? 100),
      take: Math.min(1000, q.pageSize ?? 100),
    });
  }

  /** 导出（拉全量，上限 20000） */
  exportRows(q: { action?: string; since?: string; until?: string; limit?: number }) {
    const where: any = { tenantId: useTenantId() };
    if (q.action) where.action = q.action;
    if (q.since) where.createdAt = { ...(where.createdAt ?? {}), __gte: new Date(q.since) };
    if (q.until) where.createdAt = { ...(where.createdAt ?? {}), __lte: new Date(q.until) };
    // TypeORM 兼容写法
    if (q.since || q.until) {
      const range: any = {};
      if (q.since) range.min = new Date(q.since);
      if (q.until) range.max = new Date(q.until);
      where.createdAt = range;
    }
    return this.repo.find({ where, order: { createdAt: 'DESC' }, take: Math.min(20000, q.limit ?? 5000) });
  }
}

function csvEscape(v: any): string {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

@Controller('audit/logs')
@UseGuards(TenantGuard)
export class AuditController {
  constructor(private svc: AuditService) {}

  @Get() list(@Query() q: any) {
    return this.svc.find(q);
  }

  /** 导出 CSV / JSON（仅 admin） */
  @Roles('admin')
  @Get('export')
  async export(@Query() q: any, @Res() res: Response) {
    const rows = await this.svc.exportRows(q);
    const fmt = String(q.format ?? 'csv').toLowerCase();
    if (fmt === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-${Date.now()}.json"`);
      return res.send(rows);
    }
    const header = ['时间', '动作', '目标类型', '目标ID', '执行人', '详情'];
    const body = rows.map((r) => [
      r.createdAt ? new Date(r.createdAt).toISOString() : '',
      r.action, r.targetType ?? '', r.targetId ?? '',
      r.actorId ?? '',
      JSON.stringify(r.detail ?? {}),
    ].map(csvEscape).join(','));
    const csv = '\uFEFF' + [header.join(','), ...body].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${Date.now()}.csv"`);
    res.send(csv);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
