// =============================================================================
// AlertController —— 租户侧呆滞/效期预警 REST 入口（alert 模块，docs/11 §11.16）
// 模块门 alert（依赖 inventory 由订阅展开）；权限点三段式：
//   规则读写 alert:rule:configure · 事件读 alert:event:read · 处理 alert:event:ack。
// 操作人来自租户上下文（与 InventoryController 同口径）。
// =============================================================================
import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenant, useTenantId } from '../common/tenant.context';
import { AlertService } from './alert.service';
import { AlertRuleDto, QueryAlertsDto, AckAlertDto } from './dto/alert.dto';

const operator = () => `user#${useTenant().userId}`;

@Controller('inventory/alerts')
@UseGuards(TenantGuard)
@RequireModule('alert')
export class AlertController {
  constructor(private svc: AlertService) {}

  // ---------------- 规则 ----------------

  @Get('rules')
  @RequirePermission('alert:event:read')
  listRules(@Query('includeInactive') includeInactive?: string) {
    return this.svc.listRules(useTenantId(), includeInactive === 'true' || includeInactive === '1');
  }

  @Post('rules')
  @RequirePermission('alert:rule:configure')
  createRule(@Body() b: AlertRuleDto) {
    return this.svc.createRule(useTenantId(), b);
  }

  @Put('rules/:id')
  @RequirePermission('alert:rule:configure')
  updateRule(@Param('id', ParseIntPipe) id: number, @Body() b: AlertRuleDto) {
    return this.svc.updateRule(useTenantId(), id, b);
  }

  @Post('rules/:id/active')
  @RequirePermission('alert:rule:configure')
  setRuleActive(@Param('id', ParseIntPipe) id: number, @Body('active') active: boolean) {
    return this.svc.setRuleActive(useTenantId(), id, active !== false);
  }

  @Delete('rules/:id')
  @RequirePermission('alert:rule:configure')
  deleteRule(@Param('id', ParseIntPipe) id: number) {
    return this.svc.deleteRule(useTenantId(), id);
  }

  // ---------------- 扫描 / 事件 ----------------

  @Post('scan')
  @RequirePermission('alert:rule:configure')
  scan(@Body('ruleId') ruleId?: number) {
    return this.svc.scan(useTenantId(), ruleId);
  }

  @Get('events')
  @RequirePermission('alert:event:read')
  listEvents(@Query() q: QueryAlertsDto) {
    return this.svc.listEvents(useTenantId(), q);
  }

  @Get('summary')
  @RequirePermission('alert:event:read')
  summary() {
    return this.svc.summary(useTenantId());
  }

  @Post('events/:id/ack')
  @RequirePermission('alert:event:ack')
  ack(@Param('id', ParseIntPipe) id: number, @Body() b: AckAlertDto) {
    return this.svc.ackEvent(useTenantId(), id, b.status, b.note, operator());
  }
}
