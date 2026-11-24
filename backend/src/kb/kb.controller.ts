// 平台端知识库与 AI 助手接口（D6）
//
// 只对平台身份开放：类上 @Public() 跳过全局租户守卫链，再挂 PlatformJwtGuard，
// 所以租户 token 调不进来 —— 这正好满足"知识库只在平台端显示"的要求。
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { PlatformJwtGuard } from '../saas/platform-admin/platform-jwt.guard';
import { KbService } from './kb.service';

@Controller('kb')
@Public()
@UseGuards(PlatformJwtGuard)
export class KbController {
  constructor(private readonly svc: KbService) {}

  /** 文章列表（可按分类/关键词过滤），列表不带全文 */
  @Get('articles')
  list(@Query() q: any) {
    return this.svc.list({
      category: q?.category, keyword: q?.keyword, limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  /** 分类及每类文章数（左侧目录用） */
  @Get('categories')
  categories() {
    return this.svc.categories();
  }

  /** 单篇文章全文 */
  @Get('articles/:slug')
  detail(@Param('slug') slug: string) {
    return this.svc.getBySlug(slug);
  }

  /** 检索（给"搜索框"用；助手内部也走同一个打分函数） */
  @Get('search')
  search(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.svc.search(q, limit ? Number(limit) : 5);
  }

  /** AI 助手问答：租户配置 > 平台配置 > 环境变量 > 知识库降级 */
  @Post('assistant/ask')
  ask(@Body() dto: { question?: string; tenantId?: number; limit?: number }) {
    return this.svc.ask(String(dto?.question ?? ''), {
      tenantId: dto?.tenantId ? Number(dto.tenantId) : null,
      limit: dto?.limit ? Number(dto.limit) : undefined,
    });
  }

  /** 当前生效的 AI 配置来源（前端用来显示"已接入模型/仅知识库"） */
  @Get('assistant/status')
  status(@Query('tenantId') tenantId?: string) {
    return this.svc.aiStatus(tenantId ? Number(tenantId) : null);
  }

  /** 保存平台级 AI 配置（写 ai_model_configs 的 tenant_id=0；不回显 key） */
  @Post('assistant/config')
  saveConfig(@Body() dto: any) {
    return this.svc.savePlatformAi(dto ?? {});
  }
}
