// P3 计费模块：用量采集 / 配额 / 账单 / 收款（docs/11 §11.7、D5）
// 依赖方向：PrintModule、AiTemplateModule、SaasModule(平台运营 API) → BillingModule，单向不成环。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageMeter, UsageDaily, Quota, Invoice, Payment } from './billing.entity';
import { Subscription, Plan } from '../entities/saas.entity';
import { UsageService } from './usage.service';
import { InvoiceService } from './invoice.service';
import { BillingController } from './billing.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([UsageMeter, UsageDaily, Quota, Invoice, Payment, Subscription, Plan]),
  ],
  controllers: [BillingController],
  providers: [UsageService, InvoiceService],
  exports: [UsageService, InvoiceService],
})
export class BillingModule {}
