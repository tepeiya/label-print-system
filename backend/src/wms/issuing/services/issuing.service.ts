// =============================================================================
// IssuingService —— WMS 阶段二：工单发料与齐套（docs/16 实现口径）
//
// 边界（沿用阶段一）：只通过 InventoryGateway 取数/改库存、PrintGateway 打标签；
//   禁止 import src/inventory/** 与 src/print/** 内部实现。
// 事务语义：库存经 Gateway 独立事务，WMS 侧不做单一物理事务；
//   失败后"无脏数据 + 重跑幂等收敛"，靠 (tenant_id, idem_key) 唯一键兜底（docs/16 §7）。
// =============================================================================
import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WmsWorkOrder, WmsWoLine, WmsIssueRecord, WmsWoReturn } from '../entities/wo.entity';
import { InventoryGateway, BatchRowPlain } from '../../gateways/inventory.gateway';
import { PrintGateway } from '../../gateways/print.gateway';
import { AuditService } from '../../../audit/audit.module';
import { useTenant, useTenantId } from '../../../common/tenant.context';
import { UdiTraceService } from '../../../udi/udi.trace.service';
import { udiKeyFromCode } from '../../../udi/udi.link.calc';
import { judgeScanGtin } from '../../../udi/udi.match.calc';
import { round3 } from '../../../inventory/kit.calc';
import { canTransit } from './wo-transit';
import { summarizeWoKit, lineShortageText } from './kit-summary.calc';
import { allocateBatches } from './batch-alloc.calc';
import {
  lineRequiredQty, issueIdemKey, returnIdemKey, reprintIdemKey,
  checkOverIssue, lineStatus, verifyIssueScan,
} from './issue-calc';

export interface CreateWoDto {
  woNo?: string;
  productMaterialId?: number;
  productCode?: string;
  warehouseId: number;
  demandQty: number;
  expandBom?: boolean;
  sourceType?: string;
  sourceNo?: string;
  priority?: number;
  plannedStartAt?: string;
  plannedEndAt?: string;
  remark?: string;
  lines?: Array<{ materialId?: number; materialCode?: string; qtyRequired: number; batchNo?: string }>;
}

export interface LineInput { materialId?: number; materialCode?: string; qtyRequired?: number; qtyPer?: number; lossRate?: number; batchNo?: string }

const PRINT_TEMPLATE = 'ISSUE_LABEL_V1';
const PRINT_SOURCE = 'wms.issuing.issue';
const PRINT_ROUTE = 'issue-station';

@Injectable()
export class IssuingService {
  private logger = new Logger('IssuingService');

  constructor(
    @InjectRepository(WmsWorkOrder) private wos: Repository<WmsWorkOrder>,
    @InjectRepository(WmsWoLine) private lines: Repository<WmsWoLine>,
    @InjectRepository(WmsIssueRecord) private issues: Repository<WmsIssueRecord>,
    @InjectRepository(WmsWoReturn) private returns: Repository<WmsWoReturn>,
    private inventory: InventoryGateway,
    private printGw: PrintGateway,
    private audit: AuditService,
    @Optional() private udi?: UdiTraceService,
  ) {}

  // ---------------------------------------------------------------- 建单
  async create(dto: CreateWoDto) {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const demand = Number(dto.demandQty);
    if (!Number.isFinite(demand) || demand <= 0) throw new BadRequestException('demandQty 必须为正数');
    const woNo = String(dto.woNo ?? '').trim() || `WO${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${Math.floor(Math.random() * 9000 + 1000)}`;

    const exists = await this.wos.findOne({ where: { tenantId, woNo } });
    if (exists) throw new ConflictException(`工单号已存在：${woNo}`);

    const product = dto.productMaterialId
      ? await this.inventory.resolveMaterial({ tenantId, ref: dto.productMaterialId })
      : await this.inventory.resolveMaterial({ tenantId, ref: String(dto.productCode ?? '') });
    if (!product?.id) throw new BadRequestException('产出物料不存在');
    const warehouse = await this.inventory.resolveWarehouse({ tenantId, ref: dto.warehouseId });

    const wo = await this.wos.save(this.wos.create({
      tenantId, woNo,
      productMaterialId: product.id,
      warehouseId: warehouse.id,
      demandQty: String(demand),
      sourceType: dto.sourceType ?? 'MANUAL',
      sourceNo: dto.sourceNo ?? null,
      priority: Number(dto.priority ?? 100),
      plannedStartAt: dto.plannedStartAt ? new Date(dto.plannedStartAt) : null,
      plannedEndAt: dto.plannedEndAt ? new Date(dto.plannedEndAt) : null,
      status: 'CREATED',
      shortageFlag: false,
      remark: dto.remark ?? null,
      createdBy: userId ?? null,
    }));

    // 行来源：手工行优先；否则 expandBom 时按 active BOM 展开
    const manual = dto.lines ?? [];
    if (manual.length) {
      await this.replaceLines(wo, manual.map((l) => ({
        materialId: l.materialId, materialCode: l.materialCode,
        qtyRequired: Number(l.qtyRequired), batchNo: l.batchNo,
      })), demand);
    } else if (dto.expandBom !== false) {
      const bom = await this.inventory.expandBom({ tenantId, productMaterialId: product.id });
      if (!bom) throw new NotFoundException(`产品「${product.name}」没有启用中的 BOM，无法自动展开`);
      await this.replaceLines(wo, bom.lines.map((b) => ({
        materialId: b.materialId, qtyPer: b.qtyPer, lossRate: b.lossRate,
      })), demand);
    }

    void this.audit.write(tenantId, 'wms.wo.create', { woNo, demand, expandBom: dto.expandBom !== false }, undefined, 'wms_work_order', wo.id);
    return this.detail(wo.id);
  }

  /** Excel 建单：逐行独立成败（部分成功），失败行返回行级错误 */
  async importOrders(rows: Array<CreateWoDto & { rowNo?: number }>) {
    const out = { total: rows.length, created: 0, failed: 0, errors: [] as Array<{ rowNo: number; message: string }>, items: [] as any[] };
    if (rows.length > 200) throw new BadRequestException('单次导入上限 200 行工单');
    for (let i = 0; i < rows.length; i++) {
      try {
        const wo = await this.create(rows[i]);
        out.created += 1;
        out.items.push({ id: wo.id, woNo: wo.woNo });
      } catch (e: any) {
        out.failed += 1;
        out.errors.push({ rowNo: rows[i].rowNo ?? i + 1, message: e?.message ?? String(e) });
      }
    }
    return out;
  }

  /** 建单/改行共用：按行输入重建行（仅 CREATED 阶段允许） */
  private async replaceLines(wo: WmsWorkOrder, inputs: LineInput[], demand: number, append = false) {
    const tenantId = useTenantId();
    const maxLine = append
      ? (await this.lines.find({ where: { tenantId, woId: wo.id } })).reduce((m, l) => Math.max(m, l.lineNo), 0)
      : 0;
    if (!append) await this.lines.delete({ tenantId, woId: wo.id });

    let lineNo = maxLine;
    const seen = new Set<number>();
    for (const raw of inputs) {
      const material = raw.materialId
        ? await this.inventory.resolveMaterial({ tenantId, ref: raw.materialId })
        : await this.inventory.resolveMaterial({ tenantId, ref: String(raw.materialCode ?? '') });
      if (!material?.id) throw new BadRequestException(`物料不存在：${raw.materialId ?? raw.materialCode}`);
      if (seen.has(material.id) && !append) {
        // 同一物料重复行：合并需求量，避免两条同料行造成超发判断混乱
        const exist = await this.lines.findOne({ where: { tenantId, woId: wo.id, materialId: material.id } });
        if (exist) {
          let add = 0;
          if (raw.qtyRequired != null) add = round3(Number(raw.qtyRequired));
          else add = lineRequiredQty(Number(raw.qtyPer ?? 0), Number(raw.lossRate ?? 0), demand);
          if (!Number.isFinite(add) || add <= 0) throw new BadRequestException(`行用量必须为正数：${material.code}`);
          exist.qtyRequired = String(round3(Number(exist.qtyRequired) + add));
          await this.lines.save(exist);
          continue;
        }
      }
      seen.add(material.id);

      let required: number;
      if (raw.qtyRequired != null) required = round3(Number(raw.qtyRequired));
      else required = lineRequiredQty(Number(raw.qtyPer ?? 0), Number(raw.lossRate ?? 0), demand);
      if (!Number.isFinite(required) || required <= 0) throw new BadRequestException(`行需求量必须为正数：${material.code}`);

      lineNo += 1;
      await this.lines.save(this.lines.create({
        tenantId, woId: wo.id, lineNo, materialId: material.id,
        qtyRequired: String(required), qtyIssued: '0', qtyShortage: '0',
        batchNo: raw.batchNo ?? null, status: 'PENDING',
      }));
    }
    return lineNo;
  }

  // ---------------------------------------------------------------- 查询
  async list(q: { status?: string; keyword?: string; page?: number; pageSize?: number }) {
    const tenantId = useTenantId();
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
    const qb = this.wos.createQueryBuilder('wo')
      .where('wo.tenant_id = :tenantId', { tenantId })
      .orderBy('wo.id', 'DESC');
    if (q.status) qb.andWhere('wo.status = :status', { status: q.status });
    if (q.keyword) qb.andWhere('(wo.wo_no ILIKE :kw OR wo.source_no ILIKE :kw)', { kw: `%${q.keyword}%` });
    const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    return {
      total, page, pageSize,
      items: rows.map((w) => ({
        id: w.id, woNo: w.woNo, productMaterialId: Number(w.productMaterialId),
        warehouseId: Number(w.warehouseId), demandQty: Number(w.demandQty),
        status: w.status, shortageFlag: w.shortageFlag, priority: w.priority,
        sourceType: w.sourceType, sourceNo: w.sourceNo, createdAt: w.createdAt,
      })),
    };
  }

  async detail(id: number) {
    const tenantId = useTenantId();
    const wo = await this.wos.findOne({ where: { tenantId, id } });
    if (!wo) throw new NotFoundException(`工单不存在：${id}`);
    const lines = await this.lines.find({ where: { tenantId, woId: id }, order: { lineNo: 'ASC' } });
    const issues = await this.issues.find({ where: { tenantId, woId: id }, order: { id: 'ASC' } });
    const returns = await this.returns.find({ where: { tenantId, woId: id }, order: { id: 'ASC' } });
    const mats = new Map<number, { code: string; name: string; unit: string }>();
    for (const l of lines) {
      if (!mats.has(Number(l.materialId))) {
        const m = await this.inventory.resolveMaterial({ tenantId, ref: Number(l.materialId) });
        mats.set(Number(l.materialId), { code: m.code, name: m.name, unit: m.unit });
      }
    }
    const product = await this.inventory.resolveMaterial({ tenantId, ref: Number(wo.productMaterialId) });
    const lineViews = lines.map((l) => {
      const m = mats.get(Number(l.materialId));
      return {
        id: l.id, lineNo: l.lineNo, materialId: Number(l.materialId),
        materialCode: m?.code ?? '', materialName: m?.name ?? '', unit: m?.unit ?? '',
        qtyRequired: Number(l.qtyRequired), qtyIssued: Number(l.qtyIssued),
        qtyShortage: Number(l.qtyShortage), batchNo: l.batchNo, status: l.status,
        shortageReason: l.shortageReason,
      };
    });
    return {
      id: wo.id, woNo: wo.woNo, product,
      warehouseId: Number(wo.warehouseId), demandQty: Number(wo.demandQty),
      status: wo.status, shortageFlag: wo.shortageFlag, priority: wo.priority,
      sourceType: wo.sourceType, sourceNo: wo.sourceNo, remark: wo.remark,
      plannedStartAt: wo.plannedStartAt, plannedEndAt: wo.plannedEndAt,
      createdAt: wo.createdAt, updatedAt: wo.updatedAt,
      lines: lineViews,
      issues: issues.map((r) => ({
        id: r.id, lineId: Number(r.lineId), materialId: Number(r.materialId),
        batchNo: r.batchNo, locationId: r.locationId != null ? Number(r.locationId) : null,
        qty: Number(r.qty), printJobId: r.printJobId, printStatus: r.printStatus, createdAt: r.createdAt,
      })),
      returns: returns.map((r) => ({
        id: r.id, lineId: Number(r.lineId), batchNo: r.batchNo, qty: Number(r.qty),
        approvedBy: r.approvedBy != null ? Number(r.approvedBy) : null, reason: r.reason, createdAt: r.createdAt,
      })),
    };
  }

  async appendLines(id: number, inputs: LineInput[]) {
    const wo = await this.requireWo(id);
    if (wo.status !== 'CREATED') throw new ConflictException('仅 CREATED 状态可改行');
    if (!inputs?.length) throw new BadRequestException('lines 不能为空');
    await this.replaceLines(wo, inputs, Number(wo.demandQty), true);
    void this.audit.write(useTenantId(), 'wms.wo.edit', { woNo: wo.woNo, added: inputs.length }, undefined, 'wms_work_order', wo.id);
    return this.detail(id);
  }

  // ---------------------------------------------------------------- 齐套
  async kitCheck(id: number) {
    const tenantId = useTenantId();
    const wo = await this.requireWo(id);
    const lines = await this.lines.find({ where: { tenantId, woId: id }, order: { lineNo: 'ASC' } });
    if (!lines.length) {
      // 无行：返回友好提示，不报错（docs/16 §5）
      const kit = { demand: Number(wo.demandQty), overallMaxSets: 0, overallKitRate: 0, shortageLines: [], summaryText: '工单没有明细行，请先展开 BOM 或手工加行', lines: [] };
      return { woNo: wo.woNo, ...kit, checkedAt: new Date().toISOString() };
    }

    const product = await this.inventory.resolveMaterial({ tenantId, ref: Number(wo.productMaterialId) });
    const r = await this.inventory.checkKit({
      tenantId, product: product.id, demand: Math.floor(Number(wo.demandQty)),
      warehouseId: Number(wo.warehouseId),
    });

    // 把 computeKit 行结果映射回工单行（同物料匹配；BOM 有而行没有的给提示）
    const byMaterial = new Map(r.kit.lines.map((l) => [Number(l.materialId), l]));
    const summary = summarizeWoKit(r.kit, Number(wo.demandQty), r.product.name);
    const views = lines.map((l) => {
      const k = byMaterial.get(Number(l.materialId));
      const required = Number(l.qtyRequired);
      const available = k ? Number(k.available) : 0;
      const shortage = k ? round3(Math.max(0, required - available)) : required;
      return {
        id: l.id, lineNo: l.lineNo, materialId: Number(l.materialId),
        materialCode: k?.code ?? '', materialName: k?.name ?? '', unit: k?.unit ?? '',
        qtyRequired: required, available, maxSets: k?.maxSets ?? 0,
        shortage, reason: shortage > 0 ? `可用 ${available} < 需求 ${required}` : null,
      };
    });

    // 回写行缺料与工单缺料标记（D7：不加状态，只标记）
    for (const v of views) {
      const row = lines.find((l) => l.id === v.id)!;
      row.qtyShortage = String(v.shortage);
      row.shortageReason = v.reason ? String(v.reason).slice(0, 300) : null;
      if (row.status === 'PENDING' || row.status === 'SHORT') {
        row.status = lineStatus(Number(row.qtyIssued), Number(row.qtyRequired), v.shortage, true);
      }
      await this.lines.save(row);
    }
    const shortageFlag = views.some((v) => v.shortage > 0);
    wo.shortageFlag = shortageFlag;
    await this.wos.save(wo);

    void this.audit.write(tenantId, 'wms.wo.kit_check', {
      woNo: wo.woNo, demand: Number(wo.demandQty),
      overallMaxSets: summary.overallMaxSets, kitRate: summary.overallKitRate, shortageFlag,
    }, undefined, 'wms_work_order', wo.id);

    return {
      woNo: wo.woNo, product: r.product, bom: r.bom,
      demand: summary.demand, overallMaxSets: summary.overallMaxSets,
      overallKitRate: summary.overallKitRate, shortageLines: summary.shortageLines,
      summaryText: summary.summaryText, lines: views,
      checkedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------- 流转
  async release(id: number) {
    const tenantId = useTenantId();
    const wo = await this.requireWo(id);
    const lineCount = await this.lines.count({ where: { tenantId, woId: id } });
    const kit = canTransit(wo.status, 'RELEASE', {
      lineCount,
      // 齐套检查留下了 qty_shortage/shortage_reason 或审计记录；用"是否做过检查"的持久信号：
      // 行上有 shortage_reason，或工单 shortage_flag 已写过，都算做过检查。空行工单前面已被 lineCount 挡住。
      kitChecked: await this.kitCheckedBefore(tenantId, id),
    });
    if (!kit.ok) throw new ConflictException(kit.reason!);
    wo.status = kit.to!;
    await this.wos.save(wo);
    void this.audit.write(tenantId, 'wms.wo.release', { woNo: wo.woNo, kitChecked: true }, undefined, 'wms_work_order', id);
    return this.detail(id);
  }

  /** 只靠审计判断"是否做过齐套检查"（不改表结构，符合 docs/16 §3 表设计） */
  private async kitCheckedBefore(tenantId: number, woId: number): Promise<boolean> {
    const rows = await this.audit.find({ action: 'wms.wo.kit_check', page: 1, pageSize: 1000 });
    const list = Array.isArray(rows) ? rows : (rows as any).items ?? [];
    return list.some((r: any) => Number(r.targetId) === Number(woId) && r.targetType === 'wms_work_order');
  }

  async cancel(id: number, reason?: string) {
    const tenantId = useTenantId();
    const wo = await this.requireWo(id);
    const tr = canTransit(wo.status, 'CANCEL');
    if (!tr.ok) throw new ConflictException(tr.reason!);
    wo.status = tr.to!;
    await this.wos.save(wo);
    void this.audit.write(tenantId, 'wms.wo.cancel', { woNo: wo.woNo, reason: reason ?? null }, undefined, 'wms_work_order', id);
    return this.detail(id);
  }

  async issueStart(id: number) {
    const tenantId = useTenantId();
    const wo = await this.requireWo(id);
    const tr = canTransit(wo.status, 'ISSUE_START');
    if (!tr.ok) throw new ConflictException(tr.reason!);
    wo.status = tr.to!;
    await this.wos.save(wo);
    void this.audit.write(tenantId, 'wms.wo.issue_start', { woNo: wo.woNo }, undefined, 'wms_work_order', id);
    return this.detail(id);
  }

  // ---------------------------------------------------------------- 扫码校验
  async issueScan(id: number, dto: {
    lineId?: number; lineNo?: number; materialCode?: string; batchNo?: string;
    locationId?: number | null; locationCode?: string; scanned?: { materialCode?: string; batchNo?: string; locationId?: number | null; locationCode?: string };
    /** UDI 码：扫到单品码时联动校验/记 ISSUE（U5） */
    udiCode?: string; strictUdi?: boolean; forceUdiGtin?: boolean;
  }) {
    const tenantId = useTenantId();
    const wo = await this.requireWo(id);
    if (!['ISSUING', 'RELEASED'].includes(wo.status)) {
      throw new ConflictException(`工单状态 ${wo.status} 不能扫码校验（需 RELEASED/ISSUING）`);
    }
    const line = await this.findLine(id, dto);
    if (!line) throw new NotFoundException('未找到工单行：请给 lineId 或 lineNo');

    const material = await this.inventory.resolveMaterial({ tenantId, ref: Number(line.materialId) });
    const batches = await this.inventory.queryBatches({ tenantId, skuId: Number(line.materialId), warehouseId: Number(wo.warehouseId) });
    // 期望批次：行指定批次优先，否则按自动分配算出"应发批次"（用于比对 PDA 扫到的批次）
    let expectBatch: string | null = line.batchNo;
    if (!expectBatch) {
      const alloc = allocateBatches(batches as BatchRowPlain[], Math.max(0, Number(line.qtyRequired) - Number(line.qtyIssued)));
      expectBatch = alloc.allocations[0]?.batchNo ?? null;
    }
    const expectLocation = (() => {
      const hit = batches.find((b) => b.batchNo === expectBatch);
      return { id: hit?.locationId ?? null, code: undefined as string | undefined };
    })();

    const scanned = dto.scanned ?? {
      materialCode: dto.materialCode, batchNo: dto.batchNo,
      locationId: dto.locationId ?? null, locationCode: dto.locationCode,
    };
    const verdict = verifyIssueScan(
      { materialCode: material.code, batchNo: expectBatch, locationId: expectLocation.id, locationCode: expectLocation.code },
      scanned,
    );

    const body: Record<string, any> = {
      woNo: wo.woNo, lineId: line.id, lineNo: line.lineNo,
      expected: { materialCode: material.code, materialName: material.name, batchNo: expectBatch, locationId: expectLocation.id },
      verdict,
      availableBatches: batches,
      // D1：不符可强制放行，但必须带 force=true 过账并留审计
      canForce: !verdict.ok,
    };
    // U5.1：GTIN 比对与必扫校验（不符 → 判定 ok=false，可 force 过账留审计）
    const parsedUdi = dto.udiCode ? udiKeyFromCode(dto.udiCode) : null;
    if (parsedUdi && !parsedUdi.ok) throw new BadRequestException(`UDI 码解析失败：${parsedUdi.errors.join('；')}`);
    const udiJudge = judgeScanGtin({
      materialGtin: material.gtin, udiRequired: material.udiRequired,
      codeGtin: parsedUdi?.gtin ?? null, hasCode: !!dto.udiCode, force: !!dto.forceUdiGtin,
    });
    if (dto.forceUdiGtin) {
      void this.audit.write(tenantId, 'wms.wo.issue.udi.gtin_force', {
        woNo: wo.woNo, lineNo: line.lineNo, materialGtin: material.gtin, codeUdi: dto.udiCode ?? null,
      }, undefined, 'wms_work_order', wo.id);
    }
    if (!udiJudge.ok) {
      body.verdict.ok = false;
      body.verdict.message = udiJudge.reason ?? body.verdict.message;
      body.verdict.mismatches = [...body.verdict.mismatches, {
        field: 'gtin', expected: String(material.gtin ?? '(未登记)'), actual: String(parsedUdi?.gtin ?? '(未扫码)'),
      }];
      body.canForce = true;
      void this.audit.write(tenantId, 'wms.wo.issue.udi.mismatch', {
        woNo: wo.woNo, lineNo: line.lineNo, reason: udiJudge.reason,
      }, undefined, 'wms_work_order', wo.id);
    }
    if (dto.udiCode && udiJudge.ok) Object.assign(body, await this.udiOnIssueScan(wo, line, dto));
    return body;
  }

  /** UDI 联动（U5）：发料扫码校验阶段记 ISSUE（已收货单元）；默认不阻塞，strictUdi 时抛错 */
  private async udiOnIssueScan(wo: WmsWorkOrder, line: WmsWoLine, dto: { udiCode?: string; strictUdi?: boolean }): Promise<Record<string, any>> {
    const tenantId = useTenantId();
    if (!this.udi) return { udiWarning: '服务端未启用 UDI 模块，已跳过发料联动' };
    try {
      const m = await this.inventory.resolveMaterial({ tenantId, ref: Number(line.materialId) });
      const udi = await this.udi.issueByScan({
        code: String(dto.udiCode), woNo: wo.woNo, lineNo: line.lineNo,
        materialCode: m.code, qty: Number(line.qtyRequired),
      });
      void this.audit.write(tenantId, 'wms.wo.issue.udi', {
        woNo: wo.woNo, lineNo: line.lineNo, udiKey: udi.udiKey, gtin: udi.gtin, idempotent: udi.idempotent,
      }, undefined, 'wms_work_order', wo.id);
      return { udi };
    } catch (e: any) {
      const message = String(e?.response?.message ?? e?.message ?? e).slice(0, 200);
      void this.audit.write(tenantId, 'wms.wo.issue.udi.failed', {
        woNo: wo.woNo, lineNo: line.lineNo, error: message,
      }, undefined, 'wms_work_order', wo.id);
      if (dto.strictUdi) throw e;
      return { udiWarning: message };
    }
  }

  // ---------------------------------------------------------------- 发料过账
  async issuePost(id: number, dto: {
    lineIds?: number[]; force?: boolean;
    /** UDI 单品码（U5）：过账后记 ISSUE 事件；失败只回报不抛错（库存已动，不可回滚半截） */
    udiCodes?: Array<{ code: string; lineNo?: number; lineId?: number }>;
  } = {}) {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const wo = await this.requireWo(id);
    const tr = canTransit(wo.status, 'ISSUE_POST');
    if (!tr.ok) throw new ConflictException(tr.reason!);

    const all = await this.lines.find({ where: { tenantId, woId: id }, order: { lineNo: 'ASC' } });
    const targets = dto.lineIds?.length ? all.filter((l) => dto.lineIds!.includes(l.id)) : all;
    if (!targets.length) throw new BadRequestException('没有可过账的行');

    const posted: any[] = [];
    const skipped: any[] = [];
    let labelFailed = 0;

    for (const line of targets) {
      const required = Number(line.qtyRequired);
      const issued = Number(line.qtyIssued);
      if (round3(required - issued) <= 0.0005) {
        skipped.push({ lineId: line.id, lineNo: line.lineNo, reason: '已发满' });
        continue;
      }

      // 幂等：已有发料记录则视为已发，不二次扣减（崩溃恢复路径，docs/16 §7）
      const prior = await this.issues.find({ where: { tenantId, woId: id, lineId: line.id } });
      if (prior.length) {
        const priorTotal = round3(prior.reduce((s, r) => s + Number(r.qty), 0));
        if (priorTotal > issued) {
          line.qtyIssued = String(priorTotal);
          line.qtyShortage = String(round3(Math.max(0, required - priorTotal)));
          line.status = lineStatus(priorTotal, required, Number(line.qtyShortage));
          await this.lines.save(line);
        }
        skipped.push({ lineId: line.id, lineNo: line.lineNo, reason: '已存在发料记录（幂等回放）', priorQty: priorTotal });
        continue;
      }

      // U5.1：udi_required 物料必须扫到 UDI 码（除非 force 放行）
      if (this.udi && !dto.force) {
        const mm = await this.inventory.resolveMaterial({ tenantId, ref: Number(line.materialId) });
        if (mm.udiRequired) {
          const covered = (dto.udiCodes ?? []).some((c) =>
            (c.lineId != null && Number(c.lineId) === Number(line.id))
            || (c.lineNo != null && Number(c.lineNo) === Number(line.lineNo)));
          if (!covered) {
            skipped.push({ lineId: line.id, lineNo: line.lineNo, reason: `该物料要求扫 UDI 码（udi_required），本行未提供码`, materialCode: mm.code });
            continue;
          }
        }
      }

      const remaining = round3(required - issued);
      const batches = await this.inventory.queryBatches({ tenantId, skuId: Number(line.materialId), warehouseId: Number(wo.warehouseId) });
      const alloc = allocateBatches(batches as BatchRowPlain[], remaining, { batchNo: line.batchNo });
      if (!alloc.allocations.length) {
        // 完全无可用批次：行置 SHORT，不落发料记录（无脏数据，docs/16 §7.1）
        // 注意：部分可用时仍按可用量发料（D1 行级/部分发料），剩余记缺料
        const material = await this.inventory.resolveMaterial({ tenantId, ref: Number(line.materialId) });
        line.qtyShortage = String(alloc.shortage || remaining);
        line.shortageReason = String(alloc.reason ?? `可用不足，缺 ${remaining}`).slice(0, 300);
        line.status = 'SHORT';
        await this.lines.save(line);
        wo.shortageFlag = true;
        skipped.push({ lineId: line.id, lineNo: line.lineNo, reason: line.shortageReason, materialCode: material.code });
        continue;
      }

      const material = await this.inventory.resolveMaterial({ tenantId, ref: Number(line.materialId) });
      let lineQty = 0;
      const multi = alloc.allocations.length > 1;
      for (let i = 0; i < alloc.allocations.length; i++) {
        const a = alloc.allocations[i];
        const key = multi ? `${issueIdemKey(wo.woNo, line.lineNo)}:${a.batchNo}:${i + 1}` : issueIdemKey(wo.woNo, line.lineNo);
        const idemKey = key.slice(0, 128);
        const dup = await this.issues.findOne({ where: { tenantId, idemKey } });
        if (dup) { lineQty += Number(dup.qty); continue; }

        await this.inventory.decreaseStock({
          tenantId, skuId: Number(line.materialId), warehouseId: Number(wo.warehouseId),
          locationId: a.locationId, batchNo: a.batchNo, qty: a.qty,
          refType: 'WMS_ISSUE', refNo: `${wo.woNo}#${line.lineNo}`,
          idempotencyKey: idemKey,
        });

        const rec = await this.issues.save(this.issues.create({
          tenantId, woId: id, lineId: line.id, materialId: Number(line.materialId),
          batchNo: a.batchNo, locationId: a.locationId ?? null, qty: String(a.qty),
          idemKey, refType: 'WMS_ISSUE', operatorId: userId ?? null,
        }));
        lineQty = round3(lineQty + Number(a.qty));
        posted.push({
          recordId: rec.id, lineId: line.id, lineNo: line.lineNo, materialCode: material.code,
          batchNo: a.batchNo, qty: Number(a.qty),
          expiredBatch: alloc.expiredPicked.includes(a.batchNo),
        });
      }

      if (lineQty > 0) {
        const check = checkOverIssue(issued, required, lineQty);
        line.qtyIssued = String(check.ok ? check.nextIssued : required);
        const newIssued = Number(line.qtyIssued);
        const stillShort = round3(Math.max(0, required - newIssued));
        line.qtyShortage = String(stillShort);
        line.status = lineStatus(newIssued, required, stillShort);
        await this.lines.save(line);
        if (stillShort > 0.0005) {
          // 部分发料：已发量落账，剩余留缺料标记（D7 不加状态，只标记）
          line.shortageReason = String(`部分发料，仍缺 ${stillShort}（可用 ${round3(lineQty)}）`).slice(0, 300);
          await this.lines.save(line);
          wo.shortageFlag = true;
          skipped.push({
            lineId: line.id, lineNo: line.lineNo, reason: line.shortageReason,
            materialCode: material.code, partialIssued: round3(lineQty),
          });
        }
      }
    }

    // 发料标签（旁路）：按行汇总本次发料量打一张；失败只记审计，不阻塞
    for (const p of posted) {
      try {
        const line = all.find((l) => l.id === p.lineId);
        if (!line) continue;
        const job = await this.printGw.createJob({
          templateCode: PRINT_TEMPLATE,
          printerRoute: PRINT_ROUTE,
          idempotencyKey: `ISSUE:${wo.woNo}:${line.lineNo}:label`,
          source: PRINT_SOURCE,
          variables: {
            woNo: wo.woNo, lineNo: line.lineNo, materialCode: p.materialCode,
            materialName: p.materialCode, batchNo: p.batchNo ?? '', qty: p.qty,
            warehouseId: Number(wo.warehouseId),
          },
        });
        await this.issues.createQueryBuilder().update()
          .set({ printJobId: String(job.jobId ?? ''), printStatus: String(job.status ?? 'UNKNOWN') })
          .where('tenant_id = :tenantId AND id = :id', { tenantId, id: p.recordId })
          .execute();
      } catch (e: any) {
        labelFailed += 1;
        this.logger.warn(`发料标签打印失败 ${wo.woNo}#${p.lineNo}: ${e?.message ?? e}`);
        void this.audit.write(tenantId, 'wms.wo.print.failed', { woNo: wo.woNo, lineNo: p.lineNo, error: String(e?.message ?? e).slice(0, 200) }, undefined, 'wms_work_order', id);
      }
    }

    // 整单状态：不自动置 ISSUED（issue-done 显式收口，docs/16 §4）
    if (dto.force) {
      void this.audit.write(tenantId, 'wms.wo.issue.force', { woNo: wo.woNo, lineIds: targets.map((t) => t.id), posted: posted.length }, undefined, 'wms_work_order', id);
    }
    await this.wos.save(wo);
    void this.audit.write(tenantId, 'wms.wo.issue.post', {
      woNo: wo.woNo, posted: posted.length, skipped: skipped.length, qty: round3(posted.reduce((s, p) => s + p.qty, 0)),
    }, undefined, 'wms_work_order', id);

    const udiLink = dto.udiCodes?.length ? await this.udiOnPost(wo, all, dto.udiCodes) : null;
    return {
      woNo: wo.woNo, posted, skipped, labelFailed, shortageFlag: wo.shortageFlag,
      idempotent: posted.length === 0 && skipped.some((s) => /幂等/.test(s.reason ?? '')),
      ...(udiLink ?? {}),
    };
  }

  /** UDI 联动（U5）：过账后批量记 ISSUE；逐条容错，返回汇总（库存已变更，不因个别码失败而回滚） */
  private async udiOnPost(wo: WmsWorkOrder, lines: WmsWoLine[], codes: Array<{ code: string; lineNo?: number; lineId?: number }>): Promise<Record<string, any>> {
    const tenantId = useTenantId();
    if (!this.udi) return { udiWarning: '服务端未启用 UDI 模块，已跳过发料联动' };
    const results: Array<{ ok: boolean; idempotent?: boolean; code: string; reason?: string; udiKey?: string }> = [];
    for (const item of codes) {
      const line = item.lineId
        ? lines.find((l) => Number(l.id) === Number(item.lineId))
        : lines.find((l) => Number(l.lineNo) === Number(item.lineNo));
      if (!line) { results.push({ ok: false, code: item.code, reason: '找不到对应工单行（lineId/lineNo 无效）' }); continue; }
      try {
        const m = await this.inventory.resolveMaterial({ tenantId, ref: Number(line.materialId) });
        const parsed = udiKeyFromCode(item.code);
        if (!parsed.ok) { results.push({ ok: false, code: item.code, reason: `UDI 码解析失败：${parsed.errors.join('；')}` }); continue; }
        const judge = judgeScanGtin({ materialGtin: m.gtin, udiRequired: m.udiRequired, codeGtin: parsed.gtin, hasCode: true, force: false });
        if (!judge.ok) {
          void this.audit.write(tenantId, 'wms.wo.issue.udi.mismatch', {
            woNo: wo.woNo, lineNo: line.lineNo, code: item.code, reason: judge.reason,
          }, undefined, 'wms_work_order', wo.id);
          results.push({ ok: false, code: item.code, reason: judge.reason });
          continue;
        }
        const r = await this.udi.issueByScan({
          code: item.code, woNo: wo.woNo, lineNo: line.lineNo,
          materialCode: m.code, qty: Number(line.qtyRequired),
        });
        results.push({ ok: true, idempotent: r.idempotent, code: item.code, udiKey: r.udiKey });
      } catch (e: any) {
        results.push({ ok: false, code: item.code, reason: String(e?.response?.message ?? e?.message ?? e).slice(0, 200) });
      }
    }
    const summary = {
      total: results.length,
      created: results.filter((r) => r.ok && !r.idempotent).length,
      replayed: results.filter((r) => r.ok && r.idempotent).length,
      failed: results.filter((r) => !r.ok).length,

    };
    void this.audit.write(tenantId, 'wms.wo.issue.udi', { woNo: wo.woNo, ...summary }, undefined, 'wms_work_order', wo.id);
    return { udi: { ...summary, results } };
  }

  async issueDone(id: number, dto: { force?: boolean } = {}) {
    const tenantId = useTenantId();
    const wo = await this.requireWo(id);
    const lines = await this.lines.find({ where: { tenantId, woId: id } });
    const allDone = lines.length > 0 && lines.every((l) => round3(Number(l.qtyRequired) - Number(l.qtyIssued)) <= 0.0005);
    const tr = canTransit(wo.status, 'ISSUE_DONE', { allDone, force: dto.force });
    if (!tr.ok) throw new ConflictException(tr.reason!);
    wo.status = tr.to!;
    await this.wos.save(wo);

    const shortages = allDone ? [] : lines.filter((l) => round3(Number(l.qtyRequired) - Number(l.qtyIssued)) > 0.0005)
      .map((l) => ({
        lineId: l.id, lineNo: l.lineNo, materialId: Number(l.materialId),
        required: Number(l.qtyRequired), issued: Number(l.qtyIssued),
        shortage: round3(Number(l.qtyRequired) - Number(l.qtyIssued)), status: l.status,
      }));
    if (tr.forced) {
      void this.audit.write(tenantId, 'wms.wo.issue_done.force', { woNo: wo.woNo, shortages: shortages.length }, undefined, 'wms_work_order', id);
    }
    void this.audit.write(tenantId, 'wms.wo.issue_done', { woNo: wo.woNo, forced: !!tr.forced, shortages: shortages.length }, undefined, 'wms_work_order', id);
    return { ...(await this.detail(id)), shortages };
  }

  // ---------------------------------------------------------------- 缺料
  async shortages(id: number) {
    const tenantId = useTenantId();
    const wo = await this.requireWo(id);
    const lines = await this.lines.find({ where: { tenantId, woId: id }, order: { lineNo: 'ASC' } });
    const items = [];
    for (const l of lines) {
      const required = Number(l.qtyRequired);
      const issued = Number(l.qtyIssued);
      const shortage = round3(Math.max(0, required - issued));
      if (shortage <= 0) continue;
      const m = await this.inventory.resolveMaterial({ tenantId, ref: Number(l.materialId) });
      const batches = await this.inventory.queryBatches({ tenantId, skuId: Number(l.materialId), warehouseId: Number(wo.warehouseId) });
      const available = round3(batches.reduce((s, b) => s + b.qty, 0));
      items.push({
        lineId: l.id, lineNo: l.lineNo, materialCode: m.code, materialName: m.name, unit: m.unit,
        required, issued, shortage, available, status: l.status,
        reason: lineShortageText({ lineNo: l.lineNo, name: m.name, unit: m.unit, required, available, shortage }),
        batches,
      });
    }
    return {
      woNo: wo.woNo, shortageFlag: wo.shortageFlag || items.length > 0,
      total: items.length,
      summary: items.length
        ? `共 ${items.length} 行缺料，合计缺 ${round3(items.reduce((s, i) => s + i.shortage, 0))}；${items.slice(0, 3).map((i) => i.materialName).join('、')}${items.length > 3 ? ` 等 ${items.length} 项` : ''}`
        : null,
      items,
    };
  }

  // ---------------------------------------------------------------- 退料
  async createReturn(id: number, dto: { lineId: number; qty: number; batchNo?: string; locationId?: number; reason: string; approvedBy?: number }) {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const wo = await this.requireWo(id);
    if (!dto.reason || !String(dto.reason).trim()) throw new BadRequestException('退料必须填写原因（可追溯）');
    const tr = canTransit(wo.status, 'RETURN');
    if (!tr.ok) throw new ConflictException(tr.reason!);

    const line = await this.lines.findOne({ where: { tenantId, woId: id, id: Number(dto.lineId) } });
    if (!line) throw new NotFoundException(`工单行不存在：${dto.lineId}`);
    const qty = round3(Number(dto.qty));
    if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('退料数量必须为正数');
    const issued = Number(line.qtyIssued);
    if (round3(qty - issued) > 0.0005) throw new BadRequestException(`退料量 ${qty} 超过已发量 ${issued}`);
    const batchNo: string | undefined = dto.batchNo ?? line.batchNo ?? undefined;

    const seq = (await this.returns.count({ where: { tenantId, woId: id, lineId: line.id } })) + 1;
    const idemKey = returnIdemKey(wo.woNo, line.lineNo, seq).slice(0, 128);
    const dup = await this.returns.findOne({ where: { tenantId, idemKey } });
    if (dup) throw new ConflictException('同一序号的退料已提交（幂等冲突，请刷新后重试）');

    // 先回补库存，再落退料记录（与发料相反的方向，失败即止）
    await this.inventory.increaseStock({
      tenantId, skuId: Number(line.materialId), warehouseId: Number(wo.warehouseId),
      locationId: dto.locationId ?? null, batchNo, qty,
      refType: 'WMS_RETURN', refNo: `${wo.woNo}#${line.lineNo}`,
      idempotencyKey: idemKey,
    });

    const rec = await this.returns.save(this.returns.create({
      tenantId, woId: id, lineId: line.id, materialId: Number(line.materialId),
      batchNo: batchNo ?? null, locationId: dto.locationId ?? null, qty: String(qty),
      idemKey, approvedBy: dto.approvedBy ?? userId ?? null, approvedAt: new Date(),
      reason: String(dto.reason).slice(0, 300),
    }));

    line.qtyIssued = String(round3(issued - qty));
    line.qtyShortage = String(round3(Math.max(0, Number(line.qtyRequired) - Number(line.qtyIssued))));
    line.status = lineStatus(Number(line.qtyIssued), Number(line.qtyRequired), Number(line.qtyShortage));
    await this.lines.save(line);

    wo.status = tr.to!;
    await this.wos.save(wo);
    void this.audit.write(tenantId, 'wms.wo.return', { woNo: wo.woNo, lineNo: line.lineNo, qty, reason: dto.reason }, undefined, 'wms_work_order', id);
    return { returnId: rec.id, idemKey, ...(await this.detail(id)) };
  }

  async close(id: number) {
    const tenantId = useTenantId();
    const wo = await this.requireWo(id);
    const openReturns = 0;   // 退料在提交时即完成（同步回补库存），因此恒为 0；留参数结构以备审批流
    const tr = canTransit(wo.status, 'CLOSE', { openReturns });
    if (!tr.ok) throw new ConflictException(tr.reason!);
    wo.status = tr.to!;
    await this.wos.save(wo);
    void this.audit.write(tenantId, 'wms.wo.close', { woNo: wo.woNo }, undefined, 'wms_work_order', id);
    return this.detail(id);
  }

  // ---------------------------------------------------------------- 补打
  async reprintLabel(lineId: number, n?: number) {
    const tenantId = useTenantId();
    const line = await this.lines.findOne({ where: { tenantId, id: Number(lineId) } });
    if (!line) throw new NotFoundException(`工单行不存在：${lineId}`);
    const wo = await this.requireWo(line.woId);
    const material = await this.inventory.resolveMaterial({ tenantId, ref: Number(line.materialId) });
    const seq = Number(n ?? ((await this.issues.count({ where: { tenantId, woId: wo.id, lineId: line.id } })) + 1));
    const key = reprintIdemKey(wo.woNo, line.lineNo, seq).slice(0, 128);
    const job = await this.printGw.createJob({
      templateCode: PRINT_TEMPLATE, printerRoute: PRINT_ROUTE,
      idempotencyKey: key, source: PRINT_SOURCE,
      variables: {
        woNo: wo.woNo, lineNo: line.lineNo, materialCode: material.code, materialName: material.name,
        batchNo: line.batchNo ?? '', qty: Number(line.qtyIssued) || Number(line.qtyRequired),
        warehouseId: Number(wo.warehouseId), reprint: true, reprintSeq: seq,
      },
    });
    void this.audit.write(tenantId, 'wms.wo.print.reprint', { woNo: wo.woNo, lineNo: line.lineNo, seq, jobId: job.jobId }, undefined, 'wms_work_order', wo.id);
    return { lineId: line.id, lineNo: line.lineNo, jobId: job.jobId, status: job.status, idempotencyKey: key };
  }

  // ---------------------------------------------------------------- 发料记录查询
  async issueRecords(q: { woId?: number; materialCode?: string; since?: string; until?: string; page?: number; pageSize?: number }) {
    const tenantId = useTenantId();
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize ?? 50)));
    const qb = this.issues.createQueryBuilder('r')
      .where('r.tenant_id = :tenantId', { tenantId })
      .orderBy('r.id', 'DESC')
      .skip((page - 1) * pageSize).take(pageSize);
    if (q.woId) qb.andWhere('r.wo_id = :woId', { woId: Number(q.woId) });
    if (q.materialCode) {
      const m = await this.inventory.resolveMaterial({ tenantId, ref: q.materialCode });
      qb.andWhere('r.material_id = :mid', { mid: m.id });
    }
    if (q.since) qb.andWhere('r.created_at >= :since', { since: new Date(q.since) });
    if (q.until) qb.andWhere('r.created_at <= :until', { until: new Date(q.until) });
    const [rows, total] = await qb.getManyAndCount();
    return {
      total, page, pageSize,
      items: rows.map((r) => ({
        id: r.id, woId: Number(r.woId), lineId: Number(r.lineId),
        materialId: Number(r.materialId), batchNo: r.batchNo,
        locationId: r.locationId != null ? Number(r.locationId) : null,
        qty: Number(r.qty), idemKey: r.idemKey, printStatus: r.printStatus, createdAt: r.createdAt,
      })),
    };
  }

  // ---------------------------------------------------------------- 内部
  private async requireWo(id: number): Promise<WmsWorkOrder> {
    const tenantId = useTenantId();
    const wo = await this.wos.findOne({ where: { tenantId, id: Number(id) } });
    if (!wo) throw new NotFoundException(`工单不存在：${id}`);
    return wo;
  }

  private async findLine(woId: number, dto: { lineId?: number; lineNo?: number }) {
    const tenantId = useTenantId();
    if (dto.lineId) return this.lines.findOne({ where: { tenantId, woId, id: Number(dto.lineId) } });
    if (dto.lineNo) return this.lines.findOne({ where: { tenantId, woId, lineNo: Number(dto.lineNo) } });
    return null;
  }
}
