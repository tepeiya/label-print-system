// P8.3 企业治理端点（租户 JWT）
// 与 P8.1 触发器端点同口径：V1 未接入订阅模块 gating（menu.catalog 没有 governance 模块码，
// 挂 ModuleGuard 会把所有租户 4031 拦死），因此只用 TenantGuard + Roles 做边界；
// 细粒度权限由状态机 transitionVerdict 按角色再判一次（operator 不能审批）。
import { Body, Controller, Delete, Get, Param, Put, Post, Query, UseGuards } from '@nestjs/common';
import { Roles, RoleName } from '../common/roles.guard';
import { TenantGuard } from '../common/tenant.guard';
import { GovernanceService } from './governance.service';
import { ReviewActionDto, SavePolicyDto } from './dto/governance.dto';

const ADMIN: RoleName[] = ['admin'];
const WRITE: RoleName[] = ['admin', 'operator'];

@Controller('governance')
@UseGuards(TenantGuard)
export class GovernanceController {
  constructor(private svc: GovernanceService) {}

  /** 当前租户治理策略（缺省返回全宽松默认策略，前端据此决定是否显示审批/水印开关） */
  @Get('policy')
  getPolicy() { return this.svc.getPolicy(); }

  @Roles(...ADMIN)
  @Put('policy')
  savePolicy(@Body() b: SavePolicyDto) { return this.svc.savePolicy(b.policy); }

  /** 模板治理详情：状态 + 锁定版本 + 最近审批历史 */
  @Get('templates/:id')
  detail(@Param('id') id: number) { return this.svc.detail(+id); }

  @Get('templates/:id/reviews')
  reviews(@Param('id') id: number) { return this.svc.reviewsOf(+id); }

  /**
   * 审批动作：submit / approve / reject / request_change / archive / publish。
   * 合法迁移与角色由状态机判定，越权与非法迁移返回 403 并附中文原因。
   */
  @Roles(...WRITE)
  @Post('templates/:id/review')
  review(@Param('id') id: number, @Body() b: ReviewActionDto) {
    return this.svc.review(+id, b.action, b.comment, b.publishedVersion);
  }

  /** 运维：防重登记最近记录 */
  @Get('dedupe')
  dedupe(@Query('limit') limit?: string) {
    return this.svc.listDedupe(limit ? +limit : 50);
  }

  /** 运维：清理过期防重登记（默认 30 天） */
  @Roles(...ADMIN)
  @Delete('dedupe')
  prune(@Query('beforeDays') beforeDays?: string) {
    return this.svc.pruneDedupe(beforeDays ? +beforeDays : 30);
  }
}
