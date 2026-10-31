import { Module, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditLog } from '../entities/print.entity';
import { TenantGuard } from '../common/tenant.guard';
import { useTenantId } from '../common/tenant.context';

/** 审计写入（操作/打印日志统一入口） */
@Injectable()
export class AuditService {
  constructor(@InjectRepository(AuditLog) private repo: Repository<AuditLog>) {}
  write(tenantId: number, action: string, detail: Record<string, any> = {}, actorId?: number, targetType?: string, targetId?: number) {
    return this.repo.save({ tenantId, action, detail, actorId, targetType, targetId });
  }
}

@Controller('audit/logs')
@UseGuards(TenantGuard)
export class AuditController {
  constructor(private repo: Repository<AuditLog>) {}
  @Get() list(@Query() q: any) {
    return this.repo.find({ where: { tenantId: useTenantId(), action: q.action }, order: { createdAt: 'DESC' }, take: q.pageSize ?? 50 });
  }
}

@Module({ controllers: [AuditController], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
