import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';
import * as entities from './entities';

import { AuthModule } from './auth/auth.module';
import { TemplateModule } from './template/template.module';
import { SerialModule } from './serial/serial.module';
import { FormulaModule } from './formula/formula.module';
import { BarcodeModule } from './barcode/barcode.module';
import { PrinterModule } from './printer/printer.module';
import { PrintModule } from './print/print.module';
import { DataSourceModule } from './datasource/datasource.module';
import { AuditModule } from './audit/audit.module';
import { UserAdminModule } from './user/user.module';
import { AiTemplateModule } from './ai-template/ai-template.module';
import { BackupModule } from './backup/backup.module';
import { SaasModule } from './saas/saas.module';
import { BillingModule } from './billing/billing.module';
import { InventoryModule } from './inventory/inventory.module';
import { AgentModule } from './agent/agent.module';
import { NotifyModule } from './notify/notify.module';
import { JobsModule } from './jobs/jobs.module';
import { GovernanceModule } from './governance/governance.module';
import { HardwareModule } from './hardware/hardware.module';
import { WmsModule } from './wms/wms.module';
import { IssuingModule } from './wms/issuing/issuing.module';
import { UdiModule } from './udi/udi.module';
import { KbModule } from './kb/kb.module';
import { TenantRoutingModule } from './common/tenant-routing.module';
import { HealthController } from './common/health.controller';
import { SnakeNamingStrategy } from './snake-naming.strategy';
import { JWT_SECRET, redisConnection } from './common/config';

const ENTITIES = Object.values(entities).filter((e) => typeof e === 'function');

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: +(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'labelflow',
      password: process.env.DB_PASS || 'labelflow',
      database: process.env.DB_NAME || 'labelflow',
      entities: ENTITIES,
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,            // 生产用 migration（docs/03-database.sql）
      logging: false,
    }),
    JwtModule.register({ secret: JWT_SECRET, global: true }),
    // BullMQ：打印队列 worker 需要根配置才能启动（队列本身在 PrintModule 注册）
    BullModule.forRoot({ connection: redisConnection() }),
    AuthModule, TemplateModule, SerialModule, FormulaModule, BarcodeModule,
    PrinterModule, PrintModule, DataSourceModule, AuditModule, UserAdminModule, AiTemplateModule, BackupModule,
    SaasModule, BillingModule, InventoryModule, AgentModule,
    NotifyModule, JobsModule,   // B2.5 站内信 + B2.4 定时任务（maintenance 队列）
    GovernanceModule,           // P8.3 企业治理：发布审批 / 防重 / 水印 / 数量策略
    HardwareModule,             // P8.5 硬件层：本地打印代理 / Windows Spooler / RFID / 喷码
    WmsModule,                  // WMS 阶段一：收货与上架（模块订阅 wms.inbound）
    IssuingModule,              // WMS 阶段二：工单发料与齐套（模块订阅 wms.issuing）
    UdiModule,                  // UDI 医疗合规赋码：构造/解析/扫码复核/模板包
    KbModule,                   // 平台端知识库 + AI 助手（无 tenant_id，PlatformJwtGuard 把关）
    TenantRoutingModule,        // P6.2 阶段 B：全局 Repository/事务租户路由（@Global）
  ],
  controllers: [HealthController],
})
export class AppModule {}
