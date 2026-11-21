// =============================================================================
// AgentV1Controller —— Agent API（docs/11 §11.6.3，前缀 /agent/v1）
// 类级 @Public() 跳过全局 JWT/模块/权限链（P2 PlatformAdminController 同款模式），
// 真正的门禁是 AgentTokenGuard；租户 ID 只从 token 解析，禁止请求体传入。
// P5：/approvals 由 400 占位改为正式实现（§11.7.6），高危工具无审批返回 **202 need_approval**。
// =============================================================================
import {
  BadRequestException, Body, Controller, Get, Headers, NotFoundException, Param, Post, Query, Request, Res, UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../common/public.decorator';
import { AgentTokenGuard } from './agent-token.guard';
import { AgentCtx, AgentService } from './agent.service';
import { PermissionDeniedException } from '../common/business.errors';
import { ToolsService } from './tools.service';
import { PromptsService } from './prompts.service';
import { AuditService } from '../audit/audit.module';
import { TriggerService } from '../jobs/trigger.service';
import { normalizeIngest } from '../jobs/ingest.calc';
// B3：限流响应头（成功响应从请求级上下文取最紧维度的 outcome 生成）
import { rateHeaders } from './rate.calc';
import { currentRateOutcome } from './rate.context';

@Controller('agent/v1')
@Public()
@UseGuards(AgentTokenGuard)
export class AgentV1Controller {
  constructor(
    private tools: ToolsService,
    private prompts: PromptsService,
    private agent: AgentService,
    private triggers: TriggerService,
    private audit: AuditService,
  ) {}

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
   * 外部业务事件入站（扫码即打，§10.38）：MES/ERP 扫码入库后推语义化事件
   * （source=stock.in + payload.rows），经触发器规则引擎判定命中 action=print → 自动打印。
   * - 身份/租户只从 Agent Token 解析，禁止请求体传租户；
   * - 触发打印属写操作，需 print:job:write scope；
   * - 可选 HMAC 验签（环境变量 INGEST_HMAC_SECRET，签名口径 JSON.stringify(body)）；
   * - 入队走 TriggerService.enqueue（事件指纹去重），异步由 TriggerProcessor 消费。
   */
  @Post('events/ingest')
  async ingest(
    @Request() req: { agentCtx: AgentCtx },
    @Body() body: Record<string, any>,
    @Headers('x-labelflow-timestamp') ts?: string,
    @Headers('x-labelflow-signature') sig?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const ctx = req.agentCtx;
    if (!this.agent.hasScope(ctx.scopes, 'print:job:write')) {
      throw new PermissionDeniedException(['print:job:write']);
    }
    const secret = process.env.INGEST_HMAC_SECRET || '';
    const normalized = normalizeIngest(body, {
      tenantId: ctx.tenantId,
      secret,
      tsHeader: String(ts ?? ''),
      sigHeader: String(sig ?? ''),
      rawBodyJson: JSON.stringify(body ?? {}),
    });
    if (!normalized.ok || !normalized.value) {
      throw new BadRequestException(`外部事件非法：${normalized.errors.join('；')}`);
    }
    const queued = await this.triggers.enqueue(normalized.value.event);
    // 入站审计：记录谁(client/onBehalfOf)在何时推了哪类事件，enqueue 结果一并留痕
    void this.audit.write(ctx.tenantId, 'agent.event.ingest', {
      clientId: ctx.clientId, clientName: ctx.clientName, actorType: 'agent',
      onBehalfOf: ctx.onBehalfOf, source: normalized.value.event.source,
      eventId: normalized.value.event.eventId, enqueued: queued.enqueued, jobId: queued.jobId,
      warnings: normalized.value.warnings,
    }, ctx.onBehalfOf ?? 0, 'agent_client', ctx.clientId, 'agent').catch(() => undefined);
    if (res && queued.enqueued) res.status(202);
    return {
      summary: queued.enqueued
        ? `事件 ${normalized.value.event.source} 已入站，等待规则判定后自动执行`
        : `事件已受理但入队失败（不影响主链路）：${queued.reason ?? ''}`,
      data: {
        source: normalized.value.event.source,
        eventId: normalized.value.event.eventId,
        enqueued: queued.enqueued,
        jobId: queued.jobId,
      },
      warnings: normalized.value.warnings,
      next_actions: ['print.list_jobs', 'GET /triggers/:id/deliveries'],
    };
  }

  /**
   * 租户 Prompt 库（P6.5）：系统默认 + 租户覆盖的合并结果，只含 enabled。
   * MCP server 用它渲染 prompts/list / prompts/get；一次拉全量（3–20 条），不做分页。
   */
  @Get('prompts')
  listPrompts(@Request() req: { agentCtx: AgentCtx }) {
    return this.prompts.forAgent(req.agentCtx.tenantId);
  }

  /**
   * 单条提示词（§10.37 MCP prompts/get 历史版本）：?version=N 取指定版本正文。
   * 不带 version 时等价于 forAgent 视图里按 name 找一条。
   */
  @Get('prompts/:name')
  async getPrompt(
    @Request() req: { agentCtx: AgentCtx },
    @Param('name') name: string,
    @Query('version') version?: string,
  ) {
    const v = version === undefined || version === '' ? null : Number(version);
    if (v !== null && (!Number.isFinite(v) || v < 1)) {
      throw new BadRequestException('version 必须是正整数');
    }
    if (v !== null) return this.prompts.forAgentVersion(req.agentCtx.tenantId, name, v);
    const current = await this.prompts.forAgent(req.agentCtx.tenantId);
    const def = current.find((p) => p.name === name);
    if (!def) throw new NotFoundException(`提示词 "${name}" 不存在`);
    return { ...def, versionServed: (def as any).version ?? 1, fromHistory: false };
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
