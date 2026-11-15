import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { SerialSequence, SerialUsageLog } from '../entities/serial.entity';
import { SerialModuleService } from './serial.service';
import { SerialController } from './serial.controller';

@Module({
  imports: [TypeOrmModule.forFeature([SerialSequence, SerialUsageLog])],
  providers: [SerialModuleService],
  controllers: [SerialController],
  exports: [SerialModuleService],
})
export class SerialModule {}
