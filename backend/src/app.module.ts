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
import { TenantRoutingModule } from './common/tenant-routing.module';
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
    TenantRoutingModule,        // P6.2 阶段 B：全局 Repository/事务租户路由（@Global）
  ],
})
export class AppModule {}
