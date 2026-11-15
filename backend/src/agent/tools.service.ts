// =============================================================================
// ToolsService —— /agent/v1 工具统一 dispatch（docs/11 §11.6.3 / §11.7.2 / §11.7.4 / §11.7.6）
// P5 检查顺序（验收 M 段依赖）：
//   scope（4032）→ 订阅模块（4031）→ 执行器可用性 → D7 功能开关（4035）
//   → 限流（4037/429）→ agent_calls 配额（4033）→ 幂等重放 → 审批（4034 / 202 need_approval）
//   → 占坑 → 执行 → 回写结果 + consumed + 计量 + 审计。
// 被拒（scope/模块/限流/配额/审批无效/幂等冲突）一律写审计（§11.7.7 护栏 6），
// 其中 scope/模块/限流/配额不计量，重放与 need_approval 计量（真实消耗了服务）。
// 返回统一信封 {summary, data, warnings, next_actions}（§11.6.3），MCP server 直接转文本。
// =============================================================================
import {
  BadRequestException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Template } from '../entities/template.entity';
import { Tenant } from '../entities/tenant.entity';
import { AgentService, AgentCtx } from './agent.service';
import {
  AGENT_TOOLS, catalogDto, findTool, isWriteTool, needsApproval, ToolDef, visibleTools,
} from './tool.catalog';
import { InventoryService, StockWriteOutcome } from '../inventory/inventory.service';
import { shortageSummaryText } from '../inventory/kit.calc';
import { ModulesService } from '../saas/modules.service';
import { TenantConfigService, FeatureKey } from '../saas/tenant-config.service';
import { UsageService } from '../billing/usage.service';
import { AuditService } from '../audit/audit.module';
import { TemplateService } from '../template/template.service';
import { PrintService } from '../print/print.service';
import { validateAiTemplate } from '../ai-template/validate-ai-template';
import { tenantStorage } from '../common/tenant.context';
import { ApprovalService } from './approval.service';
import { IdempotencyService } from './idempotency.service';
import { AgentRateService } from './agent-rate.service';
import { AgentApproval } from './agent.entity';
import {
  APPROVAL_MESSAGES, approvalArgsHash, approvalVerdict, isDryRun,
} from './approval.calc';
import { batchOverLimit, BATCH_MAX as DEFAULT_BATCH_MAX } from './rate.calc';
import {
  ApprovalInvalidException, BusinessException, FeatureDisabledException,
  IdempotencyConflictException, ModuleNotSubscribedException, PermissionDeniedException,
  QuotaExceededException, RateLimitedException,
} from '../common/business.errors';
import { argsHash } from './agent.calc';
// P6 上线前加固 B2.6：护栏 7 工具返回字段脱敏（出域前统一裁剪敏感业务字段）
import { redact, redactionWarning, shouldRedact } from './redaction.calc';

export interface ToolResult {
  summary: string;
  data: any;
  warnings: string[];
  next_actions: string[];
}

const METER = 'agent_calls';
/** need_approval 摘要里给模型的时限提示（真实时限由 approval.calc 控制） */
const USE_HINT_MS = 5 * 60 * 1000;
/** §11.7.7 护栏 5：单次批量上限（rate.calc.BATCH_MAX 的展示副本，用于错误文案） */
const BATCH_LIMIT = DEFAULT_BATCH_MAX;

/** 摘要回显本次参数键名（值不重复下发，预览已折叠过） */
function approvalArgsPreviewKeepsKeys(args: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(args ?? {}).sort()) out[k] = typeof args[k] === 'string' && args[k].length > 60
    ? `${args[k].slice(0, 60)}…` : args[k];
  return out;
}
const LIMIT_MAX = 100;

@Injectable()
export class ToolsService {
  private logger = new Logger('ToolsService');

  constructor(
    @InjectRepository(Template) private templates: Repository<Template>,
    @InjectRepository(Tenant) private tenants: Repository<Tenant>,
    private agent: AgentService,
    private inventory: InventoryService,
    private modulesSvc: ModulesService,
    private usage: UsageService,
    private audit: AuditService,
    private cfg: TenantConfigService,
    private tplSvc: TemplateService,
    private printSvc: PrintService,
    private approvals: ApprovalService,
    private idem: IdempotencyService,
    private rate: AgentRateService,
  ) {}

  /**
   * 护栏 7（B2.6）：所有出域 ToolResult 统一经过这里做字段级脱敏。
   * 存储/审计保留原始结果（幂等重放与合规追溯需要原值），只在**返回给 LLM 时**裁剪。
   * 脱敏命中时在 warnings 里显式标注，让模型与审计都知道数据被裁剪过。
   */
  private egress(result: ToolResult, toolName: string): ToolResult {
    if (!shouldRedact(toolName)) return result;
    const r = redact(result.data);
    if (!r.redacted) return result;
    const w = redactionWarning(r);
    return {
      ...result,
      data: r.data,
      warnings: w ? [...(result.warnings ?? []), w] : result.warnings,
    };
  }

  /** GET /agent/v1/tools：当前 token 可见的工具（MCP 启动注册就靠它） */
  async listTools(ctx: AgentCtx) {
    const active = await this.modulesSvc.listTenantActive(ctx.tenantId);
    return catalogDto(visibleTools(ctx.scopes, active));
  }

  /** 全量目录（管理面/调试用，不做过滤） */
  fullCatalog() {
    return catalogDto(AGENT_TOOLS);
  }

  /** POST /agent/v1/tools/:tool */
  async call(ctx: AgentCtx, name: string, args: Record<string, any> = {}): Promise<ToolResult> {
    const tool = findTool(String(name ?? ''));
    if (!tool) {
      await this.auditCall(ctx, `agent.tool.${String(name).slice(0, 30)}`, args, 'denied_unknown');
      throw new NotFoundException(`未知工具：${name}`);
    }
    const action = this.toolAction(tool);
    // 1) scope（§11.11.2：只读 token 打高危工具 → 403 + 审计）
    if (tool.permission && !this.agent.hasScope(ctx.scopes, tool.permission)) {
      await this.auditCall(ctx, action, args, 'denied_scope', { permission: tool.permission });
      throw new PermissionDeniedException([tool.permission]);
    }
    // 2) 订阅模块（§11.7.7 护栏 9 的前置版）
    if (tool.modules.length) {
      const active = await this.modulesSvc.listTenantActive(ctx.tenantId);
      if (!tool.modules.some((m) => active.includes(m))) {
        const plan = await this.modulesSvc.getPlan(ctx.tenantId).catch(() => null);
        await this.auditCall(ctx, action, args, 'denied_module', { modules: tool.modules });
        throw new ModuleNotSubscribedException(tool.modules, plan?.code ?? null);
      }
    }
    // 3) 执行器可用性（P5：写工具已开放；print.estimate/wait_for_job/cancel_job、ai.*、alerts.* 仍占位）
    if (!tool.implemented) {
      await this.auditCall(ctx, action, args, 'not_open');
      throw new BadRequestException(`工具 ${tool.name} 将在后续版本开放（当前可用工具见 describe_capabilities）`);
    }
    // 4) D7：Agent 提交打印默认关闭，必须租户开 feature_flags['agent.print.submit']
    if (tool.name === 'print.submit_job') {
      const on = await this.cfg.isEnabled(ctx.tenantId, FeatureKey.AGENT_PRINT_SUBMIT).catch(() => false);
      if (!on) {
        await this.auditCall(ctx, action, args, 'denied_feature', { feature: FeatureKey.AGENT_PRINT_SUBMIT });
        throw new FeatureDisabledException(
          FeatureKey.AGENT_PRINT_SUBMIT,
          '当前租户未开启「Agent 提交打印」（D7 默认关闭）。请租户管理员在后台开启，或联系平台运营',
          { suggestion: '平台侧 PUT /platform/tenants/:id/flags {"key":"agent.print.submit","enabled":true}' },
        );
      }
    }
    // 5) 限流（§11.7.7 护栏 5：默认 60 次/分，可按租户 rollout.rpm 覆盖）
    try {
      await this.rate.hit(ctx.tenantId, ctx.clientId, { toolName: tool.name, tokenId: ctx.tokenId });
    } catch (e) {
      if (e instanceof RateLimitedException) await this.auditCall(ctx, action, args, 'denied_rate');
      throw e;
    }
    // 6) 配额（§11.3.5：agent_calls 20000/月，超额 4033）
    try {
      await this.usage.assertQuota(ctx.tenantId, METER, 1);
    } catch (e) {
      if (e instanceof QuotaExceededException) await this.auditCall(ctx, action, args, 'denied_quota');
      throw e;
    }
    // 7) 写工具：幂等键必给；同 key 已有结果 → 直接重放（§11.7.4）
    const hash = approvalArgsHash(args);
    const idemKey = isWriteTool(tool) ? String(args.idempotency_key ?? '').trim() : '';
    if (isWriteTool(tool) && !idemKey) {
      await this.auditCall(ctx, action, args, 'denied_no_idem_key');
      throw new BadRequestException(`${tool.name} 是写操作，必须带 idempotency_key（§11.7.7 护栏 4：重试安全）`);
    }
    if (idemKey) {
      const existing = await this.idem.find(ctx.tenantId, tool.name, idemKey);
      if (existing?.result) {
        if (existing.argsHash !== hash) {
          await this.auditCall(ctx, action, args, 'idempotency_conflict', { idemKey });
          throw new IdempotencyConflictException(idemKey,
            `幂等键 ${idemKey} 已被不同参数用过（args_hash 不一致），请换新 key 或复用原参数`);
        }
        const replayed = this.replay(existing.result as ToolResult, idemKey);
        await this.meter(ctx, tool, true);
        await this.auditCall(ctx, action, args, 'idempotent_replay', { idemKey });
        // 幂等记录里存的是原始结果（审计/重放一致性需要），出域前统一脱敏；
        // 与下方 claim 分支、need_approval 分支、正常返回共用同一个 egress 出口，避免旁路泄露。
        return this.egress(replayed, tool.name);
      }
    }
    // 8) 审批（§11.7.6：高危 + 非 dry_run 才需要；dry_run 无副作用，免审批）
    let approved: AgentApproval | null = null;
    if (needsApproval(tool) && !isDryRun(args)) {
      const rawId = args.approval_id;
      if (rawId === undefined || rawId === null || String(rawId).trim() === '') {
        const row = await this.approvals.request(ctx, tool.name, args, hash);
        await this.meter(ctx, tool, true);
        await this.auditCall(ctx, action, args, 'need_approval', { approvalId: Number(row.id) });
        // 审批参数预览也可能含敏感字段（客户名/地址/单价），出域前同样脱敏
        return this.egress(this.needApprovalResult(tool, row, args), tool.name);
      }
      const approvalId = Number(rawId);
      if (!Number.isFinite(approvalId) || approvalId <= 0) {
        await this.auditCall(ctx, action, args, 'denied_approval_invalid');
        throw new ApprovalInvalidException('invalid', 'approval_id 必须是审批单 id（数字）');
      }
      const row = await this.approvals.loadForRetry(ctx, tool.name, approvalId);
      const verdict = approvalVerdict(row, hash);
      if (verdict !== 'ok') {
        await this.auditCall(ctx, action, args, `denied_approval_${verdict}`, { approvalId });
        throw new ApprovalInvalidException(verdict, APPROVAL_MESSAGES[verdict], { approval_id: approvalId });
      }
      approved = row;
    }
    // 9) 占坑执行（并发/崩溃接管见 IdempotencyService 注释）
    const claim = idemKey
      ? await this.idem.claim({
        tenantId: ctx.tenantId, clientId: ctx.clientId, tool: tool.name,
        idemKey, argsHash: hash, approvalId: approved ? Number(approved.id) : null,
      })
      : null;
    if (claim && !claim.fresh) {
      if (claim.row.argsHash !== hash) {
        await this.auditCall(ctx, action, args, 'idempotency_conflict', { idemKey });
        throw new IdempotencyConflictException(idemKey, `幂等键 ${idemKey} 已被不同参数用过`);
      }
      if (claim.row.result) {
        const replayed = this.replay(claim.row.result as ToolResult, idemKey);
        await this.meter(ctx, tool, true);
        await this.auditCall(ctx, action, args, 'idempotent_replay', { idemKey });
        // 幂等记录里存的是原始结果（审计/重放一致性需要），出域前统一脱敏
        return this.egress(replayed, tool.name);
      }
    }
    // 10) 执行 —— 业务失败也计量（§11.7.7「每次 MCP 工具调用」），成功/失败都写审计
    let result: ToolResult;
    const started = Date.now();
    const approvalId = approved ? Number(approved.id) : undefined;
    try {
      result = await this.run(ctx, tool, args ?? {});
    } catch (e) {
      if (claim) await this.idem.release(claim.row.id);   // 失败释放占坑，同 key 可安全重试
      await this.meter(ctx, tool, false);
      await this.auditCall(ctx, action, args, 'error', {
        error: (e as BusinessException | Error)?.message, durationMs: Date.now() - started, approvalId,
      });
      throw e;
    }
    if (claim) await this.idem.finish(claim.row.id, result);
    if (approved) await this.approvals.consume(Number(approved.id));   // §11.7.6 一次性
    await this.meter(ctx, tool, true);
    await this.auditCall(ctx, action, args, 'ok', {
      durationMs: Date.now() - started, approvalId, idemKey: idemKey || undefined,
    });
    const final = approvalId
      ? { ...result, data: { ...result.data, approval_id: approvalId, approval_consumed: true } }
      : result;
    return this.egress(final, tool.name);
  }

  /** 幂等重放：结果原样回，额外标记 replay（模型据此知道「上次已生效，别再重试」） */
  private replay(stored: ToolResult, idemKey: string): ToolResult {
    return {
      ...stored,
      summary: `【幂等重放】幂等键 ${idemKey} 上次已执行成功，未重复产生副作用。${stored?.summary ?? ''}`,
      data: { ...(stored?.data ?? {}), idempotent_replay: true, idempotency_key: idemKey },
      warnings: [...(stored?.warnings ?? []), '同一 idempotency_key 的重复调用只生效一次'],
      next_actions: stored?.next_actions ?? [],
    };
  }

  /** §11.7.6：无有效审批 → 202 need_approval，**不执行任何副作用** */
  private needApprovalResult(tool: ToolDef, row: AgentApproval, args: Record<string, any>): ToolResult {
    const id = Number(row.id);
    return {
      summary: `${tool.title}（${tool.name}）是高危操作，已生成审批单 #${id} 等待员工确认，本次未执行、未产生任何副作用。`
        + `确认后请在 ${Math.round(USE_HINT_MS / 60000)} 分钟内带 approval_id=${id} 用完全相同的参数重试`,
      data: {
        need_approval: true,
        approval_id: id,
        approval_status: row.status,
        tool: tool.name,
        args_hash: row.argsHash,
        preview: row.argsPreview ?? {},
        expires_at: row.expiresAt,
        args_sent: approvalArgsPreviewKeepsKeys(args),
      },
      warnings: [
        '参数被改动（含 dry_run / idempotency_key）会导致 args_hash 不匹配而直接拒绝',
        '审批批准后只有 5 分钟有效期，且一次性',
      ],
      next_actions: ['GET /agent/v1/approvals/' + id, '员工确认后：同参数 + approval_id 重试本工具'],
    };
  }

  /**
   * POST /agent/v1/approvals（§11.6.3）：Agent 主动为高危工具申请审批，不执行、不计量。
   * 用途：模型先「挂单」让员工看到意图，确认后再重试；scope/模块检查与工具调用一致。
   */
  async requestApproval(ctx: AgentCtx, name: string, args: Record<string, any> = {}) {
    const tool = findTool(String(name ?? ''));
    if (!tool) throw new NotFoundException(`未知工具：${name}`);
    if (!needsApproval(tool)) {
      throw new BadRequestException(`工具 ${tool.name} 风险等级 ${tool.risk}，不需要审批（直接调用即可）`);
    }
    if (tool.permission && !this.agent.hasScope(ctx.scopes, tool.permission)) {
      await this.auditCall(ctx, this.toolAction(tool), args, 'denied_scope', { permission: tool.permission });
      throw new PermissionDeniedException([tool.permission]);
    }
    if (tool.modules.length) {
      const active = await this.modulesSvc.listTenantActive(ctx.tenantId);
      if (!tool.modules.some((m) => active.includes(m))) {
        const plan = await this.modulesSvc.getPlan(ctx.tenantId).catch(() => null);
        await this.auditCall(ctx, this.toolAction(tool), args, 'denied_module', { modules: tool.modules });
        throw new ModuleNotSubscribedException(tool.modules, plan?.code ?? null);
      }
    }
    const hash = approvalArgsHash(args);
    const row = await this.approvals.request(ctx, tool.name, args, hash);
    await this.auditCall(ctx, 'agent.approval.request', args, 'ok', { approvalId: Number(row.id), tool: tool.name });
    return {
      summary: `已为 ${tool.title}（${tool.name}）创建审批单 #${Number(row.id)}（${row.status}），`
        + '员工确认后带 approval_id 重试工具即可执行',
      data: {
        approval_id: Number(row.id), tool: tool.name, status: row.status,
        args_hash: row.argsHash, preview: row.argsPreview, expires_at: row.expiresAt,
      },
    };
  }

  /** GET /agent/v1/approvals（轮询自己的单） */
  async listOwnApprovals(ctx: AgentCtx, status: string, page: number, pageSize: number) {
    const res = await this.approvals.listForClient(ctx, status, page, pageSize);
    return {
      summary: `审批单（${status === 'all' ? '全部' : status}）共 ${res.total} 条，本页 ${res.items.length} 条`,
      data: res,
    };
  }

  /** GET /agent/v1/approvals/:id（§11.6.3，只能查自己的单） */
  async getApproval(ctx: AgentCtx, id: number) {
    const row = await this.approvals.getForAgent(ctx, id);
    return {
      summary: `审批单 #${row.id}（${row.tool}）当前状态：${row.status}`,
      data: row,
    };
  }

  /** GET /agent/v1/resources/:kind/:id（§11.7.5 Resource → 复用同 scope 的工具链路） */
  async resource(ctx: AgentCtx, kind: string, id: string): Promise<ToolResult> {
    const k = String(kind ?? '').toLowerCase();
    if (k === 'template') return this.call(ctx, 'templates.get', { id: /^\d+$/.test(id) ? Number(id) : undefined, name: /^\d+$/.test(id) ? undefined : id });
    if (k === 'stock') {
      const tool = findTool('inventory.query_stock')!;
      // 快照走 query_stock 的检查链（同 scope/模块/计量），执行器换成单物料视图
      return this.callWith(ctx, tool, { ref: id }, async (args) => {
        const snap = await this.inventory.materialSnapshot(ctx.tenantId, String(args.ref));
        return {
          summary: `${snap.material.name}（${snap.material.code}）当前库存 ${snap.total} ${snap.material.unit}`
            + `，安全库存 ${snap.material.safetyStock}${snap.batches.length ? `；批次 ${snap.batches.length} 个` : '；暂无批次'}`,
          data: snap,
          warnings: snap.total < snap.material.safetyStock
            ? [`低于安全库存：${snap.total}/${snap.material.safetyStock} ${snap.material.unit}`] : [],
          next_actions: ['inventory.list_expiring', 'bom.check_kit_rate'],
        };
      });
    }
    throw new BadRequestException(`未知资源类型：${kind}（支持 template / stock）`);
  }

  // ---------------------------------------------------------------- dispatch 内部

  /** 自定义执行器也走同一套检查（scope → 模块 → 未开放 → 配额 → 计量 + 审计） */
  private async callWith(
    ctx: AgentCtx, tool: ToolDef, args: Record<string, any>,
    exec: (a: Record<string, any>) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    if (tool.permission && !this.agent.hasScope(ctx.scopes, tool.permission)) {
      await this.auditCall(ctx, this.toolAction(tool), args, 'denied_scope', { permission: tool.permission });
      throw new PermissionDeniedException([tool.permission]);
    }
    if (tool.modules.length) {
      const active = await this.modulesSvc.listTenantActive(ctx.tenantId);
      if (!tool.modules.some((m) => active.includes(m))) {
        const plan = await this.modulesSvc.getPlan(ctx.tenantId).catch(() => null);
        await this.auditCall(ctx, this.toolAction(tool), args, 'denied_module', { modules: tool.modules });
        throw new ModuleNotSubscribedException(tool.modules, plan?.code ?? null);
      }
    }
    try {
      await this.rate.hit(ctx.tenantId, ctx.clientId, { toolName: tool.name, tokenId: ctx.tokenId });
    } catch (e) {
      if (e instanceof RateLimitedException) await this.auditCall(ctx, this.toolAction(tool), args, 'denied_rate');
      throw e;
    }
    try {
      await this.usage.assertQuota(ctx.tenantId, METER, 1);
    } catch (e) {
      if (e instanceof QuotaExceededException) await this.auditCall(ctx, this.toolAction(tool), args, 'denied_quota');
      throw e;
    }
    let result: ToolResult;
    try {
      result = await exec(args);
    } catch (e) {
      await this.meter(ctx, tool, false);
      await this.auditCall(ctx, this.toolAction(tool), args, 'error', { error: (e as Error)?.message });
      throw e;
    }
    await this.meter(ctx, tool, true);
    await this.auditCall(ctx, this.toolAction(tool), args, 'ok');
    return result;
  }

  private toolAction(tool: ToolDef): string {
    return `agent.tool.${tool.name}`.slice(0, 40);   // audit_logs.action varchar(40)
  }

  private async meter(ctx: AgentCtx, tool: ToolDef, ok: boolean) {
    try {
      await this.usage.record(ctx.tenantId, METER, 1, {
        moduleCode: tool.modules[0] ?? 'agent',
        meta: { tool: tool.name, clientId: ctx.clientId, ok },
      });
    } catch (e) {
      // 计量失败不阻断调用（与打印/AI 链路同一策略：宁可漏计不漏服务）
      this.logger.warn(`agent_calls 计量失败 tenant=${ctx.tenantId} tool=${tool.name}: ${(e as Error).message}`);
    }
  }

  /**
   * §11.7.6 审计字段：actor_type=agent（P5 起落 audit_logs.actor_type 列）、
   * agent_client_id、on_behalf_of（Agent 创建人）、tool、args_hash、approval_id、耗时、结果码。
   */
  private async auditCall(
    ctx: AgentCtx, action: string, args: unknown, status: string, extra: Record<string, any> = {},
  ) {
    try {
      const tool = action.startsWith('agent.tool.') ? action.slice('agent.tool.'.length) : action;
      await this.audit.write(ctx.tenantId, action, {
        clientId: ctx.clientId, clientName: ctx.clientName,
        actorType: 'agent', onBehalfOf: ctx.onBehalfOf,
        tool, argsHash: argsHash(args), scopes: ctx.scopes, status, ...extra,
      }, ctx.onBehalfOf ?? 0, 'agent_client', ctx.clientId, 'agent');
    } catch (e) {
      this.logger.warn(`agent 审计写入失败 ${action}: ${(e as Error).message}`);
    }
  }

  private clampLimit(v: unknown): number {
    const n = Math.floor(Number(v ?? 20));
    if (!Number.isFinite(n) || n < 1) return 20;
    return Math.min(n, LIMIT_MAX);
  }

  private esc(s: unknown): string {
    return String(s ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
  }

  // ---------------------------------------------------------------- 执行器

  private async run(ctx: AgentCtx, tool: ToolDef, args: Record<string, any>): Promise<ToolResult> {
    switch (tool.name) {
      case 'whoami': return this.execWhoami(ctx);
      case 'list_modules': return this.execListModules(ctx);
      case 'describe_capabilities': return this.execDescribe(ctx);
      case 'templates.search': return this.execTemplatesSearch(ctx, args);
      case 'templates.get': return this.execTemplatesGet(ctx, args);
      case 'inventory.query_stock': return this.execQueryStock(ctx, args);
      case 'inventory.list_low_stock': return this.execLowStock(ctx, args);
      case 'inventory.list_batches': return this.execBatches(ctx, args, false);
      case 'inventory.list_expiring': return this.execBatches(ctx, args, true);
      case 'bom.check_kit_rate': return this.execKit(ctx, args, false);
      case 'bom.explain_shortage': return this.execKit(ctx, args, true);
      // ---------------- P5 写 / 高危 ----------------
      case 'templates.create': return this.execTemplateCreate(ctx, args);
      case 'templates.update': return this.execTemplateUpdate(ctx, args);
      case 'inventory.adjust': return this.execAdjust(ctx, args);
      case 'inventory.transfer': return this.execTransfer(ctx, args);
      case 'print.submit_job': return this.execSubmitJob(ctx, args);
      case 'print.get_status': return this.execJobStatus(ctx, args);
      default:
        throw new BadRequestException(`工具 ${tool.name} 未实现`);
    }
  }

  private async execWhoami(ctx: AgentCtx): Promise<ToolResult> {
    const tenant = await this.tenants.findOne({ where: { id: ctx.tenantId } });
    const active = await this.modulesSvc.listTenantActive(ctx.tenantId);
    const plan = await this.modulesSvc.getPlan(ctx.tenantId).catch(() => null);
    return {
      summary: `我是 Agent「${ctx.clientName}」，代表租户「${tenant?.name ?? ctx.tenantId}」（${plan?.code ?? '未知套餐'}）运行，`
        + `已开通模块 ${active.length} 个，scope ${ctx.scopes.length} 条`,
      data: {
        agent: {
          clientId: ctx.clientId, name: ctx.clientName, scopes: ctx.scopes, tokenId: ctx.tokenId,
          onBehalfOf: ctx.onBehalfOf,
        },
        tenant: { id: ctx.tenantId, name: tenant?.name ?? null, code: tenant?.code ?? null, plan: plan?.code ?? null },
        modules: active,
        // §11.7.7 护栏 5：让 Agent 一开始就知道自己的 RPM 与是否被 D7 限制，避免撞墙后再猜
        rate_limit: await this.rate.peek(ctx.tenantId, ctx.clientId),
        features: await this.cfg.featuresFor(ctx.tenantId),
      },
      warnings: active.includes('agent') ? [] : ['当前租户未订阅 agent 模块，Token 仍有效但管理面不可用'],
      next_actions: ['describe_capabilities', 'list_modules'],
    };
  }

  private async execListModules(ctx: AgentCtx): Promise<ToolResult> {
    // listTenantModules 本身只返回 active/trial 展开后的模块（ModulesService 内 60s 缓存）
    const rows = await this.modulesSvc.listTenantModules(ctx.tenantId);
    return {
      summary: `已订阅模块 ${rows.length} 个：${rows.map((r) => r.code).join('、') || '（无）'}`,
      data: { modules: rows },
      warnings: [],
      next_actions: ['describe_capabilities'],
    };
  }

  private async execDescribe(ctx: AgentCtx): Promise<ToolResult> {
    const active = await this.modulesSvc.listTenantActive(ctx.tenantId);
    const visible = visibleTools(ctx.scopes, active);
    const pending = AGENT_TOOLS.filter((t) => !t.implemented
      && (!t.permission || this.agent.hasScope(ctx.scopes, t.permission)));
    return {
      summary: `当前可用 ${visible.length} 个工具` + (pending.length ? `；另有 ${pending.length} 个已注册工具待后续版本开放` : ''),
      data: { tools: catalogDto(visible), pending: catalogDto(pending) },
      warnings: [],
      next_actions: visible.filter((t) => t.name !== 'describe_capabilities').map((t) => t.name),
    };
  }

  private async execTemplatesSearch(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    const limit = this.clampLimit(args.limit);
    const qb = this.templates.createQueryBuilder('t')
      .select(['t.id', 't.name', 't.category', 't.tags', 't.description', 't.currentVersion', 't.updatedAt'])
      .where('t.tenant_id = :tid', { tid: ctx.tenantId });
    if (args.keyword) {
      qb.andWhere('(t.name ILIKE :kw OR COALESCE(t.description, \'\') ILIKE :kw)', { kw: `%${this.esc(args.keyword)}%` });
    }
    if (args.category) qb.andWhere('t.category = :cat', { cat: String(args.category) });
    if (args.tag) qb.andWhere('t.tags @> ARRAY[:tag]::text[]', { tag: String(args.tag) });
    const rows = await qb.orderBy('t.updated_at', 'DESC').take(limit).getMany();
    const items = rows.map((t) => ({
      id: Number(t.id), name: t.name, category: t.category, tags: t.tags,
      description: t.description, currentVersion: t.currentVersion, updatedAt: t.updatedAt,
    }));
    return {
      summary: items.length
        ? `找到 ${items.length} 个模板：${items.slice(0, 3).map((i) => i.name).join('、')}${items.length > 3 ? '…' : ''}`
        : '没有匹配到模板。可以换个关键词，或用 templates.create 创建',
      data: { items, total: items.length },
      warnings: [],
      next_actions: items.length ? ['templates.get'] : [],
    };
  }

  private async execTemplatesGet(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    let tpl: Template | null;
    if (args.id !== undefined && args.id !== null && String(args.id) !== '') {
      tpl = await this.templates.findOne({ where: { id: Number(args.id), tenantId: ctx.tenantId } });
    } else if (args.name) {
      tpl = await this.templates.findOne({ where: { name: String(args.name), tenantId: ctx.tenantId } });
      if (!tpl) {
        tpl = await this.templates.createQueryBuilder('t')
          .where('t.tenant_id = :tid', { tid: ctx.tenantId })
          .andWhere('t.name ILIKE :kw', { kw: `%${this.esc(args.name)}%` })
          .orderBy('t.updated_at', 'DESC').take(1).getOne();
      }
    } else {
      throw new BadRequestException('需要 id 或 name 定位模板');
    }
    if (!tpl) throw new NotFoundException('模板不存在');
    return {
      summary: `模板「${tpl.name}」当前版本 v${tpl.currentVersion}${tpl.category ? `（分类：${tpl.category}）` : ''}`,
      data: {
        id: Number(tpl.id), name: tpl.name, category: tpl.category, tags: tpl.tags,
        schemaVersion: tpl.schemaVersion, currentVersion: tpl.currentVersion,
        content: tpl.content, updatedAt: tpl.updatedAt,
      },
      warnings: [],
      next_actions: ['print.submit_job'],
    };
  }

  private async execQueryStock(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    const res = await this.inventory.queryStock(ctx.tenantId, {
      keyword: args.keyword, warehouse: args.warehouse,
      groupBy: ['sku', 'batch', 'warehouse'].includes(String(args.group_by)) ? args.group_by : 'sku',
      belowSafety: args.below_safety === true,
      expiringDays: args.expiring_days ? Number(args.expiring_days) : undefined,
      limit: args.limit,
    });
    const items = res.items;
    const warnings: string[] = [];
    if (res.groupBy === 'sku') {
      const below = items.filter((i) => i.belowSafety);
      if (below.length) warnings.push(`${below.length} 个物料低于安全库存：${below.slice(0, 3).map((i) => i.name).join('、')}`);
    }
    return {
      summary: items.length
        ? `库存查询（${res.groupBy} 维度）返回 ${items.length} 行：`
          + items.slice(0, 3).map((i) => `${i.name}${i.batchNo ? `(${i.batchNo})` : ''} ${i.qty}${i.unit}`).join('；')
          + (items.length > 3 ? '…' : '')
        : '未查询到符合条件的库存。可能是还没有录入物料/批次，或关键词/仓库过滤太窄——可去掉条件重试',
      data: { items, groupBy: res.groupBy, total: items.length },
      warnings,
      next_actions: items.length ? ['inventory.list_low_stock', 'bom.check_kit_rate'] : ['inventory.list_batches'],
    };
  }

  private async execLowStock(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    const res = await this.inventory.listLowStock(ctx.tenantId, { keyword: args.keyword, limit: args.limit });
    return {
      summary: res.items.length
        ? `${res.items.length} 个物料低于安全库存：${res.items.slice(0, 3).map((i) => `${i.name} 缺 ${i.gap}${i.unit}`).join('、')}${res.items.length > 3 ? '…' : ''}`
        : '库存健康：当前没有低于安全库存的物料',
      data: { items: res.items, total: res.items.length },
      warnings: res.items.slice(0, 5).map((i) => `${i.name}(${i.code})：${i.qty}/${i.safetyStock} ${i.unit}`),
      next_actions: res.items.length ? ['bom.check_kit_rate'] : [],
    };
  }

  private async execBatches(ctx: AgentCtx, args: Record<string, any>, expiring: boolean): Promise<ToolResult> {
    const res = expiring
      ? await this.inventory.listExpiring(ctx.tenantId, {
        days: args.days ? Number(args.days) : undefined, keyword: args.keyword,
        warehouse: args.warehouse, limit: args.limit,
      })
      : await this.inventory.listBatches(ctx.tenantId, { keyword: args.keyword, warehouse: args.warehouse, limit: args.limit });
    const items = res.items;
    return {
      summary: items.length
        ? `${expiring ? `30 天内到期默认口径返回` : '批次列表返回'} ${items.length} 个批次：`
          + items.slice(0, 3).map((i) => `${i.name} ${i.batchNo}（${i.qty}${i.unit}${i.expiresAt ? `，${i.expiresAt} 到期` : ''}）`).join('；')
          + (items.length > 3 ? '…' : '')
        : expiring
          ? `没有近期到期的批次${args.days ? `（N=${args.days} 天）` : ''}`
          : '暂无批次记录。可先用 inventory.query_stock 看 sku 维度汇总',
      data: { items, total: items.length },
      warnings: items.filter((i) => i.expiresAt && new Date(i.expiresAt) <= new Date())
        .map((i) => `${i.name} ${i.batchNo} 已过期`),
      next_actions: expiring && items.length ? ['inventory.query_stock'] : [],
    };
  }

  private async execKit(ctx: AgentCtx, args: Record<string, any>, explain: boolean): Promise<ToolResult> {
    if (!args.product) throw new BadRequestException(explain ? '需要 product（产品编码或名称）' : '需要 product 与 demand');
    if (!args.demand) throw new BadRequestException('需要 demand（需求数量，≥1 的整数）');
    const { product, bom, kit } = await this.inventory.checkKit(ctx.tenantId, {
      product: String(args.product), demand: Number(args.demand), warehouse: args.warehouse,
    });
    const shortages = kit.shortages;
    const friendlyNone = shortages.length === 0;
    return {
      summary: friendlyNone
        ? `${product.name} 按需求 ${kit.demand} 计算：库存齐套（齐套率 ${kit.kitRate}%，可配套 ${kit.maxSets}）`
        : shortageSummaryText(product.name, kit) ?? `齐套率 ${kit.kitRate}%`,
      data: explain
        ? {
          product: { id: Number(product.id), code: product.code, name: product.name, unit: product.unit },
          bom: { id: Number(bom.id), version: bom.version },
          demand: kit.demand, kitRate: kit.kitRate, maxSets: kit.maxSets,
          items: shortages,
        }
        : {
          product: { id: Number(product.id), code: product.code, name: product.name, unit: product.unit },
          bom: { id: Number(bom.id), version: bom.version },
          demand: kit.demand, kitRate: kit.kitRate, maxSets: kit.maxSets,
          lines: kit.lines, shortages,
        },
      warnings: friendlyNone ? [] : shortages.slice(0, 5).map((l) => `${l.name}(${l.code}) 需 ${l.needed}${l.unit}，可用 ${l.available}${l.unit}`),
      next_actions: friendlyNone
        ? ['print.estimate']
        : ['inventory.query_stock', explain ? 'bom.check_kit_rate' : 'bom.explain_shortage'],
    };
  }
  // ---------------------------------------------------------------- P5 写执行器

  /**
   * Agent 只有 token、没有租户 JWT，而 TemplateService / PrintService 都靠 AsyncLocalStorage 取租户，
   * 所以写路径统一在 tenantStorage.run 里跑，身份 = Agent 创建人（§11.7.6 on_behalf_of）。
   * roles/modules/permissions 给空：门禁已在 dispatch 前置做完，这里只是补 ALS 上下文，
   * 模板 ACL 走「创建人即作者」判定路径。
   */
  private inAgentTenant<T>(ctx: AgentCtx, fn: () => Promise<T>): Promise<T> {
    if (ctx.onBehalfOf === null || ctx.onBehalfOf === undefined) {
      return Promise.reject(new BadRequestException(
        '该 Agent 客户端没有创建人（on_behalf_of 为空），为避免无归属的写操作已拒绝；请在租户后台用管理员账号重建 Agent',
      ));
    }
    return tenantStorage.run({
      tenantId: ctx.tenantId, userId: ctx.onBehalfOf,
      roles: [], modules: [], permissions: [], plan: null, features: {}, dataScopes: null, dataSourceKey: 'default',
    }, fn);
  }

  /** §11.7.7 护栏 8：Agent 给出的模板 JSON 必须过 validateAiTemplate() 清洗后才允许落库 */
  private sanitizeTemplate(content: unknown): { content: any; warnings: string[] } {
    const raw = content as any;
    const page = raw?.page ?? raw?.template?.page ?? {};
    const expected = {
      widthMm: Number(page.widthMm) > 0 ? Number(page.widthMm) : 100,
      heightMm: Number(page.heightMm) > 0 ? Number(page.heightMm) : 80,
      dpi: Number(page.dpi) > 0 ? Number(page.dpi) : 300,
    };
    let checked;
    try {
      checked = validateAiTemplate(raw, expected);
    } catch (e) {
      throw new BadRequestException(`模板 JSON 未通过结构校验（护栏 8）：${(e as Error).message}`);
    }
    const warnings = [
      ...(checked.warnings ?? []),
      ...(checked.droppedCount ? [`${checked.droppedCount} 个非法元素已丢弃`] : []),
    ];
    return { content: checked.template, warnings };
  }

  private async execTemplateCreate(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    const name = String(args.name ?? '').trim();
    if (!name) throw new BadRequestException('需要 name（模板名称）');
    const { content, warnings } = this.sanitizeTemplate(args.content);
    const t = await this.inAgentTenant(ctx, () => this.tplSvc.create({
      name,
      category: args.category ? String(args.category) : undefined,
      tags: Array.isArray(args.tags) ? args.tags.map((x: unknown) => String(x)) : undefined,
      content,
      createdBy: ctx.onBehalfOf ?? undefined,
    }));
    return {
      summary: `已创建模板「${t.name}」（id=${Number(t.id)}，v${t.currentVersion}）`
        + `${warnings.length ? `；清洗提示 ${warnings.length} 条` : ''}`,
      data: { id: Number(t.id), name: t.name, category: t.category, currentVersion: t.currentVersion, page: content?.page ?? null },
      warnings,
      next_actions: ['templates.get', 'print.submit_job'],
    };
  }

  private async execTemplateUpdate(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    const { content, warnings } = this.sanitizeTemplate(args.content);
    const tpl = await this.resolveTemplate(ctx, args.id ?? args.template ?? args.name);
    const label = args.name ? String(args.name) : tpl.name;   // dto 里 name=undefined 时实体会回填不了，用定位到的名字
    const saved = await this.inAgentTenant(ctx, () => this.tplSvc.update(Number(tpl.id), {
      name: args.name ? String(args.name) : undefined,
      content,
      updatedBy: ctx.onBehalfOf ?? undefined,
    }));
    return {
      summary: `模板「${label}」（id=${Number(saved.id)}）已更新到 v${saved.currentVersion}，旧版本可在版本列表回滚`,
      data: { id: Number(saved.id), name: saved.name, currentVersion: saved.currentVersion },
      warnings,
      next_actions: ['templates.get', 'print.submit_job'],
    };
  }

  /** 模板定位：数字按 id，其余按名称精确、再模糊（与 templates.get 同口径） */
  private async resolveTemplate(ctx: AgentCtx, ref: unknown): Promise<Template> {
    const q = String(ref ?? '').trim();
    if (!q) throw new BadRequestException('需要模板 id 或名称');
    if (/^\d+$/.test(q)) {
      const byId = await this.templates.findOne({ where: { id: Number(q), tenantId: ctx.tenantId } });
      if (byId) return byId;
      throw new NotFoundException(`模板不存在：id=${q}`);
    }
    const exact = await this.templates.findOne({ where: { name: q, tenantId: ctx.tenantId } });
    if (exact) return exact;
    const fuzzy = await this.templates.createQueryBuilder('t')
      .where('t.tenant_id = :tid', { tid: ctx.tenantId })
      .andWhere('t.name ILIKE :kw', { kw: `%${this.esc(q)}%` })
      .orderBy('t.updated_at', 'DESC').take(1).getOne();
    if (!fuzzy) throw new NotFoundException(`模板不存在：${q}`);
    return fuzzy;
  }

  private stockLines(out: StockWriteOutcome) {
    return out.lines.map((l) => `${l.warehouse}/${l.batchNo}：${l.before} → ${l.after}（${l.change > 0 ? '+' : ''}${l.change}）`);
  }

  private async execAdjust(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    const dry = isDryRun(args);
    const out = await this.inventory.adjustStock(ctx.tenantId, {
      sku: String(args.sku ?? ''), warehouse: String(args.warehouse ?? ''),
      batch_no: args.batch_no ? String(args.batch_no) : undefined,
      delta: Number(args.delta), reason: String(args.reason ?? ''),
    }, dry);
    const unit = out.material.unit;
    const verb = out.change > 0 ? '入库' : '出库';
    return {
      summary: dry
        ? `【预演】${out.warehouse.name} 的 ${out.material.name} 计划${verb} ${Math.abs(out.change)}${unit}，`
          + `将影响 ${out.lines.length} 个批次；dry_run=true 未改动库存，去掉 dry_run 并带 approval_id 才会真正执行`
        : `${out.warehouse.name} 的 ${out.material.name} 已${verb} ${Math.abs(out.change)}${unit}，`
          + `影响 ${out.lines.length} 个批次：${this.stockLines(out).join('；')}`,
      data: out,
      warnings: [
        ...(out.note ? [out.note] : []),
        ...(dry ? ['预演结果不产生副作用，approval_id 与幂等键都不消耗'] : []),
      ],
      next_actions: dry ? ['inventory.adjust（去掉 dry_run + 带 approval_id）'] : ['inventory.query_stock', 'bom.check_kit_rate'],
    };
  }

  private async execTransfer(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    const dry = isDryRun(args);
    const out = await this.inventory.transferStock(ctx.tenantId, {
      sku: String(args.sku ?? ''),
      from_warehouse: String(args.from_warehouse ?? ''),
      to_warehouse: String(args.to_warehouse ?? ''),
      qty: Number(args.qty),
      batch_no: args.batch_no ? String(args.batch_no) : undefined,
    }, dry);
    return {
      summary: dry
        ? `【预演】${out.material.name} 计划调拨 ${out.change}${out.material.unit}（${out.warehouse.name} 出发），`
          + `涉及 ${out.lines.length} 条批次变动；未真正调拨`
        : `${out.material.name} 已调拨 ${out.change}${out.material.unit}：${this.stockLines(out).join('；')}`,
      data: out,
      warnings: dry ? ['预演结果不产生副作用，approval_id 与幂等键都不消耗'] : [],
      next_actions: dry ? ['inventory.transfer（去掉 dry_run + 带 approval_id）'] : ['inventory.query_stock'],
    };
  }

  private async execSubmitJob(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    const tpl = await this.resolveTemplate(ctx, args.template);
    const copies = Math.floor(Number(args.copies ?? 1));
    const rows = Array.isArray(args.rows) ? args.rows : undefined;
    const over = batchOverLimit(copies, rows);
    if (over) throw new BadRequestException(`${over}（§11.7.7 护栏 5：单次批量 ≤ ${BATCH_LIMIT}）`);
    const job = await this.inAgentTenant(ctx, () => this.printSvc.createJob({
      templateId: Number(tpl.id),
      printerId: args.printer_id ? Number(args.printer_id) : undefined,
      copies,
      rows,
      params: args.params ?? undefined,
    }));
    const warnings: string[] = [];
    if (job.quotaWarn) warnings.push('print_labels 配额接近上限（soft_limit），请关注用量');
    return {
      summary: `打印任务已提交（jobId=${job.jobId}，${tpl.name}，${job.total} 张，状态 ${job.status}）。`
        + '队列异步执行，可用 print.get_status 轮询',
      data: { jobId: job.jobId, total: job.total, status: job.status, template: { id: Number(tpl.id), name: tpl.name }, quotaWarn: job.quotaWarn },
      warnings,
      next_actions: ['print.get_status'],
    };
  }

  private async execJobStatus(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    const id = Number(args.job_id);
    if (!Number.isFinite(id) || id <= 0) throw new BadRequestException('需要 job_id');
    const job = await this.inAgentTenant(ctx, () => this.printSvc.getJob(id));
    if (!job) throw new NotFoundException(`打印任务不存在：${id}`);
    const done = Number(job.done ?? 0);
    const total = Number(job.total ?? 0);
    return {
      summary: `任务 #${Number(job.id)}：${job.status}，已完成 ${done}/${total}`
        + `${Number(job.failed ?? 0) ? `，失败 ${job.failed}` : ''}`,
      data: {
        jobId: Number(job.id), status: job.status, total, done, failed: Number(job.failed ?? 0),
        createdAt: job.createdAt, finishedAt: job.finishedAt ?? null,
      },
      warnings: job.status === 'failed' ? ['任务失败，请检查打印机连接与模板'] : [],
      next_actions: ['done','failed'].includes(job.status) ? [] : ['print.get_status'],
    };
  }

}
