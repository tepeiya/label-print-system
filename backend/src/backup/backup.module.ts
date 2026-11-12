import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { TenantBackup } from '../entities/print.entity';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([TenantBackup]), AuditModule],
  providers: [BackupService],
  controllers: [BackupController],
  exports: [BackupService],
})
export class BackupModule {}
