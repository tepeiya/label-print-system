// =============================================================================
// NotificationController —— 租户侧站内信（B2.5）
// 租户 ID 只从 TenantGuard 注入的上下文取，禁止前端传参决定数据范围。
// V1 取舍：user_id IS NULL 为全租户广播，read_at 是单值 → 一人标记即全租户已读。
// 逐用户已读位图（notification_reads）留待 V2，已在 DDL 注释标注。
// =============================================================================
import { Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { useTenant, useTenantId } from '../common/tenant.context';
import { NotificationService } from './notification.service';

@Controller('notifications')
@UseGuards(TenantGuard)
export class NotificationController {
  constructor(private notifications: NotificationService) {}

  /** GET /api/v1/notifications?unread=1&page=1&pageSize=20 */
  @Get()
  list(
    @Query('unread') unread?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const tenantId = useTenantId();
    const userId = useTenant().userId;
    return this.notifications.list(tenantId, userId, {
      unreadOnly: ['1', 'true', 'yes'].includes(String(unread ?? '').toLowerCase()),
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 20,
    });
  }

  /** 未读角标 */
  @Get('unread-count')
  async unreadCount() {
    return { count: await this.notifications.unreadCount(useTenantId(), useTenant().userId) };
  }

  @Post(':id/read')
  async markRead(@Param('id', ParseIntPipe) id: number) {
    return { changed: await this.notifications.markRead(useTenantId(), useTenant().userId, id) };
  }

  @Post('read-all')
  async markAllRead() {
    return { changed: await this.notifications.markAllRead(useTenantId(), useTenant().userId) };
  }
}
