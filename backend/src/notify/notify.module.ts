// 通知基建模块（B2.5）。导出 NotificationService 供 JobsModule 的定时任务发布提醒；
// 导出 ChannelRegistry 供后续接入邮件/飞书通道时注册（实现 NotificationChannel 即可）。
import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { Notification } from './notification.entity';
import { ChannelRegistry, InAppChannel } from './notification.channel';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Notification])],
  providers: [InAppChannel, ChannelRegistry, NotificationService],
  controllers: [NotificationController],
  exports: [NotificationService, ChannelRegistry],
})
export class NotifyModule {}
