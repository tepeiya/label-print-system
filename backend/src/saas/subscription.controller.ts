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

  /** 当前租户的订阅详情 + 套餐 + 开通模块 */
  @Get()
  async get(@Req() req: any) {
    const tenantId = req.user?.tenantId ?? 0;
    return this.subSvc.getByTenant(tenantId);
  }

  /** 当前租户的用量概览 */
  @Get('usage')
  async usage(@Req() req: any) {
    const tenantId = req.user?.tenantId ?? 0;
    return this.subSvc.usage(tenantId);
  }
}
