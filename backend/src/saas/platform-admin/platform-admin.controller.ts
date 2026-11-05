import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards, Request } from '@nestjs/common';
import { Public } from '../../common/public.decorator';
import { PlatformJwtGuard } from './platform-jwt.guard';
import { PlatformAdminService } from './platform-admin.service';
import { AddModuleDto, FeatureFlagDto, PlatformLoginDto, ProvisionTenantDto, UpsertPlanDto } from '../dto/platform.dto';
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
  async setFlag(@Param('id') id: string, @Body() body: FeatureFlagDto, @Request() req: any) {
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
