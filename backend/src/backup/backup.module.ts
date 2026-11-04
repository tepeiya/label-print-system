import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantBackup } from '../entities/print.entity';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';

@Module({
  imports: [TypeOrmModule.forFeature([TenantBackup])],
  providers: [BackupService],
  controllers: [BackupController],
  exports: [BackupService],
})
export class BackupModule {}
