import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KbArticle, KbAssistantLog } from './kb.entity';
import { AiModelConfig } from '../entities/ai-template.entity';
import { KbController } from './kb.controller';
import { TenantAssistantController } from './tenant-assistant.controller';
import { KbService } from './kb.service';
import { PlatformJwtGuard } from '../saas/platform-admin/platform-jwt.guard';

/**
 * 知识库 + AI 助手（平台端 + 租户端各一个控制器，按 scope 分层）。
 * 平台端：
 * 独立成模块的理由：它不是租户业务（无 tenant_id、无模块订阅），
 * 混进 saas 会让"平台身份 / 租户身份"的边界更难读。
 */
@Module({
  imports: [TypeOrmModule.forFeature([KbArticle, KbAssistantLog, AiModelConfig])],
  // 两个控制器共用同一个 KbService，但身份链完全不同（平台 PlatformJwtGuard / 租户 TenantGuard）
  controllers: [KbController, TenantAssistantController],
  providers: [KbService, PlatformJwtGuard],
  exports: [KbService],
})
export class KbModule {}
