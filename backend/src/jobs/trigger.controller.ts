// P8.1 触发器管理端点（租户 JWT）
// 说明：V1 未接入订阅模块 gating（menu.catalog 没有 automation 模块码，挂 ModuleGuard 会把所有租户 4031 拦死）。
// 权限用角色 + 后续 P8.3 统一补 permission 码；当前写操作仅 admin/operator 可做，读操作登录即可。
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Roles, RoleName } from '../common/roles.guard';
import { TenantGuard } from '../common/tenant.guard';
import { TriggerTestDto, TriggerUpsertDto } from './dto/trigger.dto';
import { TriggerService } from './trigger.service';

const WRITE: RoleName[] = ['admin', 'operator'];

@Controller('triggers')
@UseGuards(TenantGuard)
export class TriggerController {
  constructor(private svc: TriggerService) {}

  @Get()
  list() { return this.svc.list(); }

  @Get(':id')
  get(@Param('id') id: number) { return this.svc.get(+id); }

  /** 投递历史：追溯一次事件到底发出去没有 */
  @Get(':id/deliveries')
  deliveries(@Param('id') id: number, @Query('limit') limit?: string) {
    return this.svc.deliveriesOf(+id, limit ? +limit : 50);
  }

  @Roles(...WRITE)
  @Post()
  create(@Body() b: TriggerUpsertDto) { return this.svc.create(b); }

  @Roles(...WRITE)
  @Patch(':id')
  update(@Param('id') id: number, @Body() b: Partial<TriggerUpsertDto>) { return this.svc.update(+id, b); }

  @Roles(...WRITE)
  @Delete(':id')
  remove(@Param('id') id: number) { return this.svc.remove(+id); }

  /** 试跑：只返回命中计划，不执行打印/Webhook（dryRun） */
  @Roles(...WRITE)
  @Post(':id/test')
  test(@Param('id') id: number, @Body() b: TriggerTestDto = new TriggerTestDto()) { return this.svc.test(+id, b); }
}
