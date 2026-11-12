// =============================================================================
// AgentV1Controller —— Agent API（docs/11 §11.6.3，前缀 /agent/v1）
// 类级 @Public() 跳过全局 JWT/模块/权限链（P2 PlatformAdminController 同款模式），
// 真正的门禁是 AgentTokenGuard；租户 ID 只从 token 解析，禁止请求体传入。
// P5：/approvals 由 400 占位改为正式实现（§11.7.6），高危工具无审批返回 **202 need_approval**。
// =============================================================================
import {
  BadRequestException, Body, Controller, Get, Param, Post, Query, Request, Res, UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../common/public.decorator';
import { AgentTokenGuard } from './agent-token.guard';
import { AgentCtx } from './agent.service';
import { ToolsService } from './tools.service';
import { PromptsService } from './prompts.service';
// B3：限流响应头（成功响应从请求级上下文取最紧维度的 outcome 生成）
import { rateHeaders } from './rate.calc';
import { currentRateOutcome } from './rate.context';

@Controller('agent/v1')
@Public()
@UseGuards(AgentTokenGuard)
export class AgentV1Controller {
  constructor(private tools: ToolsService, private prompts: PromptsService) {}

  /** Agent 身份 + scope + 可访问模块（§11.11.2 验收项） */
  @Get('whoami')
  whoami(@Request() req: { agentCtx: AgentCtx }) {
    return this.tools.call(req.agentCtx, 'whoami', {});
  }

  /** 当前 token 可用的工具清单（MCP server 启动注册用） */
  @Get('tools')
  tools_(@Request() req: { agentCtx: AgentCtx }) {
    return this.tools.listTools(req.agentCtx);
  }

  /**
   * 统一工具调用入口：body = 工具入参（§11.7.3 各工具 schema）。
   * 高危工具缺有效 approval 时返回 202 + data.need_approval（响应体仍是统一信封，
   * 让模型能直接读懂「等谁、做什么、怎么重试」），且不产生任何副作用。
   */
  @Post('tools/:tool')
  async call(
    @Request() req: { agentCtx: AgentCtx },
    @Param('tool') tool: string,
    @Body() args: Record<string, any>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.tools.call(req.agentCtx, tool, args ?? {});
    // B3：成功/202 也下发 X-RateLimit-*，让客户端在触发 429 之前就能主动退避。
    // 429 由 AllExceptionsFilter 从异常自带 headers 下发（异常在拿到 result 前就抛出）。
    const outcome = currentRateOutcome();
    if (outcome) {
      for (const [k, v] of Object.entries(rateHeaders(outcome))) res.setHeader(k, v);
    }
    if (result?.data?.need_approval === true) res.status(202);
    return result;
  }

  /**
   * 租户 Prompt 库（P6.5）：系统默认 + 租户覆盖的合并结果，只含 enabled。
   * MCP server 用它渲染 prompts/list / prompts/get；一次拉全量（3–20 条），不做分页。
   */
  @Get('prompts')
  listPrompts(@Request() req: { agentCtx: AgentCtx }) {
    return this.prompts.forAgent(req.agentCtx.tenantId);
  }

  /** 只读资源（labelflow://templates/{id}、labelflow://inventory/stock/{ref}） */
  @Get('resources/:kind/:id')
  resource(@Request() req: { agentCtx: AgentCtx }, @Param('kind') kind: string, @Param('id') id: string) {
    return this.tools.resource(req.agentCtx, kind, id);
  }

  /** 主动为高危工具创建审批单（§11.6.3 POST /agent/v1/approvals） */
  @Post('approvals')
  createApproval(@Request() req: { agentCtx: AgentCtx }, @Body() body: Record<string, any>) {
    const tool = String(body?.tool ?? '').trim();
    if (!tool) throw new BadRequestException('需要 tool（高危工具名，如 inventory.adjust）');
    return this.tools.requestApproval(req.agentCtx, tool, body?.args ?? {});
  }

  /** 查询审批状态（§11.6.3 GET /agent/v1/approvals/:id） */
  @Get('approvals/:id')
  getApproval(@Request() req: { agentCtx: AgentCtx }, @Param('id') id: string) {
    if (!/^\d+$/.test(String(id))) throw new BadRequestException('approval id 必须是数字');
    return this.tools.getApproval(req.agentCtx, Number(id));
  }

  /** 自己的审批单列表（模型轮询用；status 缺省 pending） */
  @Get('approvals')
  listApprovals(
    @Request() req: { agentCtx: AgentCtx },
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.tools.listOwnApprovals(
      req.agentCtx, String(status ?? 'pending'), Number(page) || 1, Number(pageSize) || 20,
    );
  }
}
