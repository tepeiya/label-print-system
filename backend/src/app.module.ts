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
import { SnakeNamingStrategy } from './snake-naming.strategy';
import { JWT_SECRET } from './common/config';

const ENTITIES = Object.values(entities).filter((e) => typeof e === 'function');

/** 兼容 REDIS_URL（如 redis://localhost:6380）与分项环境变量 */
function redisConnection() {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname || '127.0.0.1',
        port: +(u.port || 6379),
        password: u.password ? decodeURIComponent(u.password) : undefined,
        db: u.pathname && u.pathname.length > 1 ? +u.pathname.slice(1) : 0,
      };
    } catch { /* 回退到分项配置 */ }
  }
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: +(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

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
  ],
})
export class AppModule {}
