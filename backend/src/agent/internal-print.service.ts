// =============================================================================
// InternalPrintService —— WMS 打印契约的打印侧实现（方向 A · 内部端点 /internal/print-jobs）
//
// 定位：WMS 只能通过 PrintGateway 走 HTTP 调本端点，禁止 import backend/src/print 内部实现。
// 本端点运行在打印服务进程内，负责：
//   · service token（Bearer lfagent_）认证 + print:job:write scope 校验（复用 AgentService）
//   · 租户只从 token 解析，body.tenantId 一律忽略并告警（复用 Agent 入站事件范式）
//   · templateCode → (tenant_id, code) 解析生效模板；不存在抛 PRINT_TEMPLATE_NOT_FOUND
//   · 幂等复用 tool_idempotency（tool 固定 'print.createJob'，命中返回原 jobId + idempotent=true）
//   · 在 tenantStorage.run 里调 PrintService.createJob（不改 createJob 签名；Agent 写执行器同款范式）
//   · 幂等键语义：同 key 不同 args_hash → 409；打失败先占坑后释放，允许重试
// =============================================================================
import {
  BadRequestException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Template } from '../entities/template.entity';
import { PrintPrinterRoute } from '../entities/print.entity';
import { PrintService } from '../print/print.service';
import { tenantStorage } from '../common/tenant.context';
import { argsHash } from './agent.calc';
import { AgentService, AgentCtx } from './agent.service';
import { IdempotencyService } from './idempotency.service';
import { PermissionDeniedException, IdempotencyConflictException } from '../common/business.errors';
import { InternalPrintJobDto } from '../print/dto/internal-print.dto';

export interface InternalPrintResult {
  jobId: string | number;
  status: string;
  idempotent?: boolean;
  warnings?: string[];
  /** status=skipped_no_printer 时给调用方的说明 */
  message?: string;
}

@Injectable()
export class InternalPrintService {
  private logger = new Logger('InternalPrintService');
  /** 幂等记录里 tool 字段固定值，用于区分 PRINT 与 Agent 工具调用 */
  private static readonly IDEM_TOOL = 'print.createJob';

  constructor(
    @InjectRepository(Template) private templates: Repository<Template>,
    @InjectRepository(PrintPrinterRoute) private routes: Repository<PrintPrinterRoute>,
    private print: PrintService,
    private agent: AgentService,
    private idem: IdempotencyService,
  ) {}

  /**
   * @param tokenPlain Bearer token 明文（已由调用方从 header 提取）
   * @param body 打印入参
   */
  async submit(tokenPlain: string, body: InternalPrintJobDto): Promise<InternalPrintResult> {
    // 1) 认证（token → tenant/scope），失败按身份无效处理
    const rec = await this.agent.authenticate(tokenPlain);
    if (rec.status !== 'ok' || !rec.token || !rec.client || !rec.tenant) {
      throw new BadRequestException(`service token 无效：${rec.status}`);
    }
    const ctx: AgentCtx = {
      tenantId: Number(rec.token.tenantId),
      clientId: Number(rec.client.id),
      clientName: rec.client.name,
      scopes: rec.token.scopes ?? [],
      tokenId: Number(rec.token.id),
      onBehalfOf: rec.client.createdBy == null ? null : Number(rec.client.createdBy),
    };
    // 2) scope：print:job:write（与 Agent 写工具同一把钥匙）
    if (!this.agent.hasScope(ctx.scopes, 'print:job:write')) {
      throw new PermissionDeniedException(['print:job:write']);
    }

    const warnings: string[] = [];
    // 3) 请求体租户字段一律忽略 + 告警
    const anyBody = body as any;
    if (anyBody.tenantId !== undefined || anyBody.tenant_id !== undefined) {
      warnings.push('请求体中的 tenantId 已被忽略（租户身份只从 service token 解析）');
    }

    // 4) 模板寻址：按 (tenant_id, code) 取生效模板（阶段一不做版本，取当前行）
    const tpl = await this.templates.findOne({
      where: { tenantId: ctx.tenantId, code: body.templateCode } as any,
    });
    if (!tpl) {
      // 挂 detail.errorCode，AllExceptionsFilter 会把它透出到响应体顶层，
      // PrintGateway 据此映射出语义码 PRINT_TEMPLATE_NOT_FOUND（契约 §5.2）
      const err: any = new NotFoundException(`模板不存在：${body.templateCode}`);
      err.detail = { errorCode: 'PRINT_TEMPLATE_NOT_FOUND' };
      throw err;
    }

    // 5) 幂等：claim → 命中且有 result 直接重放 → 同 key 不同 args 冲突 409
    const idemKey = body.idempotencyKey;
    const argsHashValue = argsHash({
      templateCode: body.templateCode, variables: body.variables,
      printerRoute: body.printerRoute, copies: body.copies ?? 1,
    });
    const claim = await this.idem.claim({
      tenantId: ctx.tenantId, clientId: ctx.clientId,
      tool: InternalPrintService.IDEM_TOOL, idemKey, argsHash: argsHashValue,
    });
    if (!claim.fresh) {
      if (claim.row.result) {
        return { ...(claim.row.result as any), idempotent: true, warnings };
      }
      if (claim.row.argsHash !== argsHashValue) {
        // 同 key 不同参数 → 409（复用 IdempotencyConflictException 口径）
        throw new IdempotencyConflictException(idemKey, '幂等键已用于不同的打印参数');
      }
      // 占坑未 finish（上次崩在执行中）→ 接管重试
      this.logger.warn(`幂等占坑接管重试 key=${idemKey}`);
    }

    // 6) 逻辑路由 → 物理打印机（P9：print_printer_routes，按 priority 取第一台）
    //    无映射时不兜底"默认打印机"，而是明确 skipped_no_printer，避免以为打了其实没出纸。
    let resolvedPrinterId: number | null = null;
    if (body.printerRoute) {
      const routeRows = await this.routes.find({
        where: { tenantId: ctx.tenantId, routeCode: body.printerRoute, enabled: true },
        order: { priority: 'ASC', id: 'ASC' },
      });
      resolvedPrinterId = routeRows.length ? Number(routeRows[0].printerId) : null;
      if (!routeRows.length) {
        warnings.push(`printerRoute「${body.printerRoute}」未配置打印机映射（print_printer_routes），本次标记 skipped_no_printer`);
      }
    } else {
      warnings.push('未指定 printerRoute，内部打印需要逻辑路由才能定位物理打印机');
    }

    // 7) 组变量：variables 即模板数据行
    const rows = [body.variables ?? {}];
    const createDto: any = {
      templateId: tpl.id,
      rows,
      copies: body.copies ?? 1,
      printerId: resolvedPrinterId ?? undefined,
      requirePrinter: true,
      params: { source: body.source ?? 'wms', printerRoute: body.printerRoute ?? null, wmsIdemKey: idemKey },
    };

    try {
      // 7) 在 ALS 上下文里调 createJob（不改签名），身份 = Agent 创建人
      const onBehalf = ctx.onBehalfOf ?? ctx.clientId;
      const job = await tenantStorage.run({
        tenantId: ctx.tenantId, userId: onBehalf,
        roles: [], modules: [], permissions: [], plan: null, features: {}, dataScopes: null, dataSourceKey: 'default',
      }, () => this.print.createJob(createDto));
      const result: InternalPrintResult = {
        jobId: (job as any).jobId, status: (job as any).status,
        ...((job as any).message ? { message: (job as any).message } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
      await this.idem.finish(claim.row.id, { jobId: (job as any).jobId, status: (job as any).status });
      void this.agent.touch(Number(rec.token.id));
      return result;
    } catch (e) {
      // 打印失败不占坑（释放后可用同 key 重试），但保留 result=null 的占坑给接管逻辑也行；
      // 这里选择 release：让 WMS 的"补打入口"用新 key 重试更符合契约语义。
      await this.idem.release(claim.row.id);
      throw e;
    }
  }
}
