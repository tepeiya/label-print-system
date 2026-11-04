// 订阅控制器 —— 租户视角：看自己的套餐和用量
import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { SubscriptionService } from '../saas/subscription.service';
import { ModulesService } from '../saas/modules.service';

@Controller('subscription')
@UseGuards(JwtAuthGuard)
export class SubscriptionController {
  constructor(
    private subSvc: SubscriptionService,
    private modSvc: ModulesService,
  ) {}

  /**
   * 当前租户的订阅详情 + 套餐 + 开通模块
   * P1：附带 moduleDetails（模块名/图标/说明/是否核心）。原来只回 code 数组，
   * 前端订阅页只能把 code 当名字显示。modules 字段保持不变，避免动已有断言。
   */
  @Get()
  async get(@Req() req: any) {
    const tenantId = req.user?.tenantId ?? 0;
    const data: any = await this.subSvc.getByTenant(tenantId);
    data.moduleDetails = await this.modSvc.listTenantModules(tenantId);
    return data;
  }

  /** 当前租户的用量概览 */
  @Get('usage')
  async usage(@Req() req: any) {
    const tenantId = req.user?.tenantId ?? 0;
    return this.subSvc.usage(tenantId);
  }
}
