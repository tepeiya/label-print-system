// =============================================================================
// BillingController —— 租户侧账单/用量查询（docs/11 §11.6.1 GET /billing/invoices）
// 权限点 sys:billing:read（saas_p3_billing.sql 已授予 admin / tenant_admin）。
// 写操作（出账/收款/配额）全部在平台运营侧 /platform/**（P2 身份），租户只读。
// =============================================================================
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenantId } from '../common/tenant.context';
import { UsageService } from './usage.service';
import { InvoiceService } from './invoice.service';

@Controller('billing')
@UseGuards(TenantGuard)
// 账单权限点挂在 users 模块（与 sys:* 系列一致）；未订阅 users 的租户本来也看不了用户管理
@RequireModule('users')
export class BillingController {
  constructor(
    private usage: UsageService,
    private invoices: InvoiceService,
  ) {}

  /** 本月各计量项用量 + 配额上限（软/硬） */
  @Get('usage')
  @RequirePermission('sys:billing:read')
  async usageSummary() {
    const tenantId = useTenantId();
    return { tenantId, period: 'month', items: await this.usage.monthSummary(tenantId) };
  }

  /** 某计量项近 N 天日序列（默认 30 天，图表/对账用） */
  @Get('usage/series')
  @RequirePermission('sys:billing:read')
  async usageSeries(@Query('meter') meter: string, @Query('days') days?: string) {
    if (!meter) return [];
    return this.usage.daySeries(useTenantId(), meter, days ? Number(days) : 30);
  }

  /** 本租户账单列表（只见 issued/paid/overdue；含已收与余额） */
  @Get('invoices')
  @RequirePermission('sys:billing:read')
  listInvoices() { return this.invoices.listForTenant(useTenantId()); }

  /** 账单详情 + 收款记录（对账） */
  @Get('invoices/:id')
  @RequirePermission('sys:billing:read')
  getInvoice(@Param('id') id: string) { return this.invoices.getForTenant(useTenantId(), +id); }

  /** 本租户配额配置（只读；调整配额是平台运营动作） */
  @Get('quotas')
  @RequirePermission('sys:billing:read')
  listQuotas() { return this.usage.listQuotas(useTenantId()); }
}
