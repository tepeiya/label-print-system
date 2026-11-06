// =============================================================================
// PromptsController —— 租户侧「Prompt 库」（P6.5，docs/11 §11.7.5 / docs/10 §10.26）
//
// 路由 /agent-prompts（与 /agents 分开：PRM 权限点不同，页面也不同）。
//   GET    /agent-prompts                 合并视图（system + custom，含已禁用项）
//   GET    /agent-prompts/:name           单条（编辑器回填）
//   PUT    /agent-prompts/:name           新建自定义 / 覆盖同名系统提示词
//   DELETE /agent-prompts/:name           删除租户行：系统同名回落默认，自定义彻底删除
//   POST   /agent-prompts/:name/preview   用参数渲染正文（与 Agent 的 prompts/get 同一套纯函数）
//
// 权限：sys:prompt:manage（admin / tenant_admin）。改的是 Agent 对全公司说话的模板，
// 和品牌配置同级，不下放给 manager / viewer。
// 模块：agent（BASIC 套餐没有 Agent，接口自然 4031，与 /agents 一致）。
// =============================================================================
import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Request, UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenantId } from '../common/tenant.context';
import { AuditService } from '../audit/audit.module';
import { PromptsService } from './prompts.service';
import { UpsertPromptDto } from './dto/agent.dto';

@Controller('agent-prompts')
@UseGuards(TenantGuard)
@RequireModule('agent')
@RequirePermission('sys:prompt:manage')
export class PromptsController {
  constructor(private prompts: PromptsService, private audit: AuditService) {}

  @Get()
  list() {
    return this.prompts.list(useTenantId());
  }

  @Get(':name')
  get(@Param('name') name: string) {
    return this.prompts.get(useTenantId(), name);
  }

  /** 同名 = 覆盖系统默认（source 变 custom）；未改系统行时这里就创建覆盖行 */
  @Put(':name')
  async upsert(@Request() req: any, @Param('name') name: string, @Body() dto: UpsertPromptDto) {
    const tenantId = useTenantId();
    const row = await this.prompts.upsert(tenantId, name, dto, req.user?.sub ?? null);
    await this.audit.write(tenantId, 'agent.prompt.save', {
      name: row.name, title: row.title, enabled: row.enabled, overridden: row.overridden,
      arguments: (row.arguments ?? []).map((a: any) => a?.name).filter(Boolean),
    }, req.user?.sub, 'agent_prompt');
    return row;
  }

  /** 删除租户行：系统同名 → revertedToSystem=true（回落默认）；自定义 → 彻底消失 */
  @Delete(':name')
  async remove(@Request() req: any, @Param('name') name: string) {
    const tenantId = useTenantId();
    const res = await this.prompts.remove(tenantId, name);
    await this.audit.write(tenantId, 'agent.prompt.delete', res, req.user?.sub, 'agent_prompt');
    return res;
  }

  /** 渲染预览：缺必填参数 400，错误信息直接可读 */
  @Post(':name/preview')
  @HttpCode(200)
  preview(@Param('name') name: string, @Body() body: { arguments?: Record<string, any> } | undefined) {
    return this.prompts.preview(useTenantId(), name, body?.arguments ?? {});
  }
}
