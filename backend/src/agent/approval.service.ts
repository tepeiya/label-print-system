// =============================================================================
// ApprovalService —— 高危操作审批单（docs/11 §11.7.6）
//
// 生命周期：Agent 调用高危工具（无 approval_id）→ request() 建 pending（**不执行任何副作用**）
// → 员工在租户后台 /agents/approvals 确认 → approved（5 分钟、一次性）
// → Agent 带 approval_id 重试且 args_hash 命中 → 执行后置 consumed。
//
// 判定逻辑全在 approval.calc（纯函数、可单测）；这里只管落库与状态迁移。
// =============================================================================
import {
  BadRequestException, Injectable, NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentApproval } from './agent.entity';
import { AgentCtx } from './agent.service';
import { AuditService } from '../audit/audit.module';
import {
  APPROVAL_MESSAGES, ApprovalStatus, approvedExpiryAt, compactPreview,
  isStale, pendingExpiryAt,
} from './approval.calc';

export interface ApprovalDto {
  id: number;
  tool: string;
  status: string;
  agentClientId: number;
  agentClientName: string | null;
  argsPreview: Record<string, any>;
  argsHash: string;
  createdAt: Date;
  expiresAt: Date;
  approvedBy: number | null;
  approvedAt: Date | null;
  consumedAt: Date | null;
  message?: string;
}

@Injectable()
export class ApprovalService {
  constructor(
    @InjectRepository(AgentApproval) private repo: Repository<AgentApproval>,
    private audit: AuditService,
  ) {}

  /**
   * 建审批单（幂等）：同 client + tool + args_hash 已有未过期 pending 就直接复用，
   * 避免模型反复重试刷出一堆待确认单。
   */
  async request(ctx: AgentCtx, tool: string, args: Record<string, any>, hash: string): Promise<AgentApproval> {
    await this.expireStale(ctx.tenantId);
    const existing = await this.repo.findOne({
      where: { tenantId: ctx.tenantId, agentClientId: ctx.clientId, tool, argsHash: hash, status: 'pending' },
      order: { id: 'DESC' },
    });
    if (existing) return existing;
    return this.repo.save(this.repo.create({
      tenantId: ctx.tenantId,
      agentClientId: ctx.clientId,
      tool,
      argsHash: hash,
      argsPreview: compactPreview(args),
      status: 'pending' as ApprovalStatus,
      expiresAt: pendingExpiryAt(),
    }));
  }

  /** Agent 侧查询（只能看自己的单，§11.6.3） */
  async getForAgent(ctx: AgentCtx, id: number): Promise<ApprovalDto> {
    const row = await this.repo.findOne({ where: { id, tenantId: ctx.tenantId, agentClientId: ctx.clientId } });
    if (!row) throw new NotFoundException('审批单不存在或不属于当前 Agent');
    return this.toDto(row, ctx.clientName);
  }

  /** 重试时取单：限同租户 + 同 Agent + 同工具 */
  async loadForRetry(ctx: AgentCtx, tool: string, id: number): Promise<AgentApproval | null> {
    return this.repo.findOne({ where: { id, tenantId: ctx.tenantId, agentClientId: ctx.clientId, tool } });
  }

  async approve(tenantId: number, id: number, actorId: number | null): Promise<ApprovalDto> {
    const row = await this.getOr404(tenantId, id);
    if (row.status === 'approved') return this.toDto(row);            // 重复确认 → 幂等返回
    if (row.status !== 'pending') {
      throw new BadRequestException(`当前状态 ${row.status} 不能确认（只有待确认可操作）`);
    }
    const now = new Date();
    row.status = 'approved';
    row.approvedBy = actorId ?? null;
    row.approvedAt = now;
    row.expiresAt = approvedExpiryAt(now);                            // §11.7.6：批准后 5 分钟
    await this.repo.save(row);
    await this.audit.write(tenantId, 'agent.approval.approve',
      { approvalId: row.id, tool: row.tool, clientId: row.agentClientId }, actorId ?? undefined, 'agent_approval', row.id);
    return this.toDto(row);
  }

  async reject(tenantId: number, id: number, actorId: number | null, reason?: string): Promise<ApprovalDto> {
    const row = await this.getOr404(tenantId, id);
    if (row.status === 'rejected') return this.toDto(row);
    if (row.status !== 'pending') {
      throw new BadRequestException(`当前状态 ${row.status} 不能驳回（只有待确认可操作）`);
    }
    row.status = 'rejected';
    row.approvedBy = actorId ?? null;
    row.approvedAt = new Date();
    await this.repo.save(row);
    await this.audit.write(tenantId, 'agent.approval.reject',
      { approvalId: row.id, tool: row.tool, clientId: row.agentClientId, reason: reason ?? null },
      actorId ?? undefined, 'agent_approval', row.id);
    return this.toDto(row);
  }

  /** 执行成功后置 consumed（一次性） */
  async consume(id: number): Promise<void> {
    await this.repo.update({ id }, { status: 'consumed', consumedAt: new Date() });
  }

  /** 过期回写：pending/approved 过了 expires_at 一律置 expired（读时判定 + 顺手落库） */
  async expireStale(tenantId: number): Promise<number> {
    const res = await this.repo.createQueryBuilder()
      .update(AgentApproval)
      .set({ status: 'expired' })
      .where('tenant_id = :tid', { tid: tenantId })
      .andWhere('status IN (:...st)', { st: ['pending', 'approved'] })
      .andWhere('expires_at <= now()')
      .execute();
    return res.affected ?? 0;
  }

  /** 租户后台列表（§11.6.1「待确认列表」）；status=all 不过滤 */
  async listForTenant(tenantId: number, status: string, page: number, pageSize: number) {
    await this.expireStale(tenantId);
    const qb = this.repo.createQueryBuilder('a').where('a.tenant_id = :tid', { tid: tenantId });
    if (status && status !== 'all') qb.andWhere('a.status = :st', { st: status });
    const take = Math.min(100, Math.max(1, pageSize));
    const [rows, total] = await qb
      .orderBy('a.id', 'DESC')
      .skip((Math.max(1, page) - 1) * take).take(take)
      .getManyAndCount();
    return { items: rows.map((r) => this.toDto(r)), total, page: Math.max(1, page), pageSize: take };
  }

  /** Agent 侧列表（§11.6.3 之外的补充：模型轮询自己挂过的单） */
  async listForClient(ctx: AgentCtx, status: string, page: number, pageSize: number) {
    await this.expireStale(ctx.tenantId);
    const qb = this.repo.createQueryBuilder('a')
      .where('a.tenant_id = :tid', { tid: ctx.tenantId })
      .andWhere('a.agent_client_id = :cid', { cid: ctx.clientId });
    if (status && status !== 'all') qb.andWhere('a.status = :st', { st: status });
    const take = Math.min(100, Math.max(1, pageSize));
    const [rows, total] = await qb.orderBy('a.id', 'DESC')
      .skip((Math.max(1, page) - 1) * take).take(take)
      .getManyAndCount();
    return { items: rows.map((r) => this.toDto(r, ctx.clientName)), total, page: Math.max(1, page), pageSize: take };
  }

  /** 判定用的状态说明文案（异常里直接给模型读） */
  messageFor(status: string): string {
    return APPROVAL_MESSAGES[status as keyof typeof APPROVAL_MESSAGES] ?? status;
  }

  private async getOr404(tenantId: number, id: number): Promise<AgentApproval> {
    const row = await this.repo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('审批单不存在');
    if (isStale(row)) {
      row.status = 'expired';
      await this.repo.save(row);
    }
    return row;
  }

  private toDto(r: AgentApproval, clientName?: string | null): ApprovalDto {
    return {
      id: Number(r.id),
      tool: r.tool,
      status: r.status,
      agentClientId: Number(r.agentClientId),
      agentClientName: clientName ?? null,
      argsPreview: r.argsPreview ?? {},
      argsHash: r.argsHash,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      approvedBy: r.approvedBy === null || r.approvedBy === undefined ? null : Number(r.approvedBy),
      approvedAt: r.approvedAt,
      consumedAt: r.consumedAt,
      message: APPROVAL_MESSAGES[r.status as keyof typeof APPROVAL_MESSAGES],
    };
  }
}
