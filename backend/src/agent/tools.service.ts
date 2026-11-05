// =============================================================================
// ToolsService —— /agent/v1 工具统一 dispatch（docs/11 §11.6.3 / §11.7.2）
// 检查顺序（§11.11.2 验收依赖）：
//   scope（4032，写审计）→ 订阅模块（4031，写审计）→ 执行器可用性（P4 未开放 400）
//   → agent_calls 配额（4033）→ 执行 → 计量 + 审计。
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
import { AGENT_TOOLS, catalogDto, findTool, ToolDef, visibleTools } from './tool.catalog';
import { InventoryService } from '../inventory/inventory.service';
import { shortageSummaryText } from '../inventory/kit.calc';
import { ModulesService } from '../saas/modules.service';
import { UsageService } from '../billing/usage.service';
import { AuditService } from '../audit/audit.module';
import {
  BusinessException, ModuleNotSubscribedException, PermissionDeniedException, QuotaExceededException,
} from '../common/business.errors';
import { argsHash } from './agent.calc';

export interface ToolResult {
  summary: string;
  data: any;
  warnings: string[];
  next_actions: string[];
}

const METER = 'agent_calls';
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
  ) {}

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
    // 1) scope（§11.11.2：只读 token 打高危工具 → 403 + 审计）
    if (tool.permission && !this.agent.hasScope(ctx.scopes, tool.permission)) {
      await this.auditCall(ctx, this.toolAction(tool), args, 'denied_scope', { permission: tool.permission });
      throw new PermissionDeniedException([tool.permission]);
    }
    // 2) 订阅模块（§11.7.7 护栏 9 的前置版）
    if (tool.modules.length) {
      const active = await this.modulesSvc.listTenantActive(ctx.tenantId);
      if (!tool.modules.some((m) => active.includes(m))) {
        const plan = await this.modulesSvc.getPlan(ctx.tenantId).catch(() => null);
        await this.auditCall(ctx, this.toolAction(tool), args, 'denied_module', { modules: tool.modules });
        throw new ModuleNotSubscribedException(tool.modules, plan?.code ?? null);
      }
    }
    // 3) 执行器可用性（P5 开放的写工具）
    if (!tool.implemented) {
      await this.auditCall(ctx, this.toolAction(tool), args, 'not_open');
      throw new BadRequestException(`工具 ${tool.name} 将在后续版本开放（当前仅只读工具可用）`);
    }
    // 4) 配额（§11.3.5：agent_calls 20000/月，超额 4033）
    try {
      await this.usage.assertQuota(ctx.tenantId, METER, 1);
    } catch (e) {
      if (e instanceof QuotaExceededException) {
        await this.auditCall(ctx, this.toolAction(tool), args, 'denied_quota');
      }
      throw e;
    }
    // 5) 执行 —— 业务失败也计量（§11.7.7「每次 MCP 工具调用」），成功/失败都写审计
    let result: ToolResult;
    const started = Date.now();
    try {
      result = await this.run(ctx, tool, args ?? {});
    } catch (e) {
      await this.meter(ctx, tool, false);
      await this.auditCall(ctx, this.toolAction(tool), args, 'error', {
        error: (e as BusinessException | Error)?.message, durationMs: Date.now() - started,
      });
      throw e;
    }
    await this.meter(ctx, tool, true);
    await this.auditCall(ctx, this.toolAction(tool), args, 'ok', { durationMs: Date.now() - started });
    return result;
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

  private async auditCall(
    ctx: AgentCtx, action: string, args: unknown, status: string, extra: Record<string, any> = {},
  ) {
    try {
      await this.audit.write(ctx.tenantId, action, {
        clientId: ctx.clientId, clientName: ctx.clientName,
        argsHash: argsHash(args), scopes: ctx.scopes, status, ...extra,
      }, undefined, 'agent_client', ctx.clientId);
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
        agent: { clientId: ctx.clientId, name: ctx.clientName, scopes: ctx.scopes, tokenId: ctx.tokenId },
        tenant: { id: ctx.tenantId, name: tenant?.name ?? null, code: tenant?.code ?? null, plan: plan?.code ?? null },
        modules: active,
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
        : '没有匹配到模板。可以换个关键词，或先用 templates.create（后续版本）创建',
      data: { items, total: items.length },
      warnings: [],
      next_actions: items.length ? ['templates.get'] : [],
    };
  }

  private async execTemplatesGet(ctx: AgentCtx, args: Record<string, any>): Promise<ToolResult> {
    let tpl: Template | null = null;
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
}
