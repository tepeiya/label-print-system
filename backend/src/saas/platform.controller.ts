// 平台控制器 —— 平台视角（admin only）：全量模块/套餐/租户开通情况
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles, RoleName } from '../common/roles.guard';
import { ModulesService } from './modules.service';
import { PermissionsService } from './permissions.service';
import { SubscriptionService } from './subscription.service';

@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin' as RoleName)
export class PlatformController {
  constructor(
    private modSvc: ModulesService,
    private permsSvc: PermissionsService,
    private subSvc: SubscriptionService,
  ) {}

  /** 全量模块目录 */
  @Get('modules')
  listModules() { return this.modSvc.listAll(); }

  /** 全量套餐（含每个套餐含哪些模块） */
  @Get('plans')
  listPlans() { return this.modSvc.listPlans(); }

  /** 全量权限字典 */
  @Get('permissions')
  listPermissions() { return this.permsSvc.listAll(); }

  /** 某租户的订阅详情 + 开通模块（给平台后台看） */
  @Get('tenants/:id/subscription')
  async tenantSubscription(@Param('id') id: string) {
    return this.subSvc.getByTenant(+id);
  }

  /** 某租户已开通模块详情 */
  @Get('tenants/:id/modules')
  async tenantModules(@Param('id') id: string) {
    return this.modSvc.listTenantModules(+id);
  }
}
