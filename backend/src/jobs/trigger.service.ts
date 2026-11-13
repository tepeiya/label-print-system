// =============================================================================
// TriggerService —— P8.1 触发器 CRUD + 事件编排执行体
//
// 【多租户红线】业务侧一律「显式带 tenant_id 查本租户」：list/create/update/remove 用 useTenantId()，
//   emit 的候选集用 event.tenantId 显式过滤，planDeliveries 再逐条比较 rule.tenantId（跨租户硬拦截）。
//   后台事件没有 HTTP 上下文，由 TriggerProcessor 查目录库构造 TenantCtx 后 tenantStorage.run 注入。
//
// 【为什么不直接同步执行】HotFolder / 打印完成事件可能来自不同进程：
//   进程内 EventEmitter 跨 worker 不生效，统一入 BullMQ 'trigger' 队列，由 TriggerProcessor 消费。
//
// 【去重】dedupe_key 先查后写 + 部分唯一索引兜底 23505；命中重复直接跳过，不重复打印/重复发 Webhook。
// =============================================================================
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.module';
import { tenantStorage, useTenant, useTenantId, type TenantCtx } from '../common/tenant.context';
import { decrypt, encrypt } from '../datasource/sql-crypto';
import { NotificationService } from '../notify/notification.service';
import { PrintService } from '../print/print.service';
import { TriggerTestDto, TriggerUpsertDto } from './dto/trigger.dto';
import { PrintTrigger, TriggerDelivery } from './trigger.entity';
import {
  TRIGGER_JOB, TRIGGER_QUEUE, dedupeKey, fingerprint, normalizeRule, planDeliveries,
  publicConfig, type TriggerAction, type TriggerEvent, type TriggerRule, type TriggerSource,
} from './trigger.calc';
import { sendWebhook, webhookEnvelope } from './webhook.sender';

interface ActionOutcome { ok: boolean; httpStatus?: number; error?: string; detail?: any }

export interface EmitReport {
  source: string;
  tenantId: number;
  matched: number;
  skipped: number;
  results: Array<{ ruleId: number; status: string; httpStatus?: number; error?: string }>;
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && String((e as any).code ?? '') === '23505';
}

@Injectable()
export class TriggerService {
  private logger = new Logger('TriggerService');

  constructor(
    @InjectRepository(PrintTrigger) private rules: Repository<PrintTrigger>,
    @InjectRepository(TriggerDelivery) private deliveries: Repository<TriggerDelivery>,
    @InjectQueue(TRIGGER_QUEUE) private queue: Queue,
    private notifications: NotificationService,
    private print: PrintService,
    private audit: AuditService,
  ) {}

  private tid() { return useTenantId(); }

  /** 明文 secret → 密文 secretEnc；更新时未重填则保留旧密文，避免编辑一次就丢密钥 */
  private seal(config: Record<string, any>, prev?: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = { ...(config ?? {}) };
    delete out.secret;
    delete out.secretEnc;
    if (typeof config?.secret === 'string' && config.secret) out.secretEnc = encrypt(config.secret);
    else if (prev?.secretEnc) out.secretEnc = String(prev.secretEnc);
    return out;
  }

  private open(config: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = { ...(config ?? {}) };
    if (out.secretEnc) {
      try { out.secret = decrypt(String(out.secretEnc)); }
      catch { out.secret = ''; }
      delete out.secretEnc;
    }
    return out;
  }

  private toRule(r: PrintTrigger): TriggerRule {
    return {
      id: Number(r.id), tenantId: Number(r.tenantId), name: r.name,
      source: r.source as TriggerSource, conditionExpr: r.conditionExpr ?? null,
      action: r.action as TriggerAction, config: this.open(r.config ?? {}), enabled: !!r.enabled,
    };
  }

  // ------------------------------ CRUD ------------------------------

  async list() {
    const rows = await this.rules.find({ where: { tenantId: this.tid() }, order: { createdAt: 'DESC' } });
    return rows.map((r) => ({ ...r, config: publicConfig(r.config ?? {}) }));
  }

  async get(id: number) {
    const r = await this.rules.findOne({ where: { id, tenantId: this.tid() } });
    if (!r) throw new NotFoundException('触发器不存在');
    return { ...r, config: publicConfig(r.config ?? {}) };
  }

  async create(dto: TriggerUpsertDto) {
    const tenantId = this.tid();
    const v = normalizeRule(dto, { tenantId });
    if (!v.ok || !v.value) throw new BadRequestException(v.errors.join('；'));
    const row = await this.rules.save(this.rules.create({
      tenantId,
      name: v.value.name, source: v.value.source, conditionExpr: v.value.conditionExpr,
      action: v.value.action, config: this.seal(v.value.config), enabled: v.value.enabled,
      createdBy: useTenant().userId,
    }));
    await this.audit.write(tenantId, 'trigger.create', { id: row.id, source: row.source, action: row.action }, undefined, 'print_trigger', row.id);
    return { ...row, config: publicConfig(row.config) };
  }

  async update(id: number, dto: Partial<TriggerUpsertDto>) {
    const old = await this.rules.findOne({ where: { id, tenantId: this.tid() } });
    if (!old) throw new NotFoundException('触发器不存在');
    const merged = {
      name: dto.name ?? old.name,
      source: dto.source ?? old.source,
      action: dto.action ?? old.action,
      conditionExpr: dto.conditionExpr !== undefined ? dto.conditionExpr : old.conditionExpr,
      config: { ...this.open(old.config ?? {}), ...(dto.config ?? {}) },
      enabled: dto.enabled ?? old.enabled,
    };
    const v = normalizeRule(merged, { tenantId: Number(old.tenantId), id: Number(old.id) });
    if (!v.ok || !v.value) throw new BadRequestException(v.errors.join('；'));
    old.name = v.value.name;
    old.source = v.value.source;
    old.action = v.value.action;
    old.conditionExpr = v.value.conditionExpr;
    old.config = this.seal(v.value.config, old.config);
    old.enabled = v.value.enabled;
    const row = await this.rules.save(old);
    await this.audit.write(Number(old.tenantId), 'trigger.update', { id, source: row.source, enabled: row.enabled }, undefined, 'print_trigger', id);
    return { ...row, config: publicConfig(row.config) };
  }

  async remove(id: number) {
    const r = await this.rules.findOne({ where: { id, tenantId: this.tid() } });
    if (!r) throw new NotFoundException('触发器不存在');
    await this.rules.delete({ id, tenantId: this.tid() });
    // delivery 历史保留（审计需要），只删规则本身
    await this.audit.write(this.tid(), 'trigger.delete', { id, name: r.name }, undefined, 'print_trigger', id);
    return { ok: true };
  }

  /** 手动试跑：只返回命中计划，不 claim、不执行任何副作用（避免测试端点变成打印入口） */
  async test(id: number, dto: TriggerTestDto = {}) {
    const r = await this.rules.findOne({ where: { id, tenantId: this.tid() } });
    if (!r) throw new NotFoundException('触发器不存在');
    const ev: TriggerEvent = {
      source: r.source, tenantId: Number(r.tenantId),
      payload: dto.payload ?? {}, eventId: `test:${id}:${Date.now()}`, depth: 0,
    };
    const plan = planDeliveries([this.toRule(r)], ev);
    return {
      dryRun: true,
      rule: { id: Number(r.id), source: r.source, action: r.action, conditionExpr: r.conditionExpr },
      wouldDeliver: plan.deliveries.length,
      deliveries: plan.deliveries.map((d) => ({ dedupeKey: d.dedupeKey, reason: d.reason })),
      skipped: plan.skipped,
    };
  }

  /** 投递历史（追溯一次事件到底发出去没有） */
  async deliveriesOf(id: number, limit = 50) {
    await this.get(id);
    return this.deliveries.find({
      where: { triggerId: id, tenantId: this.tid() },
      order: { createdAt: 'DESC' }, take: Math.min(200, Math.max(1, limit)),
    });
  }

  // ------------------------------ 入队 ------------------------------

  /** 统一入队口：HotFolder / PrintProcessor 都调这里，jobId 用事件指纹天然去重 */
  async enqueue(event: TriggerEvent): Promise<{ enqueued: boolean; jobId: string; reason?: string }> {
    const jobId = `trig:${fingerprint({
      tenantId: event.tenantId, source: event.source,
      eventId: event.eventId ?? null, payload: event.payload,
    })}`.slice(0, 120);
    try {
      await this.queue.add(TRIGGER_JOB, { event }, {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      });
      return { enqueued: true, jobId };
    } catch (e: any) {
      this.logger.warn(`触发器事件入队失败（不阻断主链路）：${e?.message ?? e}`);
      return { enqueued: false, jobId, reason: String(e?.message ?? e).slice(0, 200) };
    }
  }

  // ------------------------------ 执行 ------------------------------

  /** 事件编排主入口；ctx 由后台 Processor 传入，HTTP 上下文里已有 ALS 时不覆盖 */
  async emit(event: TriggerEvent, ctx?: TenantCtx): Promise<EmitReport> {
    const work = async (): Promise<EmitReport> => {
      // 显式带 tenant_id：候选集只查本租户启用的规则
      const rows = await this.rules.find({
        where: { tenantId: event.tenantId, enabled: true }, order: { id: 'ASC' },
      });
      const plan = planDeliveries(rows.map((r) => this.toRule(r)), event);
      const results: EmitReport['results'] = [];

      for (const d of plan.deliveries) {
        const claimed = await this.claim(event, d.dedupeKey, d.rule.id);
        if (!claimed) {
          results.push({ ruleId: d.rule.id, status: 'duplicate' });
          continue;
        }
        const t0 = Date.now();
        let outcome: ActionOutcome;
        try { outcome = await this.runAction(d.rule, event); }
        catch (e: any) { outcome = { ok: false, error: String(e?.message ?? e).slice(0, 300) }; }
        await this.finish(claimed, outcome, Date.now() - t0);
        results.push({
          ruleId: d.rule.id, status: outcome.ok ? 'success' : 'failed',
          httpStatus: outcome.httpStatus, error: outcome.error,
        });
      }
      return {
        source: String(event.source), tenantId: Number(event.tenantId),
        matched: plan.deliveries.length, skipped: plan.skipped.length, results,
      };
    };
    return (!ctx || tenantStorage.getStore()) ? work() : tenantStorage.run(ctx, work);
  }

  /** 先查后写 + 唯一索引兜并发；命中即判重复（pending 残留也不重投，避免重复打印） */
  private async claim(event: TriggerEvent, key: string, triggerId: number): Promise<TriggerDelivery | null> {
    const exists = await this.deliveries.findOne({ where: { tenantId: event.tenantId, dedupeKey: key } });
    if (exists) return null;
    try {
      return await this.deliveries.save(this.deliveries.create({
        tenantId: event.tenantId, triggerId,
        eventSource: String(event.source), dedupeKey: key, status: 'pending',
        metadata: { eventId: event.eventId ?? null },
      }));
    } catch (e) {
      if (isUniqueViolation(e)) {
        const row = await this.deliveries.findOne({ where: { tenantId: event.tenantId, dedupeKey: key } });
        if (row) return null;
        this.logger.warn(`dedupe 冲突但回查未命中 tenant=${event.tenantId} key=${key}`);
      }
      throw e;
    }
  }

  private async finish(row: TriggerDelivery, outcome: ActionOutcome, durationMs: number) {
    await this.deliveries.update({ id: row.id, tenantId: row.tenantId }, {
      status: outcome.ok ? 'success' : 'failed',
      httpStatus: outcome.httpStatus ?? null,
      errorMsg: outcome.error ?? null,
      durationMs,
    });
    // 显式 actorId=0：后台触发没有登录用户，不能让 audit.write 回退到 useTenant()
    await this.audit.write(
      Number(row.tenantId), 'trigger.delivery',
      { triggerId: Number(row.triggerId), source: row.eventSource, ok: outcome.ok, error: outcome.error ?? null },
      0, 'print_trigger', Number(row.triggerId),
    );
  }

  private async runAction(rule: TriggerRule, event: TriggerEvent): Promise<ActionOutcome> {
    const cfg = rule.config ?? {};
    if (rule.action === 'webhook') {
      const o = await sendWebhook(
        String(cfg.url ?? ''), String(cfg.secret ?? ''), webhookEnvelope(event),
        { allowHttpLoopback: cfg.allowHttpLoopback === true },
      );
      return { ok: o.ok, httpStatus: o.httpStatus, error: o.error };
    }
    if (rule.action === 'notification') {
      await this.notifications.publish({
        tenantId: Number(rule.tenantId),   // 显式租户，不由任务上下文隐式推断
        category: String(cfg.category ?? 'trigger'),
        title: String(cfg.title ?? ''),
        body: String(cfg.body ?? ''),
        dedupeKey: `trigger:${rule.id}:${event.eventId ?? fingerprint(event.payload)}`.slice(0, 160),
        metadata: { source: event.source, triggerId: rule.id },
      });
      return { ok: true };
    }
    if (rule.action === 'print') {
      const rows = Array.isArray(event.payload?.rows) && event.payload.rows.length ? event.payload.rows : [{}];
      const job = await this.print.createJob({
        templateId: Number(cfg.templateId),
        printerId: cfg.printerId ? Number(cfg.printerId) : undefined,
        rows,
        copies: Number(cfg.copies ?? 1),
      });
      return { ok: true, detail: { jobId: job.jobId } };
    }
    return { ok: false, error: `未实现的动作：${rule.action}` };
  }
}

/** 供 Processor / HotFolder 复用的去重键（导出便于单测） */
export function eventDedupeKey(ruleId: number, event: TriggerEvent): string {
  return dedupeKey(ruleId, event);
}
