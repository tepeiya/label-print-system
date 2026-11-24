// =============================================================================
// tenant-assistant.controller.ts —— 租户端 AI 助手（console 悬浮球）
//
// 与平台端 kb.controller 的分工：
//   · kb.controller（平台身份，PlatformJwtGuard，@Public）：平台运营知识库 + 平台模型配置；
//   · 本控制器（租户身份，TenantGuard）：只检索 scope='tenant' 的产品使用内容。
// 两条链路的文章严格分层：平台运营内容（套餐/用量/审计）不会经这里的接口漏给租户。
//
// 模型配置沿用 KbService.resolveAiConfig 的四级回退：
//   租户自己的默认配置 → 平台级（tenant_id=0）→ 环境变量 → 无（降级为知识库原文整理）。
// =============================================================================

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { useTenantId } from '../common/tenant.context';
import { KbService } from './kb.service';

@Controller('assistant')
@UseGuards(TenantGuard)
export class TenantAssistantController {
  constructor(private readonly kb: KbService) {}

  /** 问答：只用租户层知识库；AI 配置按租户 → 平台 → env → 无 回退 */
  @Post('ask')
  ask(@Body() dto: { question?: string; limit?: number }) {
    return this.kb.ask(String(dto?.question ?? ''), {
      tenantId: useTenantId(),
      limit: dto?.limit ? Number(dto.limit) : undefined,
      scope: 'tenant',
    });
  }

  /** 快捷提问：取租户知识库里最靠前的几篇标题（前端做成 chips） */
  @Get('suggestions')
  async suggestions(@Query('limit') limit?: string) {
    const n = Math.max(1, Math.min(8, Number(limit) || 6));
    const { items } = await this.kb.list({ scope: 'tenant', limit: 200 });
    const picked = items.filter((a) => a.category !== '入门').slice(0, n);
    const rest = items.filter((a) => a.category === '入门').slice(0, Math.max(0, n - picked.length));
    const out = [...picked, ...rest].slice(0, n).map((a) => ({
      slug: a.slug,
      title: a.title,
      category: a.category,
      /** 去掉冒号后的副标题，做成能直接点的问句 */
      question: String(a.title).split('：')[0].trim(),
    }));
    return { items: out };
  }

  /** 单篇文章全文（只允许租户层的 slug） */
  @Get('articles/:slug')
  detail(@Param('slug') slug: string) {
    return this.kb.getBySlug(String(slug), 'tenant');
  }

  /** 当前生效的 AI 来源（不回显 key），前端用来显示"已接入模型/仅知识库" */
  @Get('status')
  status() {
    return this.kb.aiStatus(useTenantId());
  }
}
