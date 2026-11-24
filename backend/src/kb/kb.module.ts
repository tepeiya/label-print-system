import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KbArticle, KbAssistantLog } from './kb.entity';
import { AiModelConfig } from '../entities/ai-template.entity';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';
import { PlatformJwtGuard } from '../saas/platform-admin/platform-jwt.guard';

/**
 * 平台端知识库 + AI 助手。
 * 独立成模块的理由：它不是租户业务（无 tenant_id、无模块订阅），
 * 混进 saas 会让"平台身份 / 租户身份"的边界更难读。
 */
@Module({
  imports: [TypeOrmModule.forFeature([KbArticle, KbAssistantLog, AiModelConfig])],
  controllers: [KbController],
  providers: [KbService, PlatformJwtGuard],
  exports: [KbService],
})
export class KbModule {}
