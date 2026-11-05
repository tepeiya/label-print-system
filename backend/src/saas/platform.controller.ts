// 平台控制器 —— 平台视角（admin only）：租户开通 / 加购 / 停用 / 退订 / 灰度开关 + 目录查询
// §11.6.2 的 /platform/v1 前缀在这里仍挂在 /api/v1 下（P0 与租户侧共用 JWT），
// 真正的平台身份体系（platform_users + 独立 JWT scope）是 P2 的活，见 docs/10 §10.15.7 未做清单。
import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles, RoleName } from '../common/roles.guard';
import { ModulesService } from './modules.service';
import { PermissionsService } from './permissions.service';
import { SubscriptionService } from './subscription.service';
import { ProvisionService } from './provision.service';
import { TenantConfigService } from './tenant-config.service';
import { AddModuleDto, FeatureFlagDto, ProvisionTenantDto } from './dto/platform.dto';

@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin' as RoleName)
export class PlatformController {
  constructor(
    private modSvc: ModulesService,
    private permsSvc: PermissionsService,
    private subSvc: SubscriptionService,
    private provisionSvc: ProvisionService,
    private configSvc: TenantConfigService,
  ) {}

  // ---------- 目录 ----------

  /** 全量模块目录（含依赖关系） */
  @Get('modules')
  listModules() { return this.modSvc.listAll(); }

  /** 全量套餐（含每个套餐含哪些模块 + 依赖补齐后的有效模块） */
  @Get('plans')
  listPlans() { return this.modSvc.listPlans(); }

  /** 全量权限字典 */
  @Get('permissions')
  listPermissions() { return this.permsSvc.listAll(); }

  // ---------- 租户 / 订阅 ----------

  /** 租户列表（含订阅状态、模块数、用户数、试用到期、退订时间） */
  @Get('tenants')
  listTenants() { return this.provisionSvc.listTenants(); }

  /** 开通租户（D4：不做自助注册，只能运营调用；单事务，见 docs/11 §11.15.1 约束 3） */
  @Post('tenants')
  provision(@Body() dto: ProvisionTenantDto) { return this.provisionSvc.provision(dto); }

  /** 某租户的订阅详情 + 开通模块 */
  @Get('tenants/:id/subscription')
  async tenantSubscription(@Param('id') id: string) {
    return this.subSvc.getByTenant(+id);
  }

  /** 某租户已开通模块详情 */
  @Get('tenants/:id/modules')
  async tenantModules(@Param('id') id: string) {
    return this.modSvc.listTenantModules(+id);
  }

  /** 加购单模块（D1：套餐外单独开通，自动补齐前置模块） */
  @Post('tenants/:id/modules')
  addModule(@Param('id') id: string, @Body() body: AddModuleDto) {
    return this.provisionSvc.addModule(+id, body?.moduleCode, body?.source ?? 'addon');
  }

  /** 停用模块（被依赖则拒绝，§11.3.4） */
  @Delete('tenants/:id/modules/:code')
  disableModule(@Param('id') id: string, @Param('code') code: string) {
    return this.provisionSvc.disableModule(+id, code);
  }

  /** 退订：写 canceled_at，D12 的 90 天保留期从此开始 */
  @Post('tenants/:id/cancel')
  cancel(@Param('id') id: string) { return this.provisionSvc.cancel(+id); }

  // ---------- 功能开关（D7 灰度） ----------

  /** 某租户的功能开关 */
  @Get('tenants/:id/flags')
  async tenantFlags(@Param('id') id: string) {
    return this.configSvc.featuresFor(+id);
  }

  /** 改功能开关，例如 { key: 'agent.print.submit', enabled: true } */
  @Put('tenants/:id/flags')
  async setFlag(
    @Param('id') id: string,
    @Body() body: FeatureFlagDto,
  ) {
    const tenantId = +id;
    const row = await this.configSvc.setFlag(tenantId, body.key, !!body.enabled, body.rollout ?? {});
    return { tenantId, key: row.key, enabled: row.enabled };
  }
}
