// =============================================================================
// InboundService —— WMS 阶段一：收货与上架业务逻辑
//
// 边界：只通过 InventoryGateway 改库存、PrintGateway 打标签，不 import print/inventory 内部实现。
// 事务：WMS 表变更（行状态/上架任务）用仓库事务；库存变更经 Gateway（内部独立事务）；
//       打印为旁路，失败不阻塞过账，只记 failed 审计 + 提供补打入口。
// 租户：走 Controller 的 JWT 守卫 + TenantContextInterceptor，ALS 已注入；查询带 tenantId 兜底。
// =============================================================================
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule } from '../entities/wms.entity';
import { PrintGateway, PrintJobRequest } from '../../gateways/print.gateway';
import { InventoryGateway } from '../../gateways/inventory.gateway';
import { AuditService } from '../../../audit/audit.module';
import { Material, WarehouseLocation } from '../../../inventory/inventory.entity';
import { recommendLocation, RecommendResult } from './putaway-recommend.calc';
import {
  receiptIdemKey, reprintIdemKey, stockIdemKey, assertStockLocation, calcDiff, buildReceiptVariables,
} from './post-decision.calc';
import { useTenant, useTenantId } from '../../../common/tenant.context';

@Injectable()
export class InboundService {
  private logger = new Logger('InboundService');

  constructor(
    @InjectRepository(WmsReceipt) private receipts: Repository<WmsReceipt>,
    @InjectRepository(WmsReceiptLine) private lines: Repository<WmsReceiptLine>,
    @InjectRepository(WmsPutawayTask) private tasks: Repository<WmsPutawayTask>,
    @InjectRepository(WmsPutawayRule) private rules: Repository<WmsPutawayRule>,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(WarehouseLocation) private locations: Repository<WarehouseLocation>,
    private printGw: PrintGateway,
    private inventoryGw: InventoryGateway,
    private audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ 建单
  async createReceipt(dto: any): Promise<any> {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const exists = await this.receipts.findOne({ where: { tenantId, receiptNo: dto.receiptNo } });
    if (exists) throw new ConflictException(`收货单号已存在：${dto.receiptNo}`);

    // SKU 编码 → id 解析（建单时按编码录入）
    const lineInputs: Array<{ skuId: number; batchNo: string | null; qtyExpected: number }> = [];
    for (const l of dto.lines ?? []) {
      const m = await this.materials.findOne({ where: { tenantId, code: String(l.sku).trim() } });
      if (!m) throw new BadRequestException(`SKU 不存在：${l.sku}`);
      lineInputs.push({ skuId: Number(m.id), batchNo: l.batchNo ?? null, qtyExpected: Number(l.qtyExpected) });
    }

    const receipt = await this.receipts.save(this.receipts.create({
      tenantId, receiptNo: dto.receiptNo, sourceType: dto.sourceType,
      sourceNo: dto.sourceNo ?? null, supplierId: dto.supplierId ?? null,
      warehouseId: dto.warehouseId, remark: dto.remark ?? null,
      status: 'CREATED', createdBy: userId,
    }));
    let lineNo = 1;
    for (const li of lineInputs) {
      await this.lines.save(this.lines.create({
        tenantId, receiptId: receipt.id, lineNo: lineNo++, skuId: li.skuId,
        batchNo: li.batchNo, qtyExpected: String(li.qtyExpected), qtyReceived: '0',
        diffType: null, diffQty: '0', status: 'PENDING',
      }));
    }
    void this.audit.write(tenantId, 'wms.receipt.create', { receiptId: receipt.id, receiptNo: receipt.receiptNo, lines: lineInputs.length });
    return this.getReceipt(receipt.id);
  }

  /** Excel/批量导入：部分成功（成功行入库，失败行返回行级错误，不阻塞成功行） */
  async importReceipt(dto: any): Promise<any> {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    if (await this.receipts.findOne({ where: { tenantId, receiptNo: dto.receiptNo } })) {
      throw new ConflictException(`收货单号已存在：${dto.receiptNo}`);
    }
    const receipt = await this.receipts.save(this.receipts.create({
      tenantId, receiptNo: dto.receiptNo, sourceType: 'EXCEL_IMPORT',
      sourceNo: dto.sourceNo ?? null, supplierId: dto.supplierId ?? null,
      warehouseId: dto.warehouseId, remark: null, status: 'CREATED', createdBy: userId,
    }));
    const created: number[] = [];
    const errors: Array<{ row: number; sku: string; error: string }> = [];
    let lineNo = 1;
    for (let i = 0; i < (dto.rows ?? []).length; i++) {
      const r = dto.rows[i];
      const sku = String(r.sku ?? '').trim();
      const qty = Number(r.qtyExpected);
      try {
        if (!sku || !Number.isFinite(qty) || qty < 0) throw new BadRequestException('sku 或 qtyExpected 非法');
        const m = await this.materials.findOne({ where: { tenantId, code: sku } });
        if (!m) throw new NotFoundException(`SKU 不存在：${sku}`);
        await this.lines.save(this.lines.create({
          tenantId, receiptId: receipt.id, lineNo: lineNo++, skuId: Number(m.id),
          batchNo: r.batchNo ?? null, qtyExpected: String(qty), qtyReceived: '0',
          diffType: null, diffQty: '0', status: 'PENDING',
        }));
        created.push(i + 1);
      } catch (e: any) {
        errors.push({ row: i + 1, sku, error: e?.message ?? String(e) });
      }
    }
    void this.audit.write(tenantId, 'wms.receipt.import', { receiptId: receipt.id, created: created.length, failed: errors.length });
    return { receiptId: receipt.id, receiptNo: receipt.receiptNo, created: created.length, errors };
  }

  async listReceipts(q: { status?: string; page?: number; pageSize?: number }) {
    const tenantId = useTenantId();
    const where: any = { tenantId };
    if (q.status) where.status = q.status;
    const [items, total] = await this.receipts.findAndCount({
      where, order: { createdAt: 'DESC' },
      skip: ((q.page ?? 1) - 1) * (q.pageSize ?? 20), take: Math.min(100, q.pageSize ?? 20),
    });
    return { items: items.map((r) => this.receiptView(r)), total, page: q.page ?? 1 };
  }

  async getReceipt(id: number): Promise<any> {
    const tenantId = useTenantId();
    const r = await this.receipts.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException('收货单不存在');
    const lines = await this.lines.find({ where: { tenantId, receiptId: id }, order: { lineNo: 'ASC' } });
    const lineIds = lines.map((l) => Number(l.id));
    const tasks = lineIds.length
      ? await this.tasks.find({ where: { tenantId, receiptLineId: In(lineIds) } })
      : [];
    return { ...this.receiptView(r), lines: lines.map((l) => this.lineView(l)), putawayTasks: tasks.map((t) => this.taskView(t)) };
  }

  async appendLines(receiptId: number, dto: any): Promise<any> {
    const tenantId = useTenantId();
    const r = await this.receipts.findOne({ where: { id: receiptId, tenantId } });
    if (!r) throw new NotFoundException('收货单不存在');
    if (!['CREATED', 'RECEIVING'].includes(r.status)) throw new BadRequestException('当前状态不允许追加行');
    let lineNo = await this.lines.count({ where: { tenantId, receiptId } }) + 1;
    for (const l of dto.lines ?? []) {
      const m = await this.materials.findOne({ where: { tenantId, code: String(l.sku).trim() } });
      if (!m) throw new BadRequestException(`SKU 不存在：${l.sku}`);
      await this.lines.save(this.lines.create({
        tenantId, receiptId, lineNo: lineNo++, skuId: Number(m.id),
        batchNo: l.batchNo ?? null, qtyExpected: String(Number(l.qtyExpected)),
        qtyReceived: '0', diffType: null, diffQty: '0', status: 'PENDING',
      }));
    }
    return this.getReceipt(receiptId);
  }

  // ------------------------------------------------------------------ 扫码收货
  /**
   * PDA 扫码收货（单次扫码提交）。
   * - 按单收：指定 lineNo/lineId，累加到该行；
   * - 盲收：不指定行，按 SKU 匹配在单行；扫到不在单内 → 标记 WRONG_SKU（新建差异行）。
   * 重复扫同批次累加而非覆盖；超收/短收差异在过账时按 qty_expected 对比。
   */
  async receiveScan(receiptId: number, dto: any): Promise<any> {
    const tenantId = useTenantId();
    const r = await this.receipts.findOne({ where: { id: receiptId, tenantId } });
    if (!r) throw new NotFoundException('收货单不存在');
    if (r.status === 'CANCELLED' || ['RECEIVED', 'PUTAWAY_DONE'].includes(r.status)) {
      throw new BadRequestException('当前状态不允许扫码收货');
    }
    const qty = Number(dto.qty);
    if (!(qty > 0)) throw new BadRequestException('实收数量必须为正数');
    const skuCode = String(dto.sku ?? '').trim();
    const material = skuCode
      ? await this.materials.findOne({ where: { tenantId, code: skuCode } })
      : null;

    let target: WmsReceiptLine | null = null;
    if (dto.lineId || dto.lineNo) {
      target = await this.lines.findOne({
        where: { tenantId, receiptId, ...(dto.lineId ? { id: Number(dto.lineId) } : { lineNo: Number(dto.lineNo) }) },
      });
      if (!target) throw new NotFoundException('收货行不存在');
      // 校验扫到的 SKU 与行 SKU 一致
      if (material && Number(material.id) !== Number(target.skuId)) {
        await this.lines.update({ id: target.id }, { diffType: 'WRONG_SKU' });
        void this.audit.write(tenantId, 'wms.receive.wrong_sku', { receiptId, lineId: target.id, scannedSku: skuCode });
        return { ok: true, warning: 'WRONG_SKU：扫到的 SKU 与行不符，已标记差异', line: this.lineView(target) };
      }
    } else {
      // 盲收：按 SKU 找单内行
      if (!material) throw new BadRequestException('盲收必须提供有效 SKU');
      target = await this.lines.findOne({ where: { tenantId, receiptId, skuId: Number(material.id) }, order: { lineNo: 'ASC' } });
      if (!target) {
        // 不在单内：新增 WRONG_SKU 差异行（lineNo 取最大值 +1）
        const maxNo = await this.lines.count({ where: { tenantId, receiptId } }) + 1;
        const wrong = await this.lines.save(this.lines.create({
          tenantId, receiptId, lineNo: maxNo, skuId: Number(material.id),
          batchNo: dto.batchNo ?? null, qtyExpected: '0', qtyReceived: String(qty),
          diffType: 'WRONG_SKU', diffQty: String(qty), status: 'PENDING',
        }));
        void this.audit.write(tenantId, 'wms.receive.wrong_sku', { receiptId, lineId: wrong.id, scannedSku: skuCode, qty });
        return { ok: true, warning: 'WRONG_SKU：SKU 不在收货单内，已新增差异行', line: this.lineView(wrong) };
      }
    }

    // 累加（同批次累加而非覆盖）
    const before = Number(target.qtyReceived);
    const after = before + qty;
    const expected = Number(target.qtyExpected);
    const diff = calcDiff(expected, after);
    const diffType: string | null = diff.diffType ?? target.diffType;   // WRONG_SKU 标记不被覆盖
    const diffQty = diff.diffQty || Number(target.diffQty ?? 0);
    await this.lines.update({ id: target.id }, {
      qtyReceived: String(after), diffType, diffQty: String(diffQty),
      ...(dto.batchNo ? { batchNo: dto.batchNo } : {}),
      ...(dto.remark ? {} : {}),
    });
    if (r.status === 'CREATED') await this.receipts.update({ id: r.id }, { status: 'RECEIVING' });
    void this.audit.write(tenantId, 'wms.receive.scan', { receiptId, lineId: target.id, scannedSku: skuCode, qty, cumulative: after });
    const refreshed = await this.lines.findOne({ where: { id: Number(target.id) } });
    return { ok: true, line: refreshed ? this.lineView(refreshed) : this.lineView(target) };
  }

  // ------------------------------------------------------------------ 收货过账
  /**
   * 收货过账（US-4）：
   *   1) 更新行状态 RECEIVED
   *   2) InventoryGateway 增加库存（批次维度，落推荐库位——杜绝无库位库存）
   *   3) 生成上架任务
   *   4) PrintGateway 触发收货标签（幂等键 GRN:{receipt_no}:{line_no}），失败不阻塞
   *   5) 打印调用记录（审计）
   * 重复过账被拒绝（status 守卫）。
   */
  async postReceipt(receiptId: number): Promise<any> {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const r = await this.receipts.findOne({ where: { id: receiptId, tenantId } });
    if (!r) throw new NotFoundException('收货单不存在');
    if (['RECEIVED', 'PUTAWAY_DONE'].includes(r.status)) throw new ConflictException('重复过账被拒绝：收货单已过账');
    if (r.status === 'CANCELLED') throw new BadRequestException('已取消的收货单不能过账');

    // 补偿加固：纳入「已 RECEIVED 但仍缺上架任务」的中间态行。
    // 失败点还原：increaseStock(库存,有幂等键) → 行状态 RECEIVED → tasks.save(无幂等保护) → 打印(旁路)。
    // 若在 tasks.save 前崩溃，行已是 RECEIVED 却无任务；只查 PENDING 会漏掉该行 → 任务永久丢失、整单卡死。
    // 以「是否已有上架任务」作为该行过账完成的幂等标志：有则跳过，无则（重）走，靠库存/打印幂等键防重复。
    const lines = await this.lines.find({
      where: { tenantId, receiptId, status: In(['PENDING', 'RECEIVED']) },
      order: { lineNo: 'ASC' },
    });
    if (!lines.length) throw new BadRequestException('没有待过账的收货行');

    // 预载该单已存在的上架任务，用于幂等跳过已过账行
    const existingTasks = await this.tasks.find({
      where: { tenantId, receiptLineId: In(lines.map((l) => Number(l.id))) },
    });
    const postedLineIds = new Set(existingTasks.map((t) => Number(t.receiptLineId)));

    const results: any[] = [];
    for (const line of lines) {
      // 已有上架任务 = 该行过账已完成（库存已加、行已 RECEIVED、任务已建），直接跳过，保证重试幂等
      if (postedLineIds.has(Number(line.id))) {
        results.push({ lineId: line.id, lineNo: line.lineNo, skipped: 'already_posted' });
        continue;
      }
      const qty = Number(line.qtyReceived);
      const sku = await this.materials.findOne({ where: { tenantId, id: Number(line.skuId) } });
      if (!sku) throw new NotFoundException(`物料不存在：${line.skuId}`);

      // C5：过账时就算出推荐库位并直接入库（无暂存位概念，禁止无库位库存）
      const recommend = await this.recommendFor(tenantId, Number(r.warehouseId), {
        abc: (sku as any).abc ?? null, code: sku.code,
      });
      // C5 硬约束：库位必须确定，杜绝无库位库存
      let locationId: number;
      try {
        locationId = assertStockLocation(recommend.locationId, recommend.reason);
      } catch (e: any) {
        throw new BadRequestException(e.message);
      }

      const refNo = `${r.receiptNo}`;
      const idemKey = receiptIdemKey(r.receiptNo, line.lineNo);
      // 2) 库存变更（Gateway 内部幂等 + 独立事务）
      const movement = await this.inventoryGw.increaseStock({
        tenantId, skuId: line.skuId, warehouseId: r.warehouseId,
        locationId, batchNo: line.batchNo ?? undefined,
        qty, unit: sku.unit, refType: 'WMS_RECEIPT', refNo, idempotencyKey: stockIdemKey(r.receiptNo, line.lineNo),
      });

      // 1) 行状态
      await this.lines.update({ id: line.id }, { status: 'RECEIVED' });
      // 3) 上架任务（ASSIGNED：推荐位即目标位）
      await this.tasks.save(this.tasks.create({
        tenantId, receiptLineId: Number(line.id), suggestedLocationId: locationId,
        actualLocationId: null, qty: String(qty), status: 'ASSIGNED',
        recommendReason: recommend.reason, operatorId: null, finishedAt: null,
      }));

      // 4) 打印（旁路，失败不阻塞）
      let printResult: any = { status: 'skipped' };
      try {
        const req: PrintJobRequest = {
          templateCode: 'RECEIPT_LABEL_V1',
          printerRoute: 'receipt-station',
          idempotencyKey: idemKey,
          variables: buildReceiptVariables({
            skuCode: sku.code, skuName: sku.name, unit: sku.unit, batchNo: line.batchNo,
            qty, receiptNo: r.receiptNo, lineNo: line.lineNo,
          }),
          source: 'wms.inbound.receipt',
          copies: 1,
        };
        const pr = await this.printGw.createJob(req);
        printResult = pr;
        void this.audit.write(tenantId, 'wms.print.call', {
          source: 'wms.inbound.receipt', idempotencyKey: idemKey, jobId: pr.jobId,
          status: pr.status, errorCode: pr.errorCode ?? null,
        }, userId, 'wms_receipt_line', Number(line.id));
      } catch (e: any) {
        printResult = { status: 'failed', error: e?.message ?? String(e) };
        void this.audit.write(tenantId, 'wms.print.call', {
          source: 'wms.inbound.receipt', idempotencyKey: idemKey, jobId: null,
          status: 'failed', error: e?.message ?? String(e),
        }, userId, 'wms_receipt_line', Number(line.id));
      }
      results.push({ lineId: line.id, lineNo: line.lineNo, movementId: movement.movementId, recommend, print: printResult });
    }

    await this.receipts.update({ id: r.id }, { status: 'RECEIVED' });
    void this.audit.write(tenantId, 'wms.receipt.post', { receiptId: r.id, receiptNo: r.receiptNo, lines: results.length });
    return { receiptId: r.id, receiptNo: r.receiptNo, status: 'RECEIVED', results };
  }

  // ------------------------------------------------------------------ 上架任务
  async listPutawayTasks(q: { status?: string; page?: number; pageSize?: number }) {
    const tenantId = useTenantId();
    const where: any = { tenantId };
    if (q.status) where.status = q.status;
    const [items, total] = await this.tasks.findAndCount({
      where, order: { createdAt: 'DESC' },
      skip: ((q.page ?? 1) - 1) * (q.pageSize ?? 20), take: Math.min(100, q.pageSize ?? 20),
    });
    return { items: items.map((t) => this.taskView(t)), total };
  }

  async getRecommend(taskId: number): Promise<any> {
    const tenantId = useTenantId();
    const task = await this.tasks.findOne({ where: { id: taskId, tenantId } });
    if (!task) throw new NotFoundException('上架任务不存在');
    const line = await this.lines.findOne({ where: { id: Number(task.receiptLineId), tenantId } });
    if (!line) throw new NotFoundException('收货行不存在');
    const r = await this.receipts.findOne({ where: { id: Number(line.receiptId), tenantId } });
    const sku = await this.materials.findOne({ where: { tenantId, id: Number(line.skuId) } });
    const rec = await this.recommendFor(tenantId, Number(r!.warehouseId), {
      abc: (sku as any)?.abc ?? null, code: sku?.code,
    });
    return { taskId, ...rec, currentSuggestedLocationId: task.suggestedLocationId, storedReason: task.recommendReason };
  }

  async confirmPutaway(taskId: number, dto: any): Promise<any> {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const task = await this.tasks.findOne({ where: { id: taskId, tenantId } });
    if (!task) throw new NotFoundException('上架任务不存在');
    if (task.status === 'DONE') throw new ConflictException('上架任务已完成');
    if (task.status === 'CANCELLED') throw new BadRequestException('已取消的任务不能确认');
    const actual = dto.actualLocationId != null
      ? Number(dto.actualLocationId) : Number(task.suggestedLocationId);
    if (!actual) throw new BadRequestException('缺少目标库位（推荐位为空且未指定实际库位）');
    // 校验库位有效
    const loc = await this.locations.findOne({ where: { id: actual, tenantId, active: true } });
    if (!loc) throw new NotFoundException('目标库位不存在或已停用');

    await this.tasks.update({ id: task.id }, {
      actualLocationId: actual, status: 'DONE', operatorId: userId, finishedAt: new Date(),
    });
    await this.lines.update({ id: Number(task.receiptLineId) }, { status: 'PUTAWAY_DONE' });
    // 阶段一不做同仓移库位（过账已直接入库到推荐位）；改库位仅记录差异 + 审计
    void this.audit.write(tenantId, 'wms.putaway.confirm', {
      taskId, suggestedLocationId: task.suggestedLocationId, actualLocationId: actual,
      changed: Number(task.suggestedLocationId) !== actual, remark: dto.remark ?? null,
    }, userId, 'wms_putaway_task', taskId);
    // 全部行上架完成 → 整单 PUTAWAY_DONE
    const remaining = await this.tasks.count({ where: { tenantId, status: In(['CREATED', 'ASSIGNED']) } });
    const line = await this.lines.findOne({ where: { id: Number(task.receiptLineId), tenantId } });
    if (line && remaining === 0) {
      await this.receipts.update({ id: Number(line.receiptId), tenantId }, { status: 'PUTAWAY_DONE' });
    }
    return { taskId, status: 'DONE', actualLocationId: actual, note: '阶段一：过账已入库到推荐位，改库位仅记录差异' };
  }

  // ------------------------------------------------------------------ 补打
  /** 补打标签：使用新幂等键 GRN:{no}:{line}:reprint:{n}，source 打 reprint 标记 */
  async reprintLabel(lineId: number): Promise<any> {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const line = await this.lines.findOne({ where: { id: lineId, tenantId } });
    if (!line) throw new NotFoundException('收货行不存在');
    if (!['RECEIVED', 'PUTAWAY_DONE'].includes(line.status)) throw new BadRequestException('仅已过账的收货行可补打');
    const r = await this.receipts.findOne({ where: { id: Number(line.receiptId), tenantId } });
    const sku = await this.materials.findOne({ where: { tenantId, id: Number(line.skuId) } });
    const reprintCount = await this.audit.find({ action: 'wms.print.call', page: 1, pageSize: 1000 })
      .then((rows) => rows.filter((x: any) => String(x.detail?.idempotencyKey ?? '').includes(reprintIdemKey(r!.receiptNo, line.lineNo, 0).replace(/:\d+$/, ':'))).length)
      .catch(() => 0);
    const idemKey = reprintIdemKey(r!.receiptNo, line.lineNo, reprintCount + 1);
    try {
      const pr = await this.printGw.createJob({
        templateCode: 'RECEIPT_LABEL_V1', printerRoute: 'receipt-station',
        idempotencyKey: idemKey,
        variables: buildReceiptVariables({
          skuCode: sku!.code, skuName: sku!.name, unit: sku!.unit, batchNo: line.batchNo,
          qty: Number(line.qtyReceived), receiptNo: r!.receiptNo, lineNo: line.lineNo,
        }),
        source: 'wms.inbound.receipt.reprint', copies: 1,
      });
      void this.audit.write(tenantId, 'wms.print.call', {
        source: 'wms.inbound.receipt.reprint', idempotencyKey: idemKey, jobId: pr.jobId, status: pr.status,
      }, userId, 'wms_receipt_line', lineId);
      return { ...pr, idempotencyKey: idemKey };
    } catch (e: any) {
      void this.audit.write(tenantId, 'wms.print.call', {
        source: 'wms.inbound.receipt.reprint', idempotencyKey: idemKey, jobId: null, status: 'failed', error: e?.message,
      }, userId, 'wms_receipt_line', lineId);
      throw e;
    }
  }

  // ------------------------------------------------------------------ 内部辅助
  private async recommendFor(tenantId: number, warehouseId: number, material: { abc?: string | null; code?: string }): Promise<RecommendResult> {
    const rules = await this.rules.find({ where: { tenantId, warehouseId, enabled: true }, order: { priority: 'ASC' } });
    const locs = await this.locations.find({ where: { tenantId, warehouseId, active: true }, order: { code: 'ASC' } });
    return recommendLocation({
      rules: rules.map((r) => ({
        id: Number(r.id), priority: r.priority, enabled: r.enabled,
        conditionJson: r.conditionJson ?? {}, actionJson: r.actionJson ?? {},
      })),
      locations: locs.map((l) => ({
        id: Number(l.id), code: l.code, zone: l.zone ?? null,
        utilization: null, sortKey: Number(l.id),
      })),
      material,
    });
  }

  private receiptView(r: WmsReceipt) {
    return {
      id: Number(r.id), receiptNo: r.receiptNo, sourceType: r.sourceType,
      sourceNo: r.sourceNo, supplierId: r.supplierId ? Number(r.supplierId) : null,
      warehouseId: Number(r.warehouseId), status: r.status, remark: r.remark,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }
  private lineView(l: WmsReceiptLine) {
    return {
      id: Number(l.id), lineNo: l.lineNo, skuId: Number(l.skuId), batchNo: l.batchNo,
      qtyExpected: Number(l.qtyExpected), qtyReceived: Number(l.qtyReceived),
      diffType: l.diffType, diffQty: Number(l.diffQty ?? 0), status: l.status,
    };
  }
  private taskView(t: WmsPutawayTask) {
    return {
      id: Number(t.id), receiptLineId: Number(t.receiptLineId),
      suggestedLocationId: t.suggestedLocationId ? Number(t.suggestedLocationId) : null,
      actualLocationId: t.actualLocationId ? Number(t.actualLocationId) : null,
      qty: Number(t.qty), status: t.status, recommendReason: t.recommendReason,
      createdAt: t.createdAt, finishedAt: t.finishedAt,
    };
  }
}
