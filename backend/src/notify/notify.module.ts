// 通知基建模块（B2.5 + 通知通道扩展）。导出 NotificationService 供 JobsModule 发布提醒；
// 导出 ChannelRegistry 供扩展。启动时按环境配置注册邮件/飞书/短信三种外部通道
// （站内信是必须成功的默认通道，外部通道 best-effort，失败由 NotificationService 兜底）。
import { Inject, Module, OnModuleInit } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { Notification } from './notification.entity';
import { ChannelRegistry, InAppChannel } from './notification.channel';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NOTIFY_CONFIG, NotifyConfig, notifyConfigFromEnv } from './notify.config';
import { buildExternalChannels } from './external-channels';

@Module({
  imports: [TypeOrmModule.forFeature([Notification])],
  providers: [
    InAppChannel,
    ChannelRegistry,
    NotificationService,
    { provide: NOTIFY_CONFIG, useFactory: () => notifyConfigFromEnv() },
  ],
  controllers: [NotificationController],
  exports: [NotificationService, ChannelRegistry],
})
export class NotifyModule implements OnModuleInit {
  constructor(
    private registry: ChannelRegistry,
    @Inject(NOTIFY_CONFIG) private cfg: NotifyConfig,
  ) {}

  onModuleInit(): void {
    for (const channel of buildExternalChannels(this.cfg)) {
      this.registry.register(channel);
    }
  }
}
