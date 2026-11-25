// =============================================================================
// CartonPackService —— 装箱出码（一箱一码）+ 尾箱 + 箱标打印
//
// 设计边界：
//   · 只做"算箱 + 生成 SSCC + 登记包装 + 调打印"，不改库存、不建收货单；
//   · 打印固定走 PrintGateway（HTTP /internal/print-jobs），不 import print 内部实现；
//   · 箱码 = SSCC-18（GS1），序列来自 PG 序列 sscc_serial_seq，全局唯一；
//   · 尾箱（不足一箱）默认也出一码，qty 记真实件数，标签上标「尾箱」。
//
// 表：udi_packages（sscc/level/gtin/qty/parent_sscc/work_order_no）
// 模板：CARTON_LABEL_V1（scripts/wms_p10_carton_label.sql 种子）
// =============================================================================
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { UdiPackage } from '../../udi/entities/udi.entity';
import { Material, MaterialGtin } from '../../inventory/inventory.entity';
import { WmsReceipt, WmsReceiptLine } from '../inbound/entities/wms.entity';
import { WmsWorkOrder } from '../issuing/entities/wo.entity';
import { AuditService } from '../../audit/audit.module';
import { useTenant, useTenantId } from '../../common/tenant.context';
import { PrintGateway } from '../gateways/print.gateway';
import { buildSscc, planBoxes, normalizePrefix, DEFAULT_GS1_PREFIX } from '../../udi/udi.sscc.calc';

export interface PackDto {
  /** 物料编码（与 gtin 二选一） */
  skuCode?: string;
  /** 箱码 GTIN（material_gtins 里的 CARTON 条码；多档箱规时用它指定） */
  gtin?: string;
  /** 总件数（要装进箱子的总量，可以不是每箱件数的整数倍 → 自动出尾箱） */
  totalQty: number;
  /** 每箱件数；不传则取物料 CARTON 的 packQty（多档时必须传 gtin 或 packQty 指定） */
  packQty?: number;
  packLevel?: 'CARTON' | 'PALLET';
  batchNo?: string;
  /** 上级包装 SSCC（中箱→托盘） */
  parentSscc?: string;
  /** 装箱来源：RECEIPT（收货单）/ WORK_ORDER（工单）；不给 = 自由装箱 */
  sourceType?: 'RECEIPT' | 'WORK_ORDER';
  /** 来源单号：收货单号 / 工单号（sourceType 给了就必填） */
  sourceNo?: string;
  workOrderNo?: string;
  /** 尾箱是否单独出一码，默认 true */
  allowTail?: boolean;
  /** 是否打印箱标，默认 false */
  print?: boolean;
  /** 打印路由，默认 carton-station */
  printerRoute?: string;
  /** 箱标模板 code，默认 CARTON_LABEL_V1 */
  templateCode?: string;
  /** 每箱标签份数 */
  copies?: number;
}

export interface ScanDto {
  /** 扫到的码：单元码/箱码 GTIN（14 位），或已装箱的 SSCC（18 位） */
  code: string;
  /** 当前页面正在装的物料；传了就校验扫到的物料与之一致，防串料 */
  skuCode?: string;
}

@Injectable()
export class CartonPackService {
  private logger = new Logger('CartonPackService');

  constructor(
    @InjectRepository(UdiPackage) private packages: Repository<UdiPackage>,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(MaterialGtin) private gtins: Repository<MaterialGtin>,
    @InjectRepository(WmsReceipt) private receipts: Repository<WmsReceipt>,
    @InjectRepository(WmsReceiptLine) private receiptLines: Repository<WmsReceiptLine>,
    @InjectRepository(WmsWorkOrder) private workOrders: Repository<WmsWorkOrder>,
    private printGateway: PrintGateway,
    private audit: AuditService,
  ) {}

  async pack(dto: PackDto) {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const totalQty = Number(dto.totalQty);
    if (!(totalQty > 0)) throw new BadRequestException('totalQty 必须为正数');

    // 1) 解析物料 / 箱规
    const resolved = await this.resolvePackSpec(tenantId, dto);

    // 1.5) 来源校验：选了单据就必须在剩余量内（超出直接 400，不记账）
    let src: { type: 'RECEIPT' | 'WORK_ORDER'; no: string } | null = null;
    if (dto.sourceType) {
      const st = String(dto.sourceType).toUpperCase();
      if (st !== 'RECEIPT' && st !== 'WORK_ORDER') {
        throw new BadRequestException('sourceType 只支持 RECEIPT / WORK_ORDER（自由装箱请不要传）');
      }
      if (!dto.sourceNo) throw new BadRequestException('传了 sourceType 就必须传 sourceNo');
      src = { type: st as 'RECEIPT' | 'WORK_ORDER', no: String(dto.sourceNo).trim() };
      const info = await this.sourceInfo({ type: src.type, no: src.no, skuCode: resolved.skuCode });
      if (totalQty > Number(info.remainingQty) + 1e-6) {
        throw new BadRequestException(
          `超出该单剩余可装箱数量：${src.no} 剩余 ${info.remainingQty}${info.unit ?? ''}，本次要装 ${totalQty}${info.unit ?? ''}`,
        );
      }
    }

    // 2) 算箱（满箱 + 尾箱）
    let plan: ReturnType<typeof planBoxes>;
    try {
      plan = planBoxes(totalQty, resolved.packQty, dto.allowTail !== false, 1000);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? '装箱参数不合法');
    }

    // 3) 逐箱生成 SSCC 并登记包装
    const prefix = normalizePrefix(process.env.GS1_COMPANY_PREFIX || DEFAULT_GS1_PREFIX);
    const extDigit = Number(process.env.SSCC_EXTENSION_DIGIT ?? 0) || 0;
    const boxes: Array<{ sscc: string; qty: number; tail: boolean; boxNo: number }> = [];
    for (let i = 0; i < plan.boxes.length; i++) {
      const qty = plan.boxes[i];
      const serial = await this.nextSerial();
      const sscc = buildSscc(prefix, serial, extDigit);
      await this.packages.save(this.packages.create({
        tenantId,
        sscc,
        level: dto.packLevel ?? 'CARTON',
        gtin: resolved.cartonGtin ?? null,
        qty: String(qty),
        parentSscc: dto.parentSscc ?? null,
        workOrderNo: dto.workOrderNo ?? (src?.type === 'WORK_ORDER' ? src.no : null),
        sourceType: src?.type ?? null,
        sourceNo: src?.no ?? null,
        createdBy: userId ?? null,
      }));
      boxes.push({ sscc, qty, tail: plan.tailQty > 0 && i === plan.boxes.length - 1, boxNo: i + 1 });
    }

    await this.audit.write(tenantId, 'wms.carton.pack', {
      skuCode: resolved.skuCode, totalQty, packQty: resolved.packQty,
      fullBoxes: plan.fullBoxes, tailQty: plan.tailQty, boxes: boxes.length,
      sourceType: src?.type ?? null, sourceNo: src?.no ?? null,
      printed: !!dto.print,
    }, undefined, 'udi_package');

    // 4) 可选打印（失败不阻塞装箱；结果逐箱回传）
    let printInfo: any = null;
    if (dto.print) {
      printInfo = await this.printBoxes(resolved, plan, boxes, dto);
    }

    return {
      skuCode: resolved.skuCode,
      productName: resolved.productName,
      unit: resolved.unit,
      cartonGtin: resolved.cartonGtin,
      packQty: resolved.packQty,
      totalQty,
      fullBoxes: plan.fullBoxes,
      tailQty: plan.tailQty,
      boxCount: boxes.length,
      sourceType: src?.type ?? null,
      sourceNo: src?.no ?? null,
      boxes: boxes.map((b) => ({
        ...b,
        printed: printInfo?.perBox?.find((p: any) => p.sscc === b.sscc) ?? null,
      })),
      print: printInfo ? { ok: printInfo.ok, errors: printInfo.errors, warnings: printInfo.warnings } : null,
    };
  }

  /** 箱规查询：PDA/PC 选物料后拉档位，避免盲填 packQty */
  /**
   * 来源单据查询：这单还能装多少（收货单 / 工单通用）。
   * 口径：收货单取 qty_received（有过账实收就用实收，否则用 qty_expected）；
   *     工单取 work_orders.demand_qty；已装箱量 = udi_packages 里挂该单的 qty 之和。
   */
  async sourceInfo(q: { type: string; no: string; skuCode?: string }) {
    const tenantId = useTenantId();
    const type = String(q.type ?? '').toUpperCase();
    const no = String(q.no ?? '').trim();
    if (!no) throw new BadRequestException('no 必填');
    const wantSku = q.skuCode ? String(q.skuCode).trim() : '';
    let mat: Material | null = null;
    if (wantSku) {
      mat = await this.materials.findOne({ where: { tenantId, code: wantSku, active: true } });
      if (!mat) throw new NotFoundException(`物料不存在或已停用：${wantSku}`);
    }

    if (type === 'RECEIPT') {
      const rc = await this.receipts.findOne({ where: { tenantId, receiptNo: no } });
      if (!rc) throw new NotFoundException(`收货单不存在：${no}`);
      const lines = await this.receiptLines.find({ where: { tenantId, receiptId: rc.id }, order: { lineNo: 'ASC' } });
      const sel = mat ? lines.filter((l) => Number(l.skuId) === Number(mat!.id)) : lines;
      if (mat && !sel.length) throw new NotFoundException(`收货单 ${no} 里没有 ${wantSku} 的行`);
      const expected = Number(sel.reduce((a, l) => a + Number(l.qtyExpected || 0), 0).toFixed(3));
      const received = Number(sel.reduce((a, l) => a + Number(l.qtyReceived || 0), 0).toFixed(3));
      const basis = received > 0 ? 'RECEIVED' : 'EXPECTED';
      const sourceQty = basis === 'RECEIVED' ? received : expected;
      const batches = [...new Set(sel.map((l) => l.batchNo).filter(Boolean))] as string[];
      const packedQty = await this.sumPacked({ tenantId, sourceType: 'RECEIPT', sourceNo: no, material: mat });
      return {
        sourceType: 'RECEIPT', sourceNo: no, status: rc.status,
        skuCode: mat?.code ?? null, productName: mat?.name ?? null, unit: mat?.unit ?? null,
        basis, expectedQty: expected, receivedQty: received, sourceQty,
        packedQty, remainingQty: Math.max(0, Number((sourceQty - packedQty).toFixed(3))),
        batchNo: batches.length === 1 ? batches[0] : null, batches, lineCount: sel.length,
      };
    }

    if (type === 'WORK_ORDER') {
      const wo = await this.workOrders.findOne({ where: { tenantId, woNo: no } });
      if (!wo) throw new NotFoundException(`工单不存在：${no}`);
      const prod = await this.materials.findOne({ where: { tenantId, id: Number(wo.productMaterialId) } });
      if (mat && prod && mat.code !== prod.code) {
        throw new BadRequestException(`工单 ${no} 的产出物料是 ${prod.code}，不是 ${mat.code}（防串料）`);
      }
      const demand = Number(wo.demandQty || 0);
      const packedQty = await this.sumPacked({ tenantId, sourceType: 'WORK_ORDER', sourceNo: no, material: prod });
      return {
        sourceType: 'WORK_ORDER', sourceNo: no, status: wo.status,
        skuCode: prod?.code ?? null, productName: prod?.name ?? null, unit: prod?.unit ?? null,
        basis: 'DEMAND', sourceQty: demand, packedQty,
        remainingQty: Math.max(0, Number((demand - packedQty).toFixed(3))),
        batchNo: null, batches: [], lineCount: 0,
      };
    }

    throw new BadRequestException('type 只支持 RECEIPT / WORK_ORDER');
  }

  /** 该来源单已装箱量（工单兼容历史 work_order_no 数据，按 sscc 去重） */
  private async sumPacked(p: { tenantId: number; sourceType: string; sourceNo: string; material: Material | null }) {
    const bySource = await this.packages.find({ where: { tenantId: p.tenantId, sourceType: p.sourceType, sourceNo: p.sourceNo } });
    let rows = bySource;
    if (p.sourceType === 'WORK_ORDER') {
      const legacy = await this.packages.find({ where: { tenantId: p.tenantId, workOrderNo: p.sourceNo } });
      const ids = new Set(bySource.map((r) => r.id));
      rows = [...bySource, ...legacy.filter((r) => !ids.has(r.id))];
    }
    let sel = rows;
    if (p.material) {
      const gs = await this.gtins.find({ where: { tenantId: p.tenantId, materialId: Number(p.material.id) } });
      const set = new Set<string>(gs.map((g) => g.gtin));
      if (p.material.gtin) set.add(p.material.gtin);
      sel = rows.filter((r) => !!r.gtin && set.has(r.gtin));
    }
    return Number(sel.reduce((a, r) => a + Number(r.qty || 0), 0).toFixed(3));
  }

  /**
   * 扫码点数：PDA 装箱页扫单元码/箱码，折算成件数累加（A 阶段不做单据，只做计数）。
   * - GTIN（14 位）→ material_gtins 折算：UNIT=1，CARTON/PALLET=packQty；
   * - SSCC（18 位）已在 udi_packages 登记 → alreadyPacked=true，调用方不得再计入（同箱重扫守卫）；
   * - 同一 GTIN 反复扫是正常的（同规格多箱），不做去重，由调用方按次数累加。
   */
  async scan(dto: ScanDto) {
    const tenantId = useTenantId();
    const raw = String(dto.code ?? '').trim();
    if (!raw) throw new BadRequestException('code 必填');
    // GS1 HRI 去括号： (01)0690... / (00)0690...
    const digits = raw.replace(/\(\d{2,4}\)/g, '').replace(/[^0-9]/g, '');

    // A) SSCC：18 位，且必须已登记（否则说明不是本系统出的箱码）
    if (digits.length === 18) {
      const pk = await this.packages.findOne({ where: { tenantId, sscc: digits } });
      if (!pk) throw new BadRequestException(`SSCC ${digits} 未登记（不是本系统生成的箱码，或租户不对）`);
      // 箱码 GTIN 存在 material_gtins（不是 materials.gtin），必须先反查到物料
      let mat: Material | null = null;
      if (pk.gtin) {
        const g = await this.gtins.findOne({ where: { tenantId, gtin: pk.gtin } });
        if (g) mat = await this.materials.findOne({ where: { tenantId, id: Number(g.materialId) } });
      }
      if (!mat) mat = await this.materials.findOne({ where: { tenantId, gtin: pk.gtin ?? '' } });
      return {
        kind: 'SSCC' as const, code: digits, sscc: digits, gtin: pk.gtin,
        skuCode: mat?.code ?? null, productName: mat?.name ?? null, unit: mat?.unit ?? null,
        packLevel: pk.level, packQty: Number(pk.qty), units: Number(pk.qty),
        alreadyPacked: true,
        message: `这箱已经装过了（${pk.level} · ${Number(pk.qty)}${mat?.unit ?? ''}）`,
      };
    }

    // B) GTIN：只接受 14 位（与收货扫描口径一致，8/12/13 位需先补零）
    if (digits.length !== 14) {
      throw new BadRequestException(`无法识别该码（${digits.length} 位）：装箱点数只接受 14 位 GTIN 或 18 位 SSCC`);
    }
    const rows = await this.gtins.find({ where: { tenantId, gtin: digits } });
    const ids = [...new Set(rows.map((r) => Number(r.materialId)))];
    if (!ids.length) {
      const byPrimary = await this.materials.find({ where: { tenantId, gtin: digits, active: true } });
      if (!byPrimary.length) throw new BadRequestException(`GTIN ${digits} 未匹配到物料（请先在主数据登记）`);
      const m0 = byPrimary[0];
      return {
        kind: 'GTIN' as const, code: digits, gtin: digits, skuCode: m0.code, productName: m0.name,
        unit: m0.unit, packLevel: 'UNIT', packQty: 1, units: 1, alreadyPacked: false,
      };
    }
    let mats = await this.materials.find({ where: { tenantId, id: In(ids), active: true } });
    const wantSku = dto.skuCode ? String(dto.skuCode).trim() : '';
    if (wantSku) {
      mats = mats.filter((m) => m.code === wantSku);
      if (!mats.length) {
        throw new BadRequestException(`扫到的是别的物料：${digits} 不属于 ${wantSku}（防串料）`);
      }
    }
    if (!mats.length) throw new BadRequestException(`GTIN ${digits} 只匹配到已停用物料`);
    if (mats.length > 1) {
      throw new BadRequestException(
        `GTIN ${digits} 同时属于多个物料（${mats.map((m) => m.code).join('、')}），请带 skuCode 指定`,
      );
    }
    const m = mats[0];
    const row = rows.find((r) => Number(r.materialId) === Number(m.id));
    const packLevel = row?.packLevel ?? 'UNIT';
    const packQty = row ? Number(row.packQty) || 1 : 1;
    return {
      kind: 'GTIN' as const, code: digits, gtin: digits, skuCode: m.code, productName: m.name,
      unit: m.unit, packLevel, packQty, units: packLevel === 'UNIT' ? 1 : packQty,
      alreadyPacked: false,
    };
  }

  async specs(skuCode: string) {
    const tenantId = useTenantId();
    if (!skuCode) throw new BadRequestException('skuCode 必填');
    const material = await this.materials.findOne({ where: { tenantId, code: String(skuCode).trim(), active: true } });
    if (!material) throw new NotFoundException(`物料不存在或已停用：${skuCode}`);
    const rows = await this.gtins.find({ where: { tenantId, materialId: material.id }, order: { packQty: 'ASC' } });
    const cartons = rows.filter((r) => r.packLevel === 'CARTON');
    const pallets = rows.filter((r) => r.packLevel === 'PALLET');
    return {
      skuCode: material.code,
      productName: material.name,
      spec: material.spec,
      unit: material.unit,
      unitGtin: rows.find((r) => r.packLevel === 'UNIT')?.gtin ?? material.gtin ?? null,
      cartons: cartons.map((r) => ({ gtin: r.gtin, packQty: Number(r.packQty), label: `${Number(r.packQty)}${material.unit}/箱` })),
      pallets: pallets.map((r) => ({ gtin: r.gtin, packQty: Number(r.packQty), label: `${Number(r.packQty)}${material.unit}/托` })),
    };
  }

  /** 已装箱清单（最近的包装记录，供核对/补打箱标） */
  async listPacks(limit = 50) {
    const tenantId = useTenantId();
    const rows = await this.packages.find({
      where: { tenantId, level: In(['CARTON', 'PALLET']) },
      order: { id: 'DESC' },
      take: Math.max(1, Math.min(500, Number(limit) || 50)),
    });
    return rows.map((r) => ({
      sscc: r.sscc, level: r.level, gtin: r.gtin, qty: Number(r.qty),
      parentSscc: r.parentSscc, workOrderNo: r.workOrderNo, createdAt: r.createdAt,
    }));
  }

  /** 解析物料：skuCode / gtin → material + packQty + 箱码 GTIN */
  private async resolvePackSpec(tenantId: number, dto: PackDto) {
    let material: Material | null = null;
    let cartonGtin: string | null = dto.gtin ? String(dto.gtin).replace(/\D/g, '') : null;

    if (dto.skuCode) {
      material = await this.materials.findOne({ where: { tenantId, code: String(dto.skuCode).trim(), active: true } });
      if (!material) throw new NotFoundException(`物料不存在或已停用：${dto.skuCode}`);
    } else if (cartonGtin) {
      const row = await this.gtins.findOne({ where: { tenantId, gtin: cartonGtin } });
      if (!row) throw new NotFoundException(`未登记的箱码 GTIN：${cartonGtin}`);
      material = await this.materials.findOne({ where: { tenantId, id: row.materialId } });
      if (!material) throw new NotFoundException(`箱码 ${cartonGtin} 对应物料已删除`);
    } else {
      throw new BadRequestException('skuCode 与 gtin 至少传一个');
    }

    // 箱规：优先 dto.packQty；否则按 gtin 定位；否则要求物料只有一档 CARTON
    let packQty = Number(dto.packQty);
    const packRows = await this.gtins.find({
      where: { tenantId, materialId: material.id, packLevel: dto.packLevel ?? 'CARTON' },
      order: { packQty: 'ASC' },
    });

    if (cartonGtin) {
      const hit = packRows.find((r) => r.gtin === cartonGtin);
      if (!hit) throw new BadRequestException(`箱码 ${cartonGtin} 不是该物料的「${dto.packLevel ?? 'CARTON'}」条码`);
      if (!(packQty > 0)) packQty = Number(hit.packQty);
      else if (Math.abs(Number(hit.packQty) - packQty) > 1e-6) {
        throw new BadRequestException(`packQty=${packQty} 与箱码 ${cartonGtin} 登记的 ${hit.packQty} 不一致`);
      }
    } else if (!(packQty > 0)) {
      if (packRows.length === 0) {
        throw new BadRequestException(`物料 ${material.code} 没有登记「${dto.packLevel ?? 'CARTON'}」条码，请先配包规（GTIN|CARTON|每箱件数）或直接传 packQty`);
      }
      if (packRows.length > 1) {
        const opts = packRows.map((r) => `${r.gtin}=${r.packQty}`).join('、');
        throw new BadRequestException(`物料 ${material.code} 有多档箱规（${opts}），请用 gtin 或 packQty 指定其中一档`);
      }
      packQty = Number(packRows[0].packQty);
      cartonGtin = packRows[0].gtin;
    }
    if (!(packQty > 0)) throw new BadRequestException('每箱件数必须为正数');

    // dto 直接给了 packQty：若该物料刚好有一条同件数的 CARTON 码，回填箱码 GTIN（多条则不猜）
    if (!cartonGtin) {
      const same = packRows.filter((r) => Math.abs(Number(r.packQty) - packQty) < 1e-6);
      if (same.length === 1) cartonGtin = same[0].gtin;
    }

    return {
      material,
      skuCode: material.code,
      productName: material.name,
      unit: material.unit,
      cartonGtin,
      packQty,
    };
  }

  /** SSCC 序列（PG 序列，全局唯一；DDL 见 wms_p10_carton_label.sql） */
  private async nextSerial(): Promise<number> {
    const rows: Array<{ v: string }> = await this.packages.manager.query("select nextval('sscc_serial_seq') as v");
    return Number(rows[0]?.v);
  }

  /** 逐箱打箱标；单箱失败不阻塞其它箱 */
  private async printBoxes(
    resolved: { skuCode: string; productName: string; unit: string; cartonGtin: string | null },
    plan: ReturnType<typeof planBoxes>,
    boxes: Array<{ sscc: string; qty: number; tail: boolean; boxNo: number }>,
    dto: PackDto,
  ) {
    const templateCode = dto.templateCode || 'CARTON_LABEL_V1';
    const printerRoute = dto.printerRoute || 'carton-station';
    const errors: Array<{ sscc: string; error: string }> = [];
    const warnings: string[] = [];
    const perBox: Array<{ sscc: string; jobId: any; status: string; message?: string }> = [];

    for (const b of boxes) {
      try {
        const res = await this.printGateway.createJob({
          templateCode,
          printerRoute,
          idempotencyKey: `CARTON:${b.sscc}`,
          source: 'wms.carton.pack',
          copies: Math.max(1, Math.min(10, Number(dto.copies) || 1)),
          variables: {
            gtin: resolved.cartonGtin ?? '',
            sscc: b.sscc,
            qty: b.qty,
            packQty: plan.packQty,
            unit: resolved.unit,
            batchNo: dto.batchNo ?? '',
            productName: resolved.productName,
            skuCode: resolved.skuCode,
            boxNo: b.boxNo,
            boxTotal: boxes.length,
            tailText: b.tail ? '尾箱' : '',
          },
        });
        perBox.push({ sscc: b.sscc, jobId: res.jobId, status: res.status, message: res.message });
        if (res.status === 'skipped_no_printer') {
          warnings.push(`第 ${b.boxNo} 箱：${res.message ?? '未绑定打印机，箱标未下发'}`);
        }
      } catch (e: any) {
        errors.push({ sscc: b.sscc, error: e?.message ?? String(e) });
        this.logger.warn(`箱标打印失败 sscc=${b.sscc}：${e?.message ?? e}`);
      }
    }
    return { ok: errors.length === 0, errors, warnings, perBox };
  }
}
