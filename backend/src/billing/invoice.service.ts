// =============================================================================
// InvoiceService —— P3 账单与收款（docs/11 §11.7 / D5）
// 生命周期：draft（运营出账）→ issued（发单，带 due_at）→ paid（收款累计 ≥ 应付）
//           ；issued 逾期未收 → 每日任务转 overdue；void 仅对未付账单。
// D5：V1 不做支付回调，payments 只有运营手动登记（provider='manual'）。
// =============================================================================
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Invoice, Payment } from './billing.entity';
import { Subscription, Plan } from '../entities/saas.entity';
import { invoiceNumber, isSettled, maxSeqOf, monthPeriod, sumLineCents } from './billing.calc';

export interface InvoiceLine {
  code?: string;
  title: string;
  qty?: number;
  unitPriceCents?: number;
  amountCents?: number;
}

const PLATFORM_PROVIDER = ['manual', 'wechat', 'alipay', 'stripe', 'bank'];

@Injectable()
export class InvoiceService implements OnModuleInit {
  private logger = new Logger('InvoiceService');

  constructor(
    @InjectRepository(Invoice) private invoices: Repository<Invoice>,
    @InjectRepository(Payment) private payments: Repository<Payment>,
    @InjectRepository(Subscription) private subs: Repository<Subscription>,
    @InjectRepository(Plan) private plans: Repository<Plan>,
  ) {}

  // -------------------------------------------------------------- 出账

  /**
   * 创建草稿账单。不给 items/amountCents 时按租户当前套餐的月费自动生成单行账单项；
   * detail 里冻结出账快照（套餐、单价、周期），之后运营改价不影响已出账单。
   */
  async createDraft(
    actor: { id: number; username: string },
    input: { tenantId: number; periodStart?: string; periodEnd?: string; items?: InvoiceLine[]; amountCents?: number; currency?: string; note?: string },
  ) {
    const now = new Date();
    const period = monthPeriod(now);
    const periodStart = input.periodStart ?? period.periodStart;
    const periodEnd = input.periodEnd ?? period.periodEnd;

    let items: InvoiceLine[] = input.items ?? [];
    let snapshot: Record<string, any> = { source: 'manual' };
    if (!items.length && input.amountCents === undefined) {
      const plan = await this.resolvePlan(input.tenantId);
      if (!plan) throw new BadRequestException('该租户无有效套餐，无法自动出账；请显式传入 items 或 amountCents');
      items = [{ code: `plan-${plan.code}`, title: `${plan.name}（${plan.code}）月费`, qty: 1, unitPriceCents: Number(plan.priceCents) }];
      snapshot = { source: 'plan', plan: { id: plan.id, code: plan.code, name: plan.name, priceCents: Number(plan.priceCents) } };
    }
    const amountCents = input.amountCents !== undefined
      ? Math.round(Number(input.amountCents))
      : sumLineCents(items);
    if (!Number.isInteger(amountCents) || amountCents < 0) throw new BadRequestException('账单金额无效（分，非负整数）');

    const number = await this.nextNumber(input.tenantId, now);
    await this.invoices.insert({
      tenantId: input.tenantId, number, amountCents: String(amountCents),
      currency: input.currency ?? 'CNY', status: 'draft',
      periodStart, periodEnd, dueAt: null, paidAt: null,
      detail: { ...snapshot, items, note: input.note ?? '' } as any,
      createdBy: actor.id,
    });
    return this.getOneByNumber(number);
  }

  /** 租户当前套餐：active 订阅 → trial 订阅 → tenants.plan_id 不查（订阅是唯一口径，同 P1） */
  private async resolvePlan(tenantId: number): Promise<Plan | null> {
    const sub = (await this.subs.findOne({ where: { tenantId, status: 'active' } }))
      ?? (await this.subs.findOne({ where: { tenantId, status: 'trial' } }));
    if (!sub) return null;
    return this.plans.findOne({ where: { id: sub.planId } });
  }

  /** 生成 INV-<t>-<yymm>-<seq>；unique 冲突重试（并发出账罕见，最多 5 次） */
  private async nextNumber(tenantId: number, now: Date): Promise<string> {
    const yymm = invoiceNumber(tenantId, now, 0).split('-')[2];
    const existing = await this.invoices.createQueryBuilder('i')
      .select('i.number', 'number')
      .where('i.tenant_id = :tenantId', { tenantId })
      .andWhere("i.number LIKE :p", { p: `INV-${tenantId}-${yymm}-%` })
      .getRawMany<{ number: string }>();
    let seq = maxSeqOf(existing.map((r) => r.number), tenantId, now);
    for (let attempt = 0; attempt < 5; attempt++) {
      seq += 1;
      const candidate = invoiceNumber(tenantId, now, seq);
      const dup = await this.invoices.findOne({ where: { number: candidate } });
      if (!dup) return candidate;
    }
    throw new BadRequestException('账单号生成失败，请稍后重试');
  }

  // -------------------------------------------------------------- 状态流转

  async issue(actor: { id: number; username: string }, id: number, dueDays = 15) {
    const inv = await this.mustFind(id);
    if (inv.status !== 'draft') throw new BadRequestException(`账单 ${inv.number} 状态为 ${inv.status}，只有草稿可发出`);
    const d = Math.max(1, Math.min(365, Math.round(dueDays)));
    await this.invoices.update({ id }, { status: 'issued', dueAt: new Date(Date.now() + d * 24 * 3600 * 1000) });
    this.logger.log(`[billing] ${actor.username} 发出账单 ${inv.number}（due ${d}d）`);
    return this.toDto(await this.mustFind(id));
  }

  async voidInvoice(actor: { id: number; username: string }, id: number) {
    const inv = await this.mustFind(id);
    if (inv.status === 'paid') throw new BadRequestException('已付账单不能作废（退款走红字账单，V1 手工另开负额账单）');
    if (inv.status === 'void') return this.toDto(inv);
    await this.invoices.update({ id }, { status: 'void' });
    this.logger.log(`[billing] ${actor.username} 作废账单 ${inv.number}`);
    return this.toDto(await this.mustFind(id));
  }

  /** 每日逾期任务：issued 且过了 due_at → overdue（启动后 1min + 每 24h，同 P2 到期任务模式） */
  async markOverdue(): Promise<number> {
    const res = await this.invoices.createQueryBuilder()
      .update(Invoice)
      .set({ status: 'overdue' })
      .where("status = 'issued'")
      .andWhere('due_at IS NOT NULL')
      .andWhere('due_at < now()')
      .execute();
    const n = res.affected ?? 0;
    if (n) this.logger.warn(`[billing] ${n} 张账单已逾期未付，转 overdue`);
    return n;
  }

  onModuleInit() {
    const run = () => { this.markOverdue().catch((e) => this.logger.warn(`逾期任务失败: ${e?.message}`)); };
    const t = setTimeout(run, 60 * 1000);
    t.unref?.();
    const i = setInterval(run, 24 * 60 * 60 * 1000);
    i.unref?.();
  }

  // -------------------------------------------------------------- 收款（D5 手动登记）

  async registerPayment(
    actor: { id: number; username: string },
    invoiceId: number,
    input: { amountCents: number; provider?: string; providerRef?: string; note?: string },
  ) {
    const inv = await this.mustFind(invoiceId);
    if (inv.status !== 'issued' && inv.status !== 'overdue') {
      throw new BadRequestException(`账单 ${inv.number} 状态为 ${inv.status}，只有已发出/逾期的账单可登记收款`);
    }
    const amount = Math.round(Number(input.amountCents));
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('收款金额无效（分，正整数）');
    const provider = input.provider ?? 'manual';
    if (!PLATFORM_PROVIDER.includes(provider)) throw new BadRequestException(`未知收款通道: ${provider}`);

    await this.payments.insert({
      invoiceId, tenantId: inv.tenantId, provider,
      providerRef: input.providerRef ?? null,
      amountCents: String(amount), note: input.note ?? null,
      paidBy: actor.id, paidAt: new Date(),
    });
    const paidCents = await this.paidCents(invoiceId);
    if (isSettled(paidCents, Number(inv.amountCents))) {
      await this.invoices.update({ id: invoiceId }, { status: 'paid', paidAt: new Date() });
    }
    return this.getOneWithPayments(invoiceId);
  }

  async paidCents(invoiceId: number): Promise<number> {
    const rows: Array<{ sum: string | null }> = await this.payments.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS sum FROM payments WHERE invoice_id = $1`,
      [invoiceId],
    );
    return Number(rows[0]?.sum ?? 0);
  }

  // -------------------------------------------------------------- 查询

  private async mustFind(id: number): Promise<Invoice> {
    const inv = await this.invoices.findOne({ where: { id } });
    if (!inv) throw new NotFoundException(`账单 ${id} 不存在`);
    return inv;
  }

  /** 按账单号回读（insert 不回填实体 id，number 唯一，直接反查） */
  private async getOneByNumber(number: string) {
    const inv = await this.invoices.findOne({ where: { number } });
    if (!inv) throw new NotFoundException('账单创建后读取失败');
    return this.toDto(inv);
  }

  toDto(inv: Invoice) {
    return {
      id: Number(inv.id),
      tenantId: Number(inv.tenantId),
      number: inv.number,
      amountCents: Number(inv.amountCents),
      currency: inv.currency,
      status: inv.status,
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      dueAt: inv.dueAt,
      paidAt: inv.paidAt,
      detail: inv.detail,
      createdBy: inv.createdBy === null || inv.createdBy === undefined ? null : Number(inv.createdBy),
      createdAt: inv.createdAt,
    };
  }

  private payToDto(p: Payment) {
    return {
      id: Number(p.id),
      invoiceId: Number(p.invoiceId),
      tenantId: Number(p.tenantId),
      provider: p.provider,
      providerRef: p.providerRef,
      amountCents: Number(p.amountCents),
      note: p.note,
      paidBy: p.paidBy === null || p.paidBy === undefined ? null : Number(p.paidBy),
      paidAt: p.paidAt,
    };
  }

  async getOneWithPayments(id: number) {
    const inv = await this.mustFind(id);
    const pays = await this.payments.find({ where: { invoiceId: id }, order: { paidAt: 'ASC' } });
    const paidCents = pays.reduce((a, p) => a + Number(p.amountCents), 0);
    return {
      ...this.toDto(inv),
      paidCents,
      balanceCents: Math.max(0, Number(inv.amountCents) - paidCents),
      payments: pays.map((p) => this.payToDto(p)),
    };
  }

  /** 运营账单列表：可按租户/状态筛 */
  async listAll(q: { tenantId?: number; status?: string; page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, q.page ?? 1);
    const size = Math.min(200, q.pageSize ?? 20);
    const where: any = {};
    if (q.tenantId) where.tenantId = q.tenantId;
    if (q.status) where.status = q.status;
    const [rows, total] = await this.invoices.findAndCount({
      where, order: { createdAt: 'DESC' }, skip: (page - 1) * size, take: size,
    });
    // 批量补充已收金额（一次查询）
    const ids = rows.map((r) => Number(r.id));
    const paidMap: Record<number, number> = {};
    if (ids.length) {
      const sums: Array<{ invoice_id: string; sum: string }> = await this.payments.query(
        `SELECT invoice_id, SUM(amount_cents)::text AS sum FROM payments WHERE invoice_id IN (${ids.map((_, i) => `$${i + 1}`).join(',')}) GROUP BY invoice_id`,
        ids,
      );
      for (const s of sums) paidMap[Number(s.invoice_id)] = Number(s.sum);
    }
    return {
      items: rows.map((r) => ({
        ...this.toDto(r),
        paidCents: paidMap[Number(r.id)] ?? 0,
        balanceCents: Math.max(0, Number(r.amountCents) - (paidMap[Number(r.id)] ?? 0)),
      })),
      total, page, pageSize: size,
    };
  }

  /** 租户侧：只暴露已发出及之后的状态（草稿/作废不可见） */
  async listForTenant(tenantId: number) {
    const rows = await this.invoices.find({
      where: { tenantId, status: In(['issued', 'paid', 'overdue']) },
      order: { createdAt: 'DESC' },
      take: 120,
    });
    return Promise.all(rows.map(async (r) => {
      const paidCents = await this.paidCents(Number(r.id));
      return { ...this.toDto(r), paidCents, balanceCents: Math.max(0, Number(r.amountCents) - paidCents) };
    }));
  }

  /** 租户账单详情：含收款记录（对账用） */
  async getForTenant(tenantId: number, id: number) {
    const dto = await this.getOneWithPayments(id);
    if (dto.tenantId !== tenantId || dto.status === 'draft' || dto.status === 'void') {
      throw new NotFoundException('账单不存在');
    }
    return dto;
  }
}
