// =============================================================================
// AgentV1Controller —— Agent API（docs/11 §11.6.3，前缀 /agent/v1）
// 类级 @Public() 跳过全局 JWT/模块/权限链（P2 PlatformAdminController 同款模式），
// 真正的门禁是 AgentTokenGuard；租户 ID 只从 token 解析，禁止请求体传入。
// =============================================================================
import {
  BadRequestException, Body, Controller, Get, Param, Post, Request, UseGuards,
} from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { AgentTokenGuard } from './agent-token.guard';
import { AgentCtx } from './agent.service';
import { ToolsService } from './tools.service';

@Controller('agent/v1')
@Public()
@UseGuards(AgentTokenGuard)
export class AgentV1Controller {
  constructor(private tools: ToolsService) {}

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

  /** 统一工具调用入口：body = 工具入参（§11.7.3 各工具 schema） */
  @Post('tools/:tool')
  call(
    @Request() req: { agentCtx: AgentCtx },
    @Param('tool') tool: string,
    @Body() args: Record<string, any>,
  ) {
    return this.tools.call(req.agentCtx, tool, args ?? {});
  }

  /** 只读资源（labelflow://templates/{id}、labelflow://inventory/stock/{ref}） */
  @Get('resources/:kind/:id')
  resource(@Request() req: { agentCtx: AgentCtx }, @Param('kind') kind: string, @Param('id') id: string) {
    return this.tools.resource(req.agentCtx, kind, id);
  }

  // 审批流（§11.7.6）与租户 JWT 版 approvals 在 P5 接线；这里先给明确 400，不静默 404
  @Post('approvals')
  createApproval() {
    throw new BadRequestException('审批流将在后续版本开放（P5：高危工具 need_approval 链路）');
  }

  @Get('approvals/:id')
  getApproval() {
    throw new BadRequestException('审批流将在后续版本开放（P5：approval 状态查询）');
  }
}
