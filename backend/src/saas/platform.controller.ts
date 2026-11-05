// 平台目录查询：console（租户 admin）和 apps/platform（平台运营）都要读，
// P2 起挂在混合守卫上（platform-or-admin.guard.ts）。运营写接口在 platform-admin/。
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ModulesService } from './modules.service';
import { PermissionsService } from './permissions.service';
import { PlatformOrAdminGuard } from './platform-admin/platform-or-admin.guard';

@Controller('platform')
@UseGuards(PlatformOrAdminGuard)
export class PlatformController {
  constructor(
    private modSvc: ModulesService,
    private permsSvc: PermissionsService,
  ) {}

  /** 全量模块目录（含依赖关系） */
  @Get('modules')
  listModules() { return this.modSvc.listAll(); }

  /** 全量套餐（含每个套餐含哪些模块 + 依赖补齐后的有效模块） */
  @Get('plans')
  listPlans() { return this.modSvc.listPlans(); }

  /** 全量权限字典 */
  @Get('permissions')
  listPermissions() { return this.permsSvc.listAll(); }
}
