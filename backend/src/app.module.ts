import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
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
      synchronize: false,            // 生产用 migration（docs/03-database.sql）
      logging: false,
    }),
    JwtModule.register({ secret: process.env.JWT_SECRET || 'dev-secret', global: true }),
    AuthModule, TemplateModule, SerialModule, FormulaModule, BarcodeModule,
    PrinterModule, PrintModule, DataSourceModule, AuditModule,
  ],
})
export class AppModule {}
