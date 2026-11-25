// =============================================================================
// ShipmentService —— 成品发运（WMS 阶段三，2026-11-25）
//
// 边界（与库存调整单同一条硬约束）：
//   · 本服务**不直接读写 stock_batches / stock_moves**；出库过账逐行调
//     InventoryGateway.decreaseStock（FIFO / 行锁 / 事务台账 / 幂等全在 Gate/InventoryService）。
//   · 单据号写进台账 reason 前缀 `[SH-YYYYMMDD-NNNN] …`，台账可反查发货单。
//   · 拣货不动物理库存（本项目无同仓移库能力）：拣货只确认「发哪批、发多少」，
//     真正扣减发生在出库过账；因此已拣未发的单可以安全作废。
//   · 出库过账后才联动 UDI（SHIP → SHIPPED）：扫码失败不回滚库存（库存是已发生的事实），
//     失败原因落 udi_result 并在返回里提示——宁可让账实相符，也不假装没发货。
// =============================================================================
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WmsShipment, WmsShipmentLine } from '../entities/shipment.entity';
import { Material, Warehouse, WarehouseLocation } from '../../../inventory/inventory.entity';
import { InventoryGateway } from '../../gateways/inventory.gateway';
import { UdiTraceService } from '../../../udi/udi.trace.service';
import { AuditService } from '../../../audit/audit.module';
import { useTenant, useTenantId } from '../../../common/tenant.context';
import { allocateBatches } from '../../issuing/services/batch-alloc.calc';
import { round3 } from '../../../inventory/kit.calc';
import {
  formatShipmentNo, assertCanPost, assertCanCancel, assertCanSign, assertPickQty,
  nextPickStatus, resolveShipQty, SHIP_TYPE_TEXT, SHIP_STATUS_TEXT, SHIP_LINE_STATUS_TEXT, type ShipType,
} from './shipment.calc';

export interface ShipLineInput {
  sku: string;
  qtyPlan: number;
  batchNo?: string;
  locationId?: number;
  packSscc?: string;
  udiCodes?: string[];
}

export interface ShipInput {
  shipType?: ShipType;
  warehouseId?: number;
  warehouseCode?: string;
  customerCode?: string;
  customerName?: string;
  shipTo?: string;
  carrier?: string;
  trackingNo?: string;
  expectedDate?: string;
  remark?: string;
  lines: ShipLineInput[];
}

export interface PickInput {
  qty: number;
  batchNo?: string;
  locationId?: number;
  packSscc?: string;
  udiCodes?: string[];
}

@Injectable()
export class ShipmentService {
  private readonly log = new Logger(ShipmentService.name);

  constructor(
    @InjectRepository(WmsShipment) private docs: Repository<WmsShipment>,
    @InjectRepository(WmsShipmentLine) private lines: Repository<WmsShipmentLine>,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(Warehouse) private warehouses: Repository<Warehouse>,
    @InjectRepository(WarehouseLocation) private locations: Repository<WarehouseLocation>,
    private gate: InventoryGateway,
    private audit: AuditService,
    @Optional() private udi?: UdiTraceService,
  ) {}

  // ---------------------------------------------------------------- 查询

  async list(tenantId: number, q: { status?: string; shipType?: string; keyword?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
    const qb = this.docs.createQueryBuilder('d')
      .where('d.tenant_id = :tenantId', { tenantId })
      .orderBy('d.id', 'DESC');
    if (q.status) qb.andWhere('d.status = :status', { status: q.status });
    if (q.shipType) qb.andWhere('d.ship_type = :t', { t: q.shipType });
    if (q.keyword) {
      qb.andWhere('(d.shipment_no ILIKE :kw OR d.customer_name ILIKE :kw OR d.tracking_no ILIKE :kw)', { kw: `%${q.keyword}%` });
    }
    const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();

    const whs = new Map<number, string>();
    for (const w of await this.warehouses.find({ where: { tenantId } })) whs.set(Number(w.id), `${w.code} ${w.name}`);

    const ids = rows.map((r) => Number(r.id));
    const stats = new Map<number, { total: number; picked: number; shipped: number; qtyPlan: number }>();
    if (ids.length) {
      const agg = await this.lines.createQueryBuilder('l')
        .select('l.shipment_id', 'sid')
        .addSelect('COUNT(*)', 'n')
        .addSelect(`SUM(CASE WHEN l.status IN ('PICKED','SHIPPED','SHORT') THEN 1 ELSE 0 END)`, 'picked')
        .addSelect(`SUM(CASE WHEN l.status IN ('SHIPPED','SHORT') THEN 1 ELSE 0 END)`, 'shipped')
        .addSelect('SUM(l.qty_plan)', 'qtyPlan')
        .where('l.tenant_id = :tenantId', { tenantId })
        .andWhere('l.shipment_id IN (:...ids)', { ids })
        .groupBy('l.shipment_id')
        .getRawMany();
      for (const a of agg) {
        stats.set(Number(a.sid), {
          total: Number(a.n), picked: Number(a.picked), shipped: Number(a.shipped), qtyPlan: Number(a.qtyPlan),
        });
      }
    }

    return {
      total, page, pageSize,
      items: rows.map((d) => {
        const s = stats.get(Number(d.id)) ?? { total: 0, picked: 0, shipped: 0, qtyPlan: 0 };
        return {
          id: Number(d.id), shipmentNo: d.shipmentNo, shipType: d.shipType, shipTypeText: SHIP_TYPE_TEXT[d.shipType as ShipType] ?? d.shipType,
          warehouseId: Number(d.warehouseId), warehouse: whs.get(Number(d.warehouseId)) ?? String(d.warehouseId),
          customerName: d.customerName, customerCode: d.customerCode, carrier: d.carrier, trackingNo: d.trackingNo,
          expectedDate: d.expectedDate, status: d.status, statusText: SHIP_STATUS_TEXT[d.status] ?? d.status,
          lineCount: s.total, pickedLines: s.picked, shippedLines: s.shipped, qtyPlan: s.qtyPlan,
          createdAt: d.createdAt, shippedAt: d.shippedAt, signedAt: d.signedAt,
        };
      }),
    };
  }

  async detail(tenantId: number, id: number) {
    const doc = await this.docs.findOne({ where: { tenantId, id } });
    if (!doc) throw new NotFoundException('发货单不存在');
    const lines = await this.lines.find({ where: { tenantId, shipmentId: id }, order: { lineNo: 'ASC' } });

    const mats = new Map<number, { code: string; name: string; unit: string }>();
    for (const l of lines) {
      if (mats.has(Number(l.materialId))) continue;
      const m = await this.materials.findOne({ where: { tenantId, id: Number(l.materialId) } });
      if (m) mats.set(Number(m.id), { code: m.code, name: m.name, unit: m.unit });
    }
    const wh = await this.warehouses.findOne({ where: { tenantId, id: Number(doc.warehouseId) } });
    const locRows = await this.locations.find({ where: { tenantId } });
    const locs = new Map<number, string>();
    for (const l of locRows) locs.set(Number(l.id), `${l.code} ${l.name}`);

    return {
      id: Number(doc.id), shipmentNo: doc.shipmentNo, shipType: doc.shipType,
      shipTypeText: SHIP_TYPE_TEXT[doc.shipType as ShipType] ?? doc.shipType,
      status: doc.status, statusText: SHIP_STATUS_TEXT[doc.status] ?? doc.status,
      warehouseId: Number(doc.warehouseId),
      warehouse: wh ? { id: Number(wh.id), code: wh.code, name: wh.name } : null,
      customerCode: doc.customerCode, customerName: doc.customerName, shipTo: doc.shipTo,
      carrier: doc.carrier, trackingNo: doc.trackingNo, expectedDate: doc.expectedDate, remark: doc.remark,
      createdBy: doc.createdBy ? Number(doc.createdBy) : null,
      pickedAt: doc.pickedAt, shippedBy: doc.shippedBy ? Number(doc.shippedBy) : null, shippedAt: doc.shippedAt,
      signedReceiver: doc.signedReceiver, signedAt: doc.signedAt,
      cancelReason: doc.cancelReason, cancelledAt: doc.cancelledAt, createdAt: doc.createdAt,
      lines: lines.map((l) => {
        const m = mats.get(Number(l.materialId));
        return {
          id: Number(l.id), lineNo: l.lineNo, materialId: Number(l.materialId),
          skuCode: l.skuCode, materialName: m?.name ?? '', unit: m?.unit ?? '',
          batchNo: l.batchNo, locationId: l.locationId ? Number(l.locationId) : null,
          locationText: l.locationId ? (locs.get(Number(l.locationId)) ?? String(l.locationId)) : null,
          packSscc: l.packSscc, udiCodes: l.udiCodes ?? [],
          qtyPlan: Number(l.qtyPlan), qtyPicked: Number(l.qtyPicked), qtyShipped: Number(l.qtyShipped),
          qtyBefore: l.qtyBefore != null ? Number(l.qtyBefore) : null,
          qtyAfter: l.qtyAfter != null ? Number(l.qtyAfter) : null,
          status: l.status, statusText: SHIP_LINE_STATUS_TEXT[l.status] ?? l.status,
          udiResult: l.udiResult, error: l.error, pickedAt: l.pickedAt, shippedAt: l.shippedAt,
        };
      }),
    };
  }

  // ---------------------------------------------------------------- 建单

  async create(tenantId: number, dto: ShipInput, userId: number | null) {
    const type = (dto.shipType ?? 'SALES') as ShipType;
    if (!SHIP_TYPE_TEXT[type]) throw new BadRequestException(`未知出库类型：${type}`);
    if (!Array.isArray(dto.lines) || dto.lines.length === 0) throw new BadRequestException('至少要有 1 行发货明细');
    if (dto.lines.length > 100) throw new BadRequestException('单张发货单最多 100 行');

    const warehouse = await this.resolveWarehouse(tenantId, dto);
    const prepared: Array<{ material: Material; input: ShipLineInput; qtyPlan: number }> = [];
    for (let i = 0; i < dto.lines.length; i++) {
      const l = dto.lines[i];
      const code = String(l?.sku ?? '').trim();
      if (!code) throw new BadRequestException(`第 ${i + 1} 行：物料必填`);
      const qtyPlan = Number(l.qtyPlan);
      if (!Number.isFinite(qtyPlan) || qtyPlan <= 0) throw new BadRequestException(`第 ${i + 1} 行：发货数量必须为正数`);
      const material = await this.materials.findOne({ where: { tenantId, code } });
      if (!material) throw new BadRequestException(`第 ${i + 1} 行：物料不存在（${code}）`);
      if (l.locationId != null) {
        const loc = await this.locations.findOne({ where: { tenantId, id: Number(l.locationId), warehouseId: Number(warehouse.id) } });
        if (!loc) throw new BadRequestException(`第 ${i + 1} 行：库位不存在或不属于该仓库`);
      }
      prepared.push({ material, input: l, qtyPlan });
    }
    if (!dto.customerName?.trim() && type === 'SALES') throw new BadRequestException('销售出库必须填客户名称');

    const doc = await this.insertWithNo(tenantId, {
      tenantId, shipType: type, warehouseId: Number(warehouse.id),
      customerCode: dto.customerCode?.trim() || null, customerName: dto.customerName?.trim() || null,
      shipTo: dto.shipTo?.trim() || null, carrier: dto.carrier?.trim() || null,
      trackingNo: dto.trackingNo?.trim() || null, expectedDate: dto.expectedDate?.slice(0, 10) || null,
      remark: dto.remark?.trim() || null, status: 'CREATED', createdBy: userId,
    });

    const rows = prepared.map((p, idx) => this.lines.create({
      tenantId, shipmentId: Number(doc.id), lineNo: idx + 1,
      materialId: Number(p.material.id), skuCode: p.material.code,
      batchNo: p.input.batchNo?.trim() || null, locationId: p.input.locationId ?? null,
      packSscc: p.input.packSscc?.trim() || null, udiCodes: p.input.udiCodes?.length ? p.input.udiCodes : null,
      qtyPlan: String(p.qtyPlan), qtyPicked: '0', qtyShipped: '0', status: 'PENDING',
    }));
    await this.lines.save(rows);
    void this.audit.write(tenantId, 'wms.shipment.create', {
      shipmentId: Number(doc.id), shipmentNo: doc.shipmentNo, lines: rows.length, customer: doc.customerName,
    });
    return this.detail(tenantId, Number(doc.id));
  }

  /** 单号 SH-YYYYMMDD-NNNN：按当日已有张数 +1，唯一索引撞了重试 */
  private async insertWithNo(tenantId: number, patch: Partial<WmsShipment>): Promise<WmsShipment> {
    const d = new Date();
    const ymd = formatShipmentNo(d, 0).slice(3, 11);
    for (let attempt = 0; attempt < 6; attempt++) {
      const seqRow = await this.docs.createQueryBuilder('d')
        .where('d.tenant_id = :tenantId', { tenantId })
        .andWhere('d.shipment_no LIKE :p', { p: `SH-${ymd}-%` })
        .select('COUNT(*)', 'n')
        .getRawOne();
      const n = Number(seqRow?.n ?? 0) + 1 + attempt;
      const shipmentNo = formatShipmentNo(d, n);
      try {
        return await this.docs.save(this.docs.create({ ...patch, shipmentNo } as WmsShipment));
      } catch (e: any) {
        if (String(e?.code) === '23505' || /duplicate key/i.test(String(e?.message))) continue;
        throw e;
      }
    }
    throw new BadRequestException('发货单号生成冲突，请重试');
  }

  private async resolveWarehouse(tenantId: number, dto: { warehouseId?: number; warehouseCode?: string }): Promise<Warehouse> {
    if (dto.warehouseId) {
      const w = await this.warehouses.findOne({ where: { tenantId, id: Number(dto.warehouseId) } });
      if (!w) throw new BadRequestException('仓库不存在');
      return w;
    }
    if (dto.warehouseCode) {
      const w = await this.warehouses.findOne({ where: { tenantId, code: String(dto.warehouseCode).trim() } });
      if (!w) throw new BadRequestException(`仓库不存在：${dto.warehouseCode}`);
      return w;
    }
    throw new BadRequestException('请选择仓库');
  }

  // ---------------------------------------------------------------- 拣货推荐

  /**
   * 按行给出 FIFO 批次建议（复用发料的 allocateBatches：效期优先 + 过期提醒 + 缺口）。
   * 只读：不占库存、不锁批次，真正扣减在过账时由 InventoryService 加锁复核。
   */
  async recommend(tenantId: number, id: number) {
    const doc = await this.docs.findOne({ where: { tenantId, id } });
    if (!doc) throw new NotFoundException('发货单不存在');
    if (doc.status === 'CANCELLED') throw new BadRequestException('已作废的发货单无需拣货');
    const lines = await this.lines.find({ where: { tenantId, shipmentId: id }, order: { lineNo: 'ASC' } });
    const wh = await this.warehouses.findOne({ where: { tenantId, id: Number(doc.warehouseId) } });

    const out: any[] = [];
    for (const l of lines) {
      if (l.status === 'SHIPPED' || l.status === 'SHORT') {
        out.push({ lineId: Number(l.id), lineNo: l.lineNo, skuCode: l.skuCode, qtyPlan: Number(l.qtyPlan), allocations: [], allocated: 0, shortage: 0, note: '该行已出库' });
        continue;
      }
      const batches = wh
        ? await this.gate.queryBatches({ tenantId, skuId: Number(l.materialId), warehouseId: Number(doc.warehouseId) })
        : [];
      const alloc = allocateBatches(batches as any, Number(l.qtyPlan), { batchNo: l.batchNo ?? null });
      const locs = new Map<number, string>();
      for (const b of batches as any[]) if (b.locationId) locs.set(Number(b.locationId), '');
      out.push({
        lineId: Number(l.id), lineNo: l.lineNo, skuCode: l.skuCode, materialId: Number(l.materialId), qtyPlan: Number(l.qtyPlan),
        allocations: alloc.allocations, allocated: alloc.allocated, shortage: alloc.shortage,
        expiredPicked: alloc.expiredPicked, reason: alloc.reason ?? null,
      });
    }
    return { shipmentNo: doc.shipmentNo, status: doc.status, lines: out };
  }

  // ---------------------------------------------------------------- 拣货

  async pick(tenantId: number, id: number, lineId: number, dto: PickInput, userId: number | null) {
    const doc = await this.docs.findOne({ where: { tenantId, id } });
    if (!doc) throw new NotFoundException('发货单不存在');
    if (doc.status === 'CANCELLED') throw new BadRequestException('已作废的发货单不能拣货');
    if (doc.status === 'SHIPPED' || doc.status === 'SIGNED') throw new BadRequestException('已出库的发货单不能再拣货');
    const line = await this.lines.findOne({ where: { tenantId, id: lineId, shipmentId: id } });
    if (!line) throw new NotFoundException('发货单行不存在');

    const qty = Number(dto.qty);
    assertPickQty(qty, Number(line.qtyPlan), line.lineNo);
    if (dto.locationId != null) {
      const loc = await this.locations.findOne({ where: { tenantId, id: Number(dto.locationId), warehouseId: Number(doc.warehouseId), active: true } });
      if (!loc) throw new BadRequestException('库位不存在或不属于该仓库');
    }

    const patch: Partial<WmsShipmentLine> = {
      qtyPicked: String(qty), status: 'PICKED', pickedAt: new Date(),
    };
    if (dto.batchNo !== undefined) patch.batchNo = dto.batchNo?.trim() || null;
    if (dto.locationId !== undefined) patch.locationId = dto.locationId ?? null;
    if (dto.packSscc !== undefined) patch.packSscc = dto.packSscc?.trim() || null;
    if (dto.udiCodes !== undefined) patch.udiCodes = dto.udiCodes?.length ? dto.udiCodes : null;
    await this.lines.update({ id: line.id }, patch);

    const after = await this.lines.find({ where: { tenantId, shipmentId: id } });
    const status = nextPickStatus(after.map((l) => l.status));
    if (status !== doc.status) await this.docs.update({ id }, { status, pickedAt: new Date() });
    void this.audit.write(tenantId, 'wms.shipment.pick', {
      shipmentId: id, shipmentNo: doc.shipmentNo, lineNo: line.lineNo, qty, batchNo: patch.batchNo ?? line.batchNo,
    });
    return this.detail(tenantId, id);
  }

  // ---------------------------------------------------------------- 出库过账

  async post(tenantId: number, id: number, userId: number | null) {
    const doc = await this.docs.findOne({ where: { tenantId, id } });
    if (!doc) throw new NotFoundException('发货单不存在');
    assertCanPost(doc.status);

    const wh = await this.warehouses.findOne({ where: { tenantId, id: Number(doc.warehouseId) } });
    if (!wh) throw new BadRequestException('单据上的仓库已不存在，无法过账');
    const lines = await this.lines.find({ where: { tenantId, shipmentId: id }, order: { lineNo: 'ASC' } });
    const todo = lines.filter((l) => l.status !== 'SHIPPED' && l.status !== 'SHORT');
    if (!todo.length) throw new BadRequestException('没有待出库的行');

    const tag = `[${doc.shipmentNo}] ${SHIP_TYPE_TEXT[doc.shipType as ShipType]}${doc.customerName ? '：' + doc.customerName : ''}`;
    const results: any[] = [];
    let stopped = false;

    for (const l of todo) {
      if (stopped) {
        results.push({ lineNo: l.lineNo, status: 'SKIPPED', message: '前一行失败，本次未执行' });
        continue;
      }
      const plan = resolveShipQty({ qtyPlan: Number(l.qtyPlan), qtyPicked: Number(l.qtyPicked), status: l.status });
      try {
        const outcome = await this.gate.decreaseStock({
          tenantId, skuId: Number(l.materialId), warehouseId: Number(doc.warehouseId),
          locationId: l.locationId ?? null, batchNo: l.batchNo ?? undefined,
          qty: plan.qty, refType: 'wms_shipment', refNo: doc.shipmentNo,
          idempotencyKey: `ship:${doc.shipmentNo}:${l.lineNo}`,
        });
        // UDI 联动（失败不阻塞库存，只落 warning）
        let udiResult: Record<string, any> | null = null;
        if (this.udi && (l.packSscc || (l.udiCodes && l.udiCodes.length))) {
          udiResult = await this.linkUdi(doc, l);
        }
        // 台账余量：Gateway 只回 movementId，出参需要的 before/after 用扣减后的可用量反推
        const afterQty = await this.gate.queryAvailable({
          tenantId, skuId: Number(l.materialId), warehouseId: Number(doc.warehouseId), batchNo: l.batchNo ?? undefined,
        });
        await this.lines.update({ id: l.id }, {
          status: plan.short > 0 ? 'SHORT' : 'SHIPPED',
          qtyShipped: String(plan.qty), shippedAt: new Date(), error: null,
          qtyAfter: String(afterQty.qty),
          qtyBefore: String(round3(afterQty.qty + plan.qty)),
          udiResult: udiResult ?? null,
        });
        results.push({ lineNo: l.lineNo, status: 'DONE', qty: plan.qty, short: plan.short, udi: udiResult });
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 200);
        await this.lines.update({ id: l.id }, { status: 'FAILED', error: msg });
        results.push({ lineNo: l.lineNo, status: 'FAILED', message: msg });
        stopped = true;
      }
    }

    const after = await this.lines.find({ where: { tenantId, shipmentId: id } });
    const shippedQty = after.reduce((s, l) => s + Number(l.qtyShipped), 0);
    const anyShipped = after.some((l) => l.status === 'SHIPPED' || l.status === 'SHORT');
    const allDone = after.every((l) => l.status === 'SHIPPED' || l.status === 'SHORT');
    if (anyShipped) {
      await this.docs.update({ id }, {
        status: allDone ? 'SHIPPED' : doc.status,
        shippedBy: userId ?? null, shippedAt: new Date(),
      });
    }
    // 一行都没发出去（例如质量闸门拦下、库存不足）→ 整单失败，抛 400 带原因。
    // 之前会返回 201 + results 里埋 FAILED，前端看一眼就以为发货成功——质量闸门的拦截必须显性化。
    if (!anyShipped && results.some((r) => r.status === 'FAILED')) {
      const first = results.find((r) => r.status === 'FAILED');
      throw new BadRequestException(`发货失败：${first?.message ?? '未知原因'}`);
    }
    void this.audit.write(tenantId, 'wms.shipment.post', {
      shipmentId: id, shipmentNo: doc.shipmentNo, allDone, shippedQty, failed: results.filter((r) => r.status === 'FAILED').length,
    });
    return { shipment: await this.detail(tenantId, id), results, allDone, shippedQty };
  }

  /** 出库时的 UDI 联动：先按 SSCC 发包，再逐个单品码；任何失败只记录，不抛 */
  private async linkUdi(doc: WmsShipment, line: WmsShipmentLine): Promise<Record<string, any>> {
    const out: Record<string, any> = { sscc: null, codes: null };
    const base = {
      shipmentNo: doc.shipmentNo, lineNo: line.lineNo,
      customerName: doc.customerName, carrier: doc.carrier, trackingNo: doc.trackingNo,
    };
    if (line.packSscc) {
      try {
        out.sscc = await this.udi!.shipPackage({ sscc: line.packSscc, ...base });
      } catch (e: any) {
        out.sscc = { error: String(e?.message ?? e).slice(0, 200) };
      }
    }
    if (line.udiCodes?.length) {
      const rs: any[] = [];
      for (const code of line.udiCodes) {
        try {
          const r = await this.udi!.shipByScan({ code, ...base });
          rs.push({ code, ok: true, idempotent: r.idempotent, status: r.status });
        } catch (e: any) {
          rs.push({ code, ok: false, reason: String(e?.message ?? e).slice(0, 200) });
        }
      }
      out.codes = {
        total: rs.length, ok: rs.filter((r) => r.ok).length, failed: rs.filter((r) => !r.ok).length,
        errors: rs.filter((r) => !r.ok).slice(0, 5),
      };
    }
    return out;
  }

  // ---------------------------------------------------------------- 签收

  async sign(tenantId: number, id: number, receiver: string | undefined, userId: number | null) {
    const doc = await this.docs.findOne({ where: { tenantId, id } });
    if (!doc) throw new NotFoundException('发货单不存在');
    assertCanSign(doc.status);
    await this.docs.update({ id }, {
      status: 'SIGNED', signedBy: userId ?? null, signedReceiver: String(receiver ?? '').trim().slice(0, 80) || '客户签收',
      signedAt: new Date(),
    });
    void this.audit.write(tenantId, 'wms.shipment.sign', { shipmentId: id, shipmentNo: doc.shipmentNo, receiver: receiver ?? null });
    return this.detail(tenantId, id);
  }

  // ---------------------------------------------------------------- 作废

  async cancel(tenantId: number, id: number, reason: string, userId: number | null) {
    const doc = await this.docs.findOne({ where: { tenantId, id } });
    if (!doc) throw new NotFoundException('发货单不存在');
    assertCanCancel(doc.status);
    const lines = await this.lines.find({ where: { tenantId, shipmentId: id } });
    const done = lines.filter((l) => l.status === 'SHIPPED' || l.status === 'SHORT').length;
    if (done > 0) throw new BadRequestException('本单已有行出库，不能整单作废（请走退货入库）');
    await this.docs.update({ id }, {
      status: 'CANCELLED', cancelledBy: userId ?? null, cancelledAt: new Date(),
      cancelReason: String(reason ?? '').trim().slice(0, 200) || '手工作废',
    });
    void this.audit.write(tenantId, 'wms.shipment.cancel', { shipmentId: id, shipmentNo: doc.shipmentNo, reason: reason ?? null });
    return this.detail(tenantId, id);
  }
}
