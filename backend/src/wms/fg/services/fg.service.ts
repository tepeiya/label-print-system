// =============================================================================
// FgService —— 成品入库（wms.fg）
//
// 边界：
//   · 本服务不直接读写 stock_batches / stock_moves；过账逐行调
//     InventoryGateway.increaseStock（批次/台账/幂等/质量初始状态都在 Gate）。
//   · 单据号写进台账 reason 前缀 `[FG-YYYYMMDD-NNNN] 成品入库：WO-xxx`，台账可反查单据。
//   · 无 MES 时的完工口径：工单须发料完成（ISSUED / CLOSED）才能报工入库；
//     起因为「工单还在发料中就把成品报入库」会让原料账与成品账同时失真。
//   · 累计入库不超工单需求（超交直接拦），数量允许 3 位小数。
// =============================================================================
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WmsFgReceipt, WmsFgReceiptLine } from '../entities/fg.entity';
import { Material, Warehouse, WarehouseLocation } from '../../../inventory/inventory.entity';
import { WmsWorkOrder } from '../../issuing/entities/wo.entity';
import { InventoryGateway } from '../../gateways/inventory.gateway';
import { AuditService } from '../../../audit/audit.module';
import { useTenant, useTenantId } from '../../../common/tenant.context';
import { round3 } from '../../../inventory/kit.calc';
import {
  formatFgNo, assertCanPost, assertCanCancel, assertQty, assertNotOverDemand,
  resolveQcStatus, assertWoReadyForCompletion, FG_STATUS_TEXT, FG_LINE_STATUS_TEXT,
} from './fg.calc';

export interface FgLineInput {
  sku: string;
  batchNo: string;
  qty: number;
  expiryDate?: string;
  locationId?: number;
}

export interface FgInput {
  woNo?: string;
  warehouseId?: number;
  warehouseCode?: string;
  sourceType?: 'WORK_ORDER' | 'MANUAL';
  remark?: string;
  lines: FgLineInput[];
}

@Injectable()
export class FgService {
  private logger = new Logger('FgService');

  constructor(
    @InjectRepository(WmsFgReceipt) private docs: Repository<WmsFgReceipt>,
    @InjectRepository(WmsFgReceiptLine) private lines: Repository<WmsFgReceiptLine>,
    @InjectRepository(WmsWorkOrder) private wos: Repository<WmsWorkOrder>,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(Warehouse) private warehouses: Repository<Warehouse>,
    @InjectRepository(WarehouseLocation) private locations: Repository<WarehouseLocation>,
    private gate: InventoryGateway,
    private audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- 建单

  async create(dto: FgInput) {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    if (!dto?.lines?.length) throw new BadRequestException('至少一行成品');
    if (dto.lines.length > 50) throw new BadRequestException('一张入库单最多 50 行');

    const wh = await this.resolveWarehouse(tenantId, dto);
    const sourceType = dto.sourceType === 'MANUAL' || !dto.woNo ? 'MANUAL' : 'WORK_ORDER';
    if (sourceType === 'MANUAL' && !String(dto.remark ?? '').trim()) {
      throw new BadRequestException('无工单的零星入库必须写原因（防止绕过工单口径）');
    }

    // 工单校验（无 MES 时，"能不能报完工"由这里把关）
    let wo: WmsWorkOrder | null = null;
    let already = 0;
    if (sourceType === 'WORK_ORDER') {
      wo = await this.wos.findOne({ where: { tenantId, woNo: String(dto.woNo).trim() } });
      if (!wo) throw new NotFoundException(`工单不存在：${dto.woNo}`);
      const ready = assertWoReadyForCompletion(wo.status);
      if (!ready.ok) throw new ConflictException(ready.reason);
      already = await this.sumPostedOrPending(tenantId, wo.woNo);
    }

    // 行校验 + 物料解析
    const resolved: Array<{ line: FgLineInput; material: Material; qty: number }> = [];
    for (let i = 0; i < dto.lines.length; i++) {
      const l = dto.lines[i];
      const sku = String(l.sku ?? '').trim();
      if (!sku) throw new BadRequestException(`第 ${i + 1} 行：请填成品物料编码`);
      if (!String(l.batchNo ?? '').trim()) throw new BadRequestException(`第 ${i + 1} 行：成品批号必填（追溯与 UDI-PI 都靠它）`);
      const q = assertQty(l.qty, `第 ${i + 1} 行数量`);
      if (!q.ok) throw new BadRequestException(q.reason);
      const mat = await this.materials.findOne({ where: { tenantId, code: sku } });
      if (!mat) throw new NotFoundException(`第 ${i + 1} 行：物料不存在 ${sku}`);
      if (wo && Number(wo.productMaterialId) !== Number(mat.id)) {
        throw new BadRequestException(`第 ${i + 1} 行：物料 ${sku} 与工单 ${wo.woNo} 的成品不一致`);
      }
      if (l.locationId) {
        const loc = await this.locations.findOne({ where: { tenantId, id: Number(l.locationId) } });
        if (!loc) throw new NotFoundException(`第 ${i + 1} 行：库位不存在`);
      }
      resolved.push({ line: l, material: mat, qty: q.value });
    }

    // 累计不超工单需求
    if (wo) {
      const adding = resolved.reduce((s, r) => s + r.qty, 0);
      const chk = assertNotOverDemand(Number(wo.demandQty), already, adding);
      if (!chk.ok) throw new BadRequestException(chk.reason);
    }

    const doc = await this.insertWithNo(tenantId, {
      sourceType, woNo: wo ? wo.woNo : null,
      warehouseId: Number(wh.id), status: 'CREATED',
      remark: String(dto.remark ?? '').trim() || null,
      createdBy: userId ?? null,
    });

    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      await this.lines.save(this.lines.create({
        tenantId, fgId: Number(doc.id), lineNo: i + 1,
        materialId: Number(r.material.id),
        batchNo: String(r.line.batchNo).trim(),
        qty: String(r.qty),
        expiryDate: r.line.expiryDate ? String(r.line.expiryDate).slice(0, 10) : null,
        locationId: r.line.locationId ? Number(r.line.locationId) : null,
        status: 'PENDING',
        qcStatus: resolveQcStatus(!!r.material.qcRequired),
      } as WmsFgReceiptLine));
    }

    void this.audit.write(tenantId, 'wms.fg.create', {
      fgNo: doc.fgNo, woNo: doc.woNo, sourceType, lines: resolved.length,
    }, userId ?? undefined, 'wms_fg_receipt', Number(doc.id));

    return this.detail(Number(doc.id));
  }

  // ---------------------------------------------------------------- 过账

  async post(id: number) {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('成品入库单不存在');
    const can = assertCanPost(doc.status);
    if (!can.ok) throw new ConflictException(can.reason);

    const rows = await this.lines.find({ where: { tenantId, fgId: Number(id) }, order: { lineNo: 'ASC' } });
    if (!rows.length) throw new BadRequestException('入库单没有明细行');
    if (rows.some((r) => r.status === 'POSTED')) throw new ConflictException('已有行过账，不能重复过账');

    const tag = `[${doc.fgNo}] 成品入库${doc.woNo ? '：' + doc.woNo : ''}`;
    const results: any[] = [];
    let failed = false;

    for (const r of rows) {
      if (failed) {
        results.push({ lineNo: r.lineNo, status: 'SKIPPED', message: '前一行失败，本次未执行' });
        continue;
      }
      try {
        const mat = await this.materials.findOne({ where: { tenantId, id: Number(r.materialId) } });
        if (!mat) throw new Error(`物料已不存在：${r.materialId}`);
        await this.gate.increaseStock({
          tenantId, skuId: Number(mat.id), warehouseId: Number(doc.warehouseId),
          locationId: r.locationId ? Number(r.locationId) : null,
          batchNo: r.batchNo ?? undefined,
          qty: Number(r.qty), unit: mat.unit,
          refType: 'wms_fg_receipt', refNo: doc.fgNo,
          idempotencyKey: `fg:${doc.fgNo}:${r.lineNo}`,
          qcStatus: (r.qcStatus as any) ?? resolveQcStatus(!!mat.qcRequired),
        });
        const after = await this.gate.queryAvailable({
          tenantId, skuId: Number(mat.id), warehouseId: Number(doc.warehouseId), batchNo: r.batchNo ?? undefined,
        });
        await this.lines.update({ id: r.id }, {
          status: 'POSTED', qtyAfter: String(round3(after.qty)), error: null,
        });
        results.push({
          lineNo: r.lineNo, status: 'DONE', sku: mat.code, batchNo: r.batchNo,
          qty: Number(r.qty), qtyAfter: round3(after.qty), qcStatus: r.qcStatus,
        });
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 200);
        await this.lines.update({ id: r.id }, { status: 'FAILED', error: msg });
        results.push({ lineNo: r.lineNo, status: 'FAILED', message: msg });
        failed = true;
      }
    }

    const after = await this.lines.find({ where: { tenantId, fgId: Number(id) } });
    const allDone = after.every((r) => r.status === 'POSTED');
    if (allDone) {
      await this.docs.update({ id: Number(id) }, { status: 'POSTED', postedBy: userId ?? null, postedAt: new Date() });
    }
    void this.audit.write(tenantId, 'wms.fg.post', {
      fgNo: doc.fgNo, allDone, failed: after.filter((r) => r.status === 'FAILED').length,
    }, userId ?? undefined, 'wms_fg_receipt', Number(id));

    if (!allDone && failed) {
      const first = results.find((r) => r.status === 'FAILED');
      throw new BadRequestException(`入库失败：${first?.message ?? '未知原因'}`);
    }
    return { ...(await this.detail(Number(id))), results };
  }

  async cancel(id: number, reason?: string) {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('成品入库单不存在');
    const can = assertCanCancel(doc.status);
    if (!can.ok) throw new ConflictException(can.reason);
    await this.docs.update({ id: Number(id) }, {
      status: 'CANCELLED', cancelledBy: userId ?? null, cancelledAt: new Date(),
      cancelReason: String(reason ?? '').slice(0, 200) || null,
    });
    await this.lines.update({ tenantId, fgId: Number(id) }, { status: 'CANCELLED' });
    void this.audit.write(tenantId, 'wms.fg.cancel', { fgNo: doc.fgNo, reason: reason ?? null }, userId ?? undefined, 'wms_fg_receipt', Number(id));
    return this.detail(Number(id));
  }

  // ---------------------------------------------------------------- 查询

  async list(q: { status?: string; keyword?: string; page?: number; pageSize?: number }) {
    const tenantId = useTenantId();
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
    const qb = this.docs.createQueryBuilder('d')
      .where('d.tenant_id = :tenantId', { tenantId });
    if (q.status) qb.andWhere('d.status = :st', { st: q.status });
    if (q.keyword) {
      qb.andWhere('(d.fg_no ILIKE :kw OR d.wo_no ILIKE :kw)', { kw: `%${q.keyword}%` });
    }
    const total = await qb.getCount();
    const rows = await qb.orderBy('d.id', 'DESC').skip((page - 1) * pageSize).take(pageSize).getMany();
    const items = [];
    for (const d of rows) {
      const lineRows = await this.lines.find({ where: { tenantId, fgId: Number(d.id) } });
      items.push({
        id: Number(d.id), fgNo: d.fgNo, sourceType: d.sourceType, woNo: d.woNo,
        status: d.status, statusText: FG_STATUS_TEXT[d.status] ?? d.status,
        warehouseId: Number(d.warehouseId),
        qtyTotal: round3(lineRows.reduce((s, r) => s + Number(r.qty), 0)),
        lineCount: lineRows.length,
        remark: d.remark, createdAt: d.createdAt, postedAt: d.postedAt,
      });
    }
    return { items, total, page, pageSize };
  }

  async detail(id: number) {
    const tenantId = useTenantId();
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('成品入库单不存在');
    const rows = await this.lines.find({ where: { tenantId, fgId: Number(id) }, order: { lineNo: 'ASC' } });
    const wh = await this.warehouses.findOne({ where: { tenantId, id: Number(doc.warehouseId) } });
    const view = [];
    for (const r of rows) {
      const mat = await this.materials.findOne({ where: { tenantId, id: Number(r.materialId) } });
      const loc = r.locationId ? await this.locations.findOne({ where: { tenantId, id: Number(r.locationId) } }) : null;
      view.push({
        id: Number(r.id), lineNo: r.lineNo,
        materialId: Number(r.materialId), sku: mat?.code ?? null, productName: mat?.name ?? null,
        unit: mat?.unit ?? null, batchNo: r.batchNo, qty: Number(r.qty),
        expiryDate: r.expiryDate, locationId: r.locationId ? Number(r.locationId) : null,
        locationText: loc ? `${loc.code} ${loc.name ?? ''}`.trim() : null,
        status: r.status, statusText: FG_LINE_STATUS_TEXT[r.status] ?? r.status,
        qcStatus: r.qcStatus, qtyAfter: r.qtyAfter == null ? null : Number(r.qtyAfter),
        error: r.error,
      });
    }
    return {
      id: Number(doc.id), fgNo: doc.fgNo, sourceType: doc.sourceType, woNo: doc.woNo,
      warehouseId: Number(doc.warehouseId), warehouseName: wh?.name ?? null,
      status: doc.status, statusText: FG_STATUS_TEXT[doc.status] ?? doc.status,
      remark: doc.remark, createdBy: doc.createdBy, postedAt: doc.postedAt,
      cancelReason: doc.cancelReason, createdAt: doc.createdAt,
      lines: view,
    };
  }

  /** 报工上下文：工单成品、需求、已入库、剩余可入 —— PDA 开单前先看这个 */
  async woContext(woNo: string) {
    const tenantId = useTenantId();
    const wo = await this.wos.findOne({ where: { tenantId, woNo: String(woNo).trim() } });
    if (!wo) throw new NotFoundException(`工单不存在：${woNo}`);
    const mat = await this.materials.findOne({ where: { tenantId, id: Number(wo.productMaterialId) } });
    const already = await this.sumPostedOrPending(tenantId, wo.woNo);
    const ready = assertWoReadyForCompletion(wo.status);
    return {
      woNo: wo.woNo, status: wo.status,
      productSku: mat?.code ?? null, productName: mat?.name ?? null, unit: mat?.unit ?? null,
      demandQty: Number(wo.demandQty), alreadyQty: round3(already),
      remainingQty: round3(Math.max(0, Number(wo.demandQty) - already)),
      canReport: ready.ok, blockReason: ready.reason ?? null,
      warehouseId: Number(wo.warehouseId) || null,
    };
  }

  // ---------------------------------------------------------------- 内部

  private async sumPostedOrPending(tenantId: number, woNo: string): Promise<number> {
    const docs = await this.docs.find({ where: { tenantId, woNo } });
    let sum = 0;
    for (const d of docs) {
      if (d.status === 'CANCELLED') continue;
      const rows = await this.lines.find({ where: { tenantId, fgId: Number(d.id) } });
      sum += rows.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + Number(r.qty), 0);
    }
    return round3(sum);
  }

  private async resolveWarehouse(tenantId: number, dto: FgInput): Promise<Warehouse> {
    if (dto.warehouseId) {
      const w = await this.warehouses.findOne({ where: { tenantId, id: Number(dto.warehouseId) } });
      if (!w) throw new BadRequestException('仓库不存在');
      return w;
    }
    if (dto.warehouseCode) {
      const w = await this.warehouses.findOne({ where: { tenantId, code: String(dto.warehouseCode) } });
      if (!w) throw new BadRequestException('仓库不存在');
      return w;
    }
    // 默认：工单仓库；无工单则取成品区所在仓（第一条成品库位所属仓）
    if (dto.woNo) {
      const wo = await this.wos.findOne({ where: { tenantId, woNo: String(dto.woNo).trim() } });
      if (wo) {
        const w = await this.warehouses.findOne({ where: { tenantId, id: Number(wo.warehouseId) } });
        if (w) return w;
      }
    }
    const first = await this.warehouses.findOne({ where: { tenantId }, order: { id: 'ASC' } });
    if (!first) throw new BadRequestException('租户还没有仓库，请先在控制台建仓');
    return first;
  }

  private async insertWithNo(tenantId: number, patch: Partial<WmsFgReceipt>): Promise<WmsFgReceipt> {
    const d = new Date();
    const ymd = formatFgNo(d, 0).slice(3, 11);
    for (let attempt = 0; attempt < 6; attempt++) {
      const seqRow = await this.docs.createQueryBuilder('d')
        .where('d.tenant_id = :tenantId', { tenantId })
        .andWhere('d.fg_no LIKE :p', { p: `FG-${ymd}-%` })
        .select('COUNT(*)', 'n')
        .getRawOne();
      const n = Number(seqRow?.n ?? 0) + 1 + attempt;
      try {
        return await this.docs.save(this.docs.create({ ...patch, fgNo: formatFgNo(d, n) } as WmsFgReceipt));
      } catch (e: any) {
        if (String(e?.code) === '23505' || /duplicate key/i.test(String(e?.message))) continue;
        throw e;
      }
    }
    throw new BadRequestException('入库单号生成冲突，请重试');
  }
}
