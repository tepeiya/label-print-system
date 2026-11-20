// =============================================================================
// AlertService —— 呆滞 / 效期预警（alert 模块，docs/11 §11.16）
// 规则 CRUD + 扫描引擎 + 预警事件处理 + 统计。判定逻辑全在 dead-stock.calc.ts 纯函数，
// 这里只做 IO：按租户取批次与最近出库台账 -> 逐批判定 -> fingerprint 幂等 upsert 事件。
// 所有查询强制 tenant_id；数值列（numeric/bigint 反射为 string）出参前 Number()。
// =============================================================================
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AlertRule, AlertEvent } from './alert.entity';
import { Material, StockBatch, StockMove } from './inventory.entity';
import {
  BatchSnapshot, RuleLike, evaluateBatch, eventFingerprint, normalizeRule, severityRank,
} from './dead-stock.calc';

export interface ScanReport {
  ruleId: number;
  ruleName: string;
  scanned: number;
  created: number;
  updated: number;
  cleared: number;
  hits: number;
}

export interface AlertSummary {
  total: number;
  open: number;
  ack: number;
  ignored: number;
  critical: number;
  byType: Record<string, number>;
}

const toYmd = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

@Injectable()
export class AlertService {
  constructor(
    @InjectRepository(AlertRule) private rules: Repository<AlertRule>,
    @InjectRepository(AlertEvent) private events: Repository<AlertEvent>,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(StockBatch) private batches: Repository<StockBatch>,
    @InjectRepository(StockMove) private moves: Repository<StockMove>,
  ) {}

  // ---------------- 规则 CRUD ----------------

  async listRules(tenantId: number, includeInactive = false) {
    const qb = this.rules.createQueryBuilder('r')
      .where('r.tenant_id = :tid', { tid: tenantId });
    if (!includeInactive) qb.andWhere('r.active = true');
    const rows = await qb.orderBy('r.id', 'ASC').getMany();
    return rows.map((r) => this.ruleDto(r));
  }

  async getRule(tenantId: number, id: number): Promise<AlertRule> {
    const row = await this.rules.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException(`预警规则不存在：${id}`);
    return row;
  }

  async createRule(tenantId: number, b: {
    name?: string; type?: string; idleDays?: number; criticalDays?: number;
    expiryDays?: number; minQty?: number; category?: string; active?: boolean;
  }) {
    const name = String(b.name ?? '').trim();
    if (!name) throw new BadRequestException('规则名称必填');
    const norm = normalizeRule(b as any);
    const row = this.rules.create({
      tenantId, name,
      type: norm.type,
      idleDays: norm.idleDays, criticalDays: norm.criticalDays, expiryDays: norm.expiryDays,
      minQty: String(norm.minQty),
      category: b.category ? String(b.category).trim() || null : null,
      active: b.active !== false,
    });
    const saved = await this.rules.save(row);
    return this.ruleDto(saved);
  }

  async updateRule(tenantId: number, id: number, b: {
    name?: string; type?: string; idleDays?: number; criticalDays?: number;
    expiryDays?: number; minQty?: number; category?: string; active?: boolean;
  }) {
    const row = await this.getRule(tenantId, id);
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) throw new BadRequestException('规则名称必填');
      row.name = name;
    }
    // 以现有值为底合并后统一规范化，保证 criticalDays >= idleDays
    const norm = normalizeRule({
      type: b.type ?? row.type,
      idleDays: b.idleDays ?? row.idleDays,
      criticalDays: b.criticalDays ?? row.criticalDays,
      expiryDays: b.expiryDays ?? row.expiryDays,
      minQty: b.minQty ?? Number(row.minQty),
    });
    row.type = norm.type;
    row.idleDays = norm.idleDays;
    row.criticalDays = norm.criticalDays;
    row.expiryDays = norm.expiryDays;
    row.minQty = String(norm.minQty);
    if (b.category !== undefined) row.category = b.category ? String(b.category).trim() || null : null;
    if (b.active !== undefined) row.active = b.active !== false;
    const saved = await this.rules.save(row);
    return this.ruleDto(saved);
  }

  async setRuleActive(tenantId: number, id: number, active: boolean) {
    const row = await this.getRule(tenantId, id);
    row.active = active;
    await this.rules.save(row);
    return this.ruleDto(row);
  }

  /** 删除规则及其事件（同租户事务外顺序执行，tenant_id 由 where 保证） */
  async deleteRule(tenantId: number, id: number) {
    await this.getRule(tenantId, id);
    await this.events.delete({ tenantId, ruleId: id });
    await this.rules.delete({ tenantId, id });
    return { id };
  }

  private ruleDto(r: AlertRule) {
    return {
      id: Number(r.id), name: r.name, type: r.type,
      idleDays: Number(r.idleDays), criticalDays: Number(r.criticalDays),
      expiryDays: Number(r.expiryDays), minQty: Number(r.minQty),
      category: r.category, active: r.active,
      createdAt: r.createdAt,
    };
  }

  // ---------------- 扫描引擎 ----------------

  /**
   * 执行扫描：取启用规则（可指定单条）→ 逐批判定 → 幂等 upsert 事件。
   * 已 hit 但事件消失（库存清空/规则变更）的批次，其仍 open 的历史事件会被清理，避免脏数据。
   */
  async scan(tenantId: number, ruleId?: number): Promise<ScanReport[]> {
    const qb = this.rules.createQueryBuilder('r')
      .where('r.tenant_id = :tid', { tid: tenantId })
      .andWhere('r.active = true');
    if (ruleId) qb.andWhere('r.id = :rid', { rid: ruleId });
    const ruleRows = await qb.orderBy('r.id', 'ASC').getMany();
    if (!ruleRows.length) {
      if (ruleId) throw new NotFoundException(`启用的预警规则不存在：${ruleId}`);
      return [];
    }

    // 批次 + 物料 + 仓库（一次性取本租户全部活跃批次，规模受 clamp 无关；预警是全量扫描）
    const batchRows = await this.batches.createQueryBuilder('sb')
      .innerJoin(Material, 'm', 'm.id = sb.material_id')
      .where('sb.tenant_id = :tid', { tid: tenantId })
      .andWhere('m.active = true')
      .select('sb.id', 'id').addSelect('sb.material_id', 'materialId')
      .addSelect('sb.warehouse_id', 'warehouseId').addSelect('sb.batch_no', 'batchNo')
      .addSelect('sb.qty', 'qty').addSelect('sb.created_at', 'createdAt')
      .addSelect('sb.expires_at', 'expiresAt')
      .addSelect('m.code', 'code').addSelect('m.name', 'name')
      .addSelect('m.spec', 'spec').addSelect('m.unit', 'unit')
      .addSelect('m.category', 'category')
      .getRawMany();

    // 最近出库日：按 material+warehouse+batch 聚合 kind='out' 的 max(created_at)
    const outRows = await this.moves.createQueryBuilder('sm')
      .where('sm.tenant_id = :tid', { tid: tenantId })
      .andWhere('sm.kind = :kind', { kind: 'out' })
      .select('sm.material_id', 'materialId').addSelect('sm.warehouse_id', 'warehouseId')
      .addSelect('sm.batch_no', 'batchNo').addSelect('MAX(sm.created_at)', 'lastOut')
      .groupBy('sm.material_id').addGroupBy('sm.warehouse_id').addGroupBy('sm.batch_no')
      .getRawMany();
    const outMap = new Map<string, string | null>();
    for (const r of outRows) {
      outMap.set(`${r.materialId}|${r.warehouseId}|${r.batchNo || ''}`, toYmd(r.lastOut));
    }

    const now = new Date();
    const reports: ScanReport[] = [];

    for (const r of ruleRows) {
      const norm = normalizeRule(r as any);
      const ruleLike: RuleLike = norm;
      const touchedFps = new Set<string>();
      let created = 0; let updated = 0; let hits = 0;

      for (const row of batchRows) {
        // 分类过滤（规则 category 非空时只扫该分类）
        if (r.category && String(row.category ?? '') !== r.category) continue;
        const snap: BatchSnapshot = {
          materialId: Number(row.materialId), warehouseId: Number(row.warehouseId),
          batchNo: String(row.batchNo || ''), qty: Number(row.qty),
          inboundDate: toYmd(row.createdAt) ?? now.toISOString().slice(0, 10),
          lastOutDate: outMap.get(`${row.materialId}|${row.warehouseId}|${row.batchNo || ''}`) ?? null,
          expiresAt: toYmd(row.expiresAt),
        };
        const v = evaluateBatch(snap, ruleLike, now);
        if (!v.hit) continue;
        hits += 1;
        const fp = eventFingerprint(tenantId, Number(r.id), snap);
        touchedFps.add(fp);

        const existing = await this.events.findOne({ where: { tenantId, fingerprint: fp } });
        const payload = {
          type: norm.type, materialId: snap.materialId, code: row.code, name: row.name,
          spec: row.spec ?? null, unit: row.unit || '件',
          warehouseId: snap.warehouseId, batchNo: snap.batchNo,
          qty: String(snap.qty), ageDays: v.ageDays, lastOutDays: v.lastOutDays,
          daysToExpire: v.daysToExpire, severity: v.severity!,
        };
        if (existing) {
          // 已确认/忽略的事件保留状态与处理痕迹，只刷新指标；open 则整体刷新
          const patch: Partial<AlertEvent> = { ...payload };
          if (existing.status === 'open') {
            Object.assign(patch, { status: 'open' as const, ackBy: null, ackNote: null, ackAt: null });
          }
          await this.events.update({ id: existing.id, tenantId }, patch);
          updated += 1;
        } else {
          await this.events.save(this.events.create({
            tenantId, ruleId: Number(r.id), fingerprint: fp, status: 'open', ...payload,
          }));
          created += 1;
        }
      }

      // 清理：该规则下仍 open、但本次未命中（库存清空/规则调整）的陈旧事件
      let cleared = 0;
      if (touchedFps.size) {
        const stale = await this.events.createQueryBuilder('e')
          .select('e.id', 'id').addSelect('e.fingerprint', 'fingerprint')
          .where('e.tenant_id = :tid', { tid: tenantId })
          .andWhere('e.rule_id = :rid', { rid: r.id })
          .andWhere('e.status = :st', { st: 'open' })
          .getRawMany();
        const staleIds = stale.filter((s) => !touchedFps.has(s.fingerprint)).map((s) => Number(s.id));
        if (staleIds.length) {
          await this.events.delete({ tenantId, id: In(staleIds) });
          cleared = staleIds.length;
        }
      }

      reports.push({
        ruleId: Number(r.id), ruleName: r.name,
        scanned: batchRows.length, created, updated, cleared, hits,
      });
    }
    return reports;
  }

  // ---------------- 事件查询 / 处理 ----------------

  async listEvents(tenantId: number, args: {
    keyword?: string; type?: string; severity?: string; status?: string; limit?: number;
  } = {}) {
    const limit = Math.min(100, Math.max(1, Math.floor(Number(args.limit ?? 50)) || 50));
    const qb = this.events.createQueryBuilder('e')
      .where('e.tenant_id = :tid', { tid: tenantId });
    if (args.type) qb.andWhere('e.type = :type', { type: args.type });
    if (args.severity) qb.andWhere('e.severity = :sev', { sev: args.severity });
    if (args.status) qb.andWhere('e.status = :st', { st: args.status });
    if (args.keyword) {
      const kw = `%${String(args.keyword).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      qb.andWhere('(e.code ILIKE :kw OR e.name ILIKE :kw OR e.batch_no ILIKE :kw)', { kw });
    }
    const total = await qb.getCount();
    const rows = await qb
      .orderBy("CASE e.severity WHEN 'critical' THEN 2 ELSE 1 END", 'DESC')
      .addOrderBy('e.created_at', 'DESC')
      .limit(limit).getMany();
    const items = rows.map((e) => this.eventDto(e));
    return { items, total, summary: await this.summary(tenantId) };
  }

  async ackEvent(tenantId: number, id: number, status: 'ack' | 'ignored', note: string | undefined, operator: string) {
    const row = await this.events.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException(`预警事件不存在：${id}`);
    row.status = status;
    row.ackBy = operator || '';
    row.ackNote = note ? String(note).slice(0, 300) : null;
    row.ackAt = new Date();
    await this.events.save(row);
    return this.eventDto(row);
  }

  async summary(tenantId: number): Promise<AlertSummary> {
    const rows = await this.events.createQueryBuilder('e')
      .select('e.status', 'status').addSelect('e.severity', 'severity')
      .addSelect('e.type', 'type').addSelect('COUNT(*)', 'cnt')
      .where('e.tenant_id = :tid', { tid: tenantId })
      .groupBy('e.status').addGroupBy('e.severity').addGroupBy('e.type')
      .getRawMany();
    const s: AlertSummary = { total: 0, open: 0, ack: 0, ignored: 0, critical: 0, byType: {} };
    for (const r of rows) {
      const n = Number(r.cnt);
      s.total += n;
      if (r.status in s) (s as any)[r.status] += n;
      if (r.severity === 'critical') s.critical += n;
      s.byType[r.type] = (s.byType[r.type] ?? 0) + n;
    }
    return s;
  }

  private eventDto(e: AlertEvent) {
    return {
      id: Number(e.id), ruleId: Number(e.ruleId), type: e.type,
      materialId: Number(e.materialId), code: e.code, name: e.name, spec: e.spec, unit: e.unit,
      warehouseId: Number(e.warehouseId), batchNo: e.batchNo,
      qty: Number(e.qty), ageDays: Number(e.ageDays), lastOutDays: Number(e.lastOutDays),
      daysToExpire: e.daysToExpire == null ? null : Number(e.daysToExpire),
      severity: e.severity, status: e.status,
      ackBy: e.ackBy, ackNote: e.ackNote, ackAt: e.ackAt,
      severityRank: severityRank(e.severity),
      createdAt: e.createdAt, updatedAt: e.updatedAt,
    };
  }
}
