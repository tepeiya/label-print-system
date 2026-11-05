import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards, Request, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/public.decorator';
import { PlatformJwtGuard } from './platform-jwt.guard';
import { PlatformAdminService } from './platform-admin.service';
import { TenantDataService } from './tenant-data.service';
import { PlatformAuditService } from './platform-audit.service';
import { BrandingService } from '../branding/branding.service';
import { AddModuleDto, CreateInvoiceDto, CreatePaymentDto, FeatureFlagDto, IssueInvoiceDto, PlatformLoginDto, ProvisionTenantDto, UpsertPlanDto, UpsertQuotaDto } from '../dto/platform.dto';
import { TenantConfigService } from '../tenant-config.service';
import { SubscriptionService } from '../subscription.service';
import { ModulesService } from '../modules.service';

/**
 * 平台运营后台 API（P2，docs/11 §11.6.2）。
 * 与 P0 的 PlatformController（目录查询，租户 admin 可读）分开：
 * 这里全部要求 scope='platform' 的运营 JWT。类上 @Public() 是为了跳过全局租户守卫链，
 * 真正的门禁是 PlatformJwtGuard。
 */
@Controller('platform')
@Public()
@UseGuards(PlatformJwtGuard)
export class PlatformAdminController {
  constructor(
    private svc: PlatformAdminService,
    private configSvc: TenantConfigService,
    private subSvc: SubscriptionService,
    private modSvc: ModulesService,
    private dataSvc: TenantDataService,
    private brandingSvc: BrandingService,
    private platformAudit: PlatformAuditService,
  ) {}

  // ---------- 租户 ----------

  /** 租户列表（含订阅状态、模块数、用户数、试用到期、退订时间） */
  @Get('tenants')
  listTenants() { return this.svc.listTenants(); }

  /** 开通租户（同 P0 语义，单事务） */
  @Post('tenants')
  provision(@Body() dto: ProvisionTenantDto) { return this.svc.provision(dto); }

  /** 停用 / 恢复 */
  @Post('tenants/:id/suspend')
  suspend(@Param('id') id: string, @Request() req: any) {
    return this.svc.setEnabled(req.platformUser, +id, false);
  }

  @Post('tenants/:id/resume')
  resume(@Param('id') id: string, @Request() req: any) {
    return this.svc.setEnabled(req.platformUser, +id, true);
  }

  /** 退订：写 canceled_at，90 天保留期开始（D12） */
  @Post('tenants/:id/cancel')
  cancel(@Param('id') id: string) { return this.svc.cancel(+id); }

  /** 加购单模块（D1：自动补齐前置模块） */
  @Post('tenants/:id/modules')
  addModule(@Param('id') id: string, @Body() body: AddModuleDto) {
    return this.svc.addModule(+id, body.moduleCode, body.source ?? 'addon');
  }

  /** 停用模块（被依赖则拒绝） */
  @Delete('tenants/:id/modules/:code')
  disableModule(@Param('id') id: string, @Param('code') code: string) {
    return this.svc.disableModule(+id, code);
  }

  /** 某租户的订阅详情 + 开通模块（P0 契约保留，前端「查看已开模块」抽屉用） */
  @Get('tenants/:id/subscription')
  tenantSubscription(@Param('id') id: string) { return this.subSvc.getByTenant(+id); }

  @Get('tenants/:id/modules')
  tenantModules(@Param('id') id: string) { return this.modSvc.listTenantModules(+id); }

  // ---------- 功能开关（D7 灰度，从 P0 的租户 admin JWT 迁到平台身份） ----------

  @Get('tenants/:id/flags')
  tenantFlags(@Param('id') id: string) { return this.configSvc.featuresFor(+id); }

  @Put('tenants/:id/flags')
  async setFlag(@Param('id') id: string, @Body() body: FeatureFlagDto) {
    const row = await this.configSvc.setFlag(+id, body.key, !!body.enabled, body.rollout ?? {});
    return { tenantId: +id, key: row.key, enabled: row.enabled };
  }

  // ---------- 套餐配置 ----------

  @Get('plans')
  listPlans() { return this.svc.listPlans(); }

  /** 更新套餐：基本信息 + 全量替换套餐内模块 */
  @Put('plans/:code')
  updatePlan(@Param('code') code: string, @Body() dto: UpsertPlanDto, @Request() req: any) {
    return this.svc.updatePlan(req.platformUser, code, dto);
  }

  // ---------- 用量看板 / 平台审计 ----------

  @Get('usage')
  usage() { return this.svc.usage(); }

  @Get('audit')
  audit() { return this.svc.listAudit(); }

  // ---------- P3 计费：配额 / 原始用量（§11.7） ----------

  @Get('tenants/:id/quotas')
  tenantQuotas(@Param('id') id: string) { return this.svc.tenantQuotas(+id); }

  @Put('tenants/:id/quotas/:meter')
  setTenantQuota(@Param('id') id: string, @Param('meter') meter: string, @Body() dto: UpsertQuotaDto, @Request() req: any) {
    return this.svc.setTenantQuota(req.platformUser, +id, meter, dto);
  }

  @Delete('tenants/:id/quotas/:meter')
  removeTenantQuota(@Param('id') id: string, @Param('meter') meter: string, @Request() req: any) {
    return this.svc.removeTenantQuota(req.platformUser, +id, meter);
  }

  /** 某租户的本月聚合 + 原始计量明细（对账入口） */
  @Get('tenants/:id/meters')
  tenantMeters(
    @Param('id') id: string,
    @Query('meter') meter?: string, @Query('from') from?: string, @Query('to') to?: string,
    @Query('page') page?: string, @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.tenantUsageDetail(+id, {
      meter: meter || undefined, from: from || undefined, to: to || undefined,
      page: page ? +page : undefined, pageSize: pageSize ? +pageSize : undefined,
    });
  }

  // ---------- P3 计费：账单 / 收款（D5 手动登记） ----------

  @Get('invoices')
  listInvoices(
    @Query('tenantId') tenantId?: string, @Query('status') status?: string,
    @Query('page') page?: string, @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.listInvoices({
      tenantId: tenantId ? +tenantId : undefined, status: status || undefined,
      page: page ? +page : undefined, pageSize: pageSize ? +pageSize : undefined,
    });
  }

  @Post('invoices')
  createInvoice(@Body() dto: CreateInvoiceDto, @Request() req: any) {
    return this.svc.createInvoice(req.platformUser, dto);
  }

  @Get('invoices/:id')
  invoiceDetail(@Param('id') id: string) { return this.svc.invoiceDetail(+id); }

  @Post('invoices/:id/issue')
  issueInvoice(@Param('id') id: string, @Body() dto: IssueInvoiceDto, @Request() req: any) {
    return this.svc.issueInvoice(req.platformUser, +id, dto.dueDays ?? 15);
  }

  @Post('invoices/:id/void')
  voidInvoice(@Param('id') id: string, @Request() req: any) {
    return this.svc.voidInvoice(req.platformUser, +id);
  }

  @Post('invoices/:id/payments')
  registerPayment(@Param('id') id: string, @Body() dto: CreatePaymentDto, @Request() req: any) {
    return this.svc.registerPayment(req.platformUser, +id, dto);
  }

  // ---------- 租户数据导出 / 硬删（P6，docs/11 D12 保留期 + §11.2 RLS 兜底）----------

  /** D12 看板：已退订租户的保留期剩余天数（daysLeft<=0 才算可硬删，warn=进入 7 天提醒） */
  @Get('tenants/retention')
  retention() { return this.dataSvc.retention(); }

  /** 全量导出该租户业务数据 → gzip 落 tenant_backups(kind=export)，返回摘要 */
  @Post('tenants/:id/export')
  exportTenant(@Param('id') id: string, @Request() req: any) {
    if (!/^\d+$/.test(String(id))) throw new BadRequestException('tenant id 必须是数字');
    return this.dataSvc.exportTenant(+id, req.platformUser);
  }

  /** 该租户的导出件/备份清单（含租户自己手工备份的） */
  @Get('tenants/:id/exports')
  listExports(@Param('id') id: string) {
    if (!/^\d+$/.test(String(id))) throw new BadRequestException('tenant id 必须是数字');
    return this.dataSvc.listBackups(+id);
  }

  /**
   * 下载导出件（gzip 原文件）。
   * 注意这里用 **@Res() 不带 passthrough**：passthrough 下 Nest 仍会走 ResponseInterceptor
   * 再发一次 JSON 信封 → ERR_HTTP_HEADERS_SENT 直接把进程打挂（实跑踩过）。
   */
  @Get('tenants/:id/exports/:exportId/download')
  async downloadExport(
    @Param('id') id: string, @Param('exportId') exportId: string,
    @Request() req: any, @Res() res: Response,
  ) {
    if (!/^\d+$/.test(String(id)) || !/^\d+$/.test(String(exportId))) throw new BadRequestException('id 必须是数字');
    const file = await this.dataSvc.downloadBackup(+id, +exportId, req.platformUser);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    res.send(file.buffer);
  }

  /**
   * 硬删该租户全部业务数据（不可逆）。闸门在 TenantDataService 里：
   * confirm 必须逐字等于租户 code，且要么已过 D12 保留期、要么显式 force=true。
   */
  @Post('tenants/:id/purge')
  purgeTenant(@Param('id') id: string, @Request() req: any, @Body() body: { confirm?: string; force?: boolean }) {
    if (!/^\d+$/.test(String(id))) throw new BadRequestException('tenant id 必须是数字');
    return this.dataSvc.purgeTenant(+id, req.platformUser, body ?? {});
  }

  // ---------- 白标（D6）：平台侧强制校验域名 ----------

  /** 列出租户登记过的域名（运营工单时用，未校验的域名不参与解析） */
  @Get('tenants/:id/domains')
  async listDomains(@Param('id') id: string) {
    if (!/^\d+$/.test(String(id))) throw new BadRequestException('tenant id 必须是数字');
    return { tenantId: +id, items: await this.brandingSvc.listDomains(+id) };
  }

  /**
   * 运营强制把域名标记为已校验（客户搞不定 DNS 时的工单通道）。
   * ⚠️ 这是**绕过 DNS 所有权证明**的动作，只能由平台运营执行，且必须留平台审计。
   */
  @Post('tenants/:id/domains/:domainId/verify')
  async forceVerifyDomain(@Param('id') id: string, @Param('domainId') domainId: string, @Request() req: any) {
    if (!/^\d+$/.test(String(id)) || !/^\d+$/.test(String(domainId))) {
      throw new BadRequestException('id 必须是数字');
    }
    const out = await this.brandingSvc.forceVerifyByPlatform(+id, +domainId);
    await this.platformAudit.write(req.platformUser, 'platform.tenant.domain.verify',
      { tenantId: +id, domain: out.domain, verified: out.verified, forced: !!out.forced, already: !!out.already },
      'tenant_domain', +domainId);
    return out;
  }
}

/** 平台登录（唯一不需要平台 token 的运营接口） */
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private svc: PlatformAdminService) {}

  @Public()
  @Post('login')
  login(@Body() dto: PlatformLoginDto) {
    return this.svc.login(dto.username, dto.password);
  }
}
