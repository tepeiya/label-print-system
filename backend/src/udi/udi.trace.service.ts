// =============================================================================
// UdiTraceService —— UDI 追溯业务层（UDI 里程碑 U2）
//
// 【职责】UDI 单元建档/打标回写/收货发料出库事件的落库与追溯查询、留痕报表与 CSV 导出。
// 【边界】不改库存（库存变更仍由 WMS 走 InventoryGateway），本层只维护"码—包装—事件流"。
// 【幂等】单位建档以 (tenantId, udiKey) 唯一；事件以 (tenantId, idemKey) 唯一，重复提交直接回放。
// 【租户】Controller 已挂 TenantGuard + TenantContextInterceptor，这里再用 useTenantId() 兜底过滤。
// =============================================================================
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { UdiUnit, UdiPackage, UdiEvent } from './entities/udi.entity';
import { parseUdi, normalizeGtin, formatGs1Date } from './udi.calc';
import { AuditService } from '../audit/audit.module';
import { useTenant, useTenantId } from '../common/tenant.context';
import {
  gs1DateToIso, nextStatus, validateSscc, ancestorsOf, descendantsOf,
  summarizePrintAudit, toCsv, reportFileName, UDI_STATUS,
} from './udi.trace.calc';
import {
  udiKeyFromCode, receiveIdemKey, issueIdemKey,
  checkUnitForReceive, checkUnitForIssue, receiveDetail, issueDetail,
} from './udi.link.calc';

export interface UnitRegisterRow {
  /** 已编码的扫码内容（HRI 或元素串）；给了就以它为准解析 */
  code?: string;
  gtin?: string;
  lot?: string;
  serial?: string;
  expiry?: string;
  production?: string;
  packageSscc?: string;
  workOrderNo?: string;
  templateCode?: string;
}

export interface UnitRegisterResult {
  total: number;
  created: number;
  existed: number;
  failed: number;
  errors: Array<{ index: number; message: string }>;
  units: Array<{ id: number; udiKey: string; status: string }>;
}

export interface EventInput {
  /** 三选一：udiKey / 扫码内容 / 包装 SSCC */
  udiKey?: string;
  code?: string;
  sscc?: string;
  eventType: string;
  refType?: string;
  refNo?: string;
  idemKey?: string;
  detail?: Record<string, any>;
  occurredAt?: string;
}

@Injectable()
export class UdiTraceService {
  private logger = new Logger('UdiTraceService');

  constructor(
    @InjectRepository(UdiUnit) private units: Repository<UdiUnit>,
    @InjectRepository(UdiPackage) private packages: Repository<UdiPackage>,
    @InjectRepository(UdiEvent) private events: Repository<UdiEvent>,
    private audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- 单元建档
  /** 批量建档（部分成功）：打印作业派码后调用；同一 udiKey 重复提交按"已存在"返回 */
  async registerUnits(rows: UnitRegisterRow[], opts: { templateCode?: string; workOrderNo?: string } = {}): Promise<UnitRegisterResult> {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    const result: UnitRegisterResult = { total: rows.length, created: 0, existed: 0, failed: 0, errors: [], units: [] };
    if (!rows.length) return result;
    if (rows.length > 5000) throw new BadRequestException('单次建档上限 5000 行');

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const norm = this.normalizeRow(row, { templateCode: opts.templateCode, workOrderNo: opts.workOrderNo });
        const existing = await this.units.findOne({ where: { tenantId, udiKey: norm.udiKey } });
        if (existing) {
          result.existed += 1;
          result.units.push({ id: existing.id, udiKey: existing.udiKey, status: existing.status });
          continue;
        }
        let packageId: number | null = null;
        if (norm.packageSscc) {
          const pkg = await this.packages.findOne({ where: { tenantId, sscc: norm.packageSscc } });
          if (!pkg) throw new BadRequestException(`包装 SSCC ${norm.packageSscc} 不存在，请先建包装`);
          packageId = pkg.id;
        }
        const saved = await this.units.save(this.units.create({
          tenantId,
          udiKey: norm.udiKey,
          gtin: norm.gtin14,
          lot: norm.lot,
          serial: norm.serial,
          expiryDate: norm.expiryDate,
          productionDate: norm.productionDate,
          status: 'REGISTERED',
          packageId,
          packageSscc: norm.packageSscc,
          workOrderNo: norm.workOrderNo,
          templateCode: norm.templateCode,
          createdBy: userId ?? null,
        }));
        await this.events.save(this.events.create({
          tenantId, unitId: saved.id, udiKey: saved.udiKey, eventType: 'BUILD',
          statusBefore: null, statusAfter: 'REGISTERED', refType: 'MANUAL',
          refNo: norm.workOrderNo, occurredAt: new Date(), actorId: userId ?? null,
          detail: { source: 'register', templateCode: norm.templateCode },
        }));
        result.created += 1;
        result.units.push({ id: saved.id, udiKey: saved.udiKey, status: saved.status });
      } catch (e: any) {
        result.failed += 1;
        result.errors.push({ index: i, message: e?.message ?? String(e) });
      }
    }

    void this.audit.write(tenantId, 'udi.units.register', {
      total: result.total, created: result.created, existed: result.existed, failed: result.failed,
    }, undefined, 'udi_unit');
    return result;
  }

  private normalizeRow(row: UnitRegisterRow, fallback: { templateCode?: string; workOrderNo?: string }) {
    if (row.code) {
      const p = parseUdi(row.code);
      if (!p.ok || !p.udi.gtin) throw new BadRequestException(`码解析失败：${p.errors.join('；')}`);
      const gtin = normalizeGtin(p.udi.gtin);
      if (gtin.errors.length) throw new BadRequestException(gtin.errors.join('；'));
      const lot = p.udi.lot ?? '';
      const serial = p.udi.serial ?? '';
      const expiry = p.udi.expiry ?? '';            // 6 位 YYMMDD：与 encode 的 unitKey 口径一致
      return {
        udiKey: [gtin.gtin14, lot, serial, expiry].join('|'),
        gtin14: gtin.gtin14, lot: lot || null, serial: serial || null,
        expiryDate: gs1DateToIso(expiry), productionDate: gs1DateToIso(p.udi.production),
        packageSscc: row.packageSscc ?? null,
        workOrderNo: row.workOrderNo ?? fallback.workOrderNo ?? null,
        templateCode: row.templateCode ?? fallback.templateCode ?? null,
      };
    }
    if (!row.gtin) throw new BadRequestException('缺少 gtin（或提供已编码的 code）');
    const gtin = normalizeGtin(row.gtin);
    if (gtin.errors.length || !gtin.checkDigitOk) {
      throw new BadRequestException(gtin.errors.join('；') || 'GTIN 校验位错误');
    }
    const lot = String(row.lot ?? '');
    const serial = String(row.serial ?? '');
    if (!lot && !serial) throw new BadRequestException('批号与序列号至少填一个（UDI 单品需可唯一识别）');
    // 有效期统一转 GS1 6 位（入参允许 YYYY-MM-DD / YYYY-MM / YYMMDD），保证与 encode 的 unitKey 可对齐
    const eff = row.expiry ? formatGs1Date(String(row.expiry)) : { value: null, errors: [] as string[] };
    if (row.expiry && !eff.value) throw new BadRequestException(`有效期格式错误：${eff.errors.join('；')}`);
    const prod = row.production ? formatGs1Date(String(row.production)) : { value: null, errors: [] as string[] };
    if (row.production && !prod.value) throw new BadRequestException(`生产日期格式错误：${prod.errors.join('；')}`);
    const expiry = eff.value ?? '';
    return {
      udiKey: [gtin.gtin14, lot, serial, expiry].join('|'),
      gtin14: gtin.gtin14, lot: lot || null, serial: serial || null,
      expiryDate: gs1DateToIso(expiry), productionDate: gs1DateToIso(prod.value),
      packageSscc: row.packageSscc ?? null,
      workOrderNo: row.workOrderNo ?? fallback.workOrderNo ?? null,
      templateCode: row.templateCode ?? fallback.templateCode ?? null,
    };
  }

  // ---------------------------------------------------------------- 包装层级
  /** 建/改包装（SSCC 18 位校验；可挂父包装，构成 单元→中包→托盘） */
  async upsertPackages(rows: Array<{ sscc: string; level?: string; gtin?: string; qty?: number; parentSscc?: string; workOrderNo?: string }>) {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    if (!rows.length) throw new BadRequestException('rows 不能为空');
    if (rows.length > 2000) throw new BadRequestException('单次上限 2000 个包装');
    const out: Array<{ id: number; sscc: string; level: string; created: boolean }> = [];

    for (const r of rows) {
      const v = validateSscc(r.sscc);
      if (!v.ok) throw new BadRequestException(`${r.sscc}：${v.reason}`);
      if (r.parentSscc) {
        const pv = validateSscc(r.parentSscc);
        if (!pv.ok) throw new BadRequestException(`父包装 ${r.parentSscc}：${pv.reason}`);
        if (pv.normalized === v.normalized) throw new BadRequestException('包装不能以自身为父');
        const parent = await this.packages.findOne({ where: { tenantId, sscc: pv.normalized } });
        if (!parent) throw new NotFoundException(`父包装 ${pv.normalized} 不存在`);
      }
      const existing = await this.packages.findOne({ where: { tenantId, sscc: v.normalized } });
      if (existing) {
        existing.parentSscc = r.parentSscc ? validateSscc(r.parentSscc).normalized : existing.parentSscc;
        if (r.level) existing.level = r.level;
        if (r.qty !== undefined) existing.qty = String(r.qty);
        await this.packages.save(existing);
        out.push({ id: existing.id, sscc: existing.sscc, level: existing.level, created: false });
      } else {
        const saved = await this.packages.save(this.packages.create({
          tenantId, sscc: v.normalized, level: r.level ?? 'CARTON',
          gtin: r.gtin ?? null, qty: String(r.qty ?? 0),
          parentSscc: r.parentSscc ? validateSscc(r.parentSscc).normalized : null,
          workOrderNo: r.workOrderNo ?? null, createdBy: userId ?? null,
        }));
        out.push({ id: saved.id, sscc: saved.sscc, level: saved.level, created: true });
      }
    }
    void this.audit.write(tenantId, 'udi.packages.upsert', { count: out.length }, undefined, 'udi_package');
    return { count: out.length, items: out };
  }

  // ---------------------------------------------------------------- 事件
  /**
   * 记录追溯事件：状态机校验 → 更新单元状态 → 落事件（幂等键冲突直接回放）。
   * 打印失败（PRINT_FAIL）不阻塞，只记失败留痕，供合规报表统计。
   */
  async recordEvent(input: EventInput) {
    const tenantId = useTenantId();
    const { userId } = useTenant();
    if (!input.eventType) throw new BadRequestException('eventType 必填');

    if (input.idemKey) {
      const dup = await this.events.findOne({ where: { tenantId, idemKey: input.idemKey } });
      if (dup) return { idempotent: true, eventId: dup.id, status: dup.statusAfter, event: dup };
    }

    let unit: UdiUnit | null = null;
    let udiKey: string | null = input.udiKey ?? null;

    if (input.code) {
      const p = parseUdi(input.code);
      if (!p.ok || !p.udi.gtin) throw new BadRequestException(`码解析失败：${p.errors.join('；')}`);
      const gtin = normalizeGtin(p.udi.gtin).gtin14;
      udiKey = [gtin, p.udi.lot ?? '', p.udi.serial ?? '', p.udi.expiry ?? ''].join('|');
    }
    if (udiKey) {
      unit = await this.units.findOne({ where: { tenantId, udiKey } });
      if (!unit) throw new NotFoundException(`UDI 单元不存在：${udiKey}（请先建档）`);
    }

    const pkgSscc = input.sscc ?? unit?.packageSscc ?? null;
    const cur = unit?.status ?? 'REGISTERED';
    const tr = nextStatus(cur, input.eventType);
    if (!tr.ok) throw new ConflictException(tr.reason ?? '状态不允许该事件');

    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const detail = { ...(input.detail ?? {}), sscc: pkgSscc ?? undefined };

    if (unit) {
      unit.status = tr.status;
      if (input.eventType === 'PRINT' || input.eventType === 'PRINT_FAIL') unit.printedAt = input.eventType === 'PRINT' ? occurredAt : unit.printedAt;
      await this.units.save(unit);
    }

    const ev = await this.events.save(this.events.create({
      tenantId, unitId: unit?.id ?? null, udiKey: unit?.udiKey ?? udiKey,
      packageSscc: pkgSscc, eventType: input.eventType,
      statusBefore: unit ? cur : null, statusAfter: tr.status,
      refType: input.refType ?? 'MANUAL', refNo: input.refNo ?? null,
      idemKey: input.idemKey ?? null, detail, actorId: userId ?? null, occurredAt,
    }));

    void this.audit.write(tenantId, 'udi.event.record', {
      eventType: input.eventType, udiKey: unit?.udiKey ?? null, sscc: pkgSscc,
      statusBefore: cur, statusAfter: tr.status, refNo: input.refNo ?? null,
    }, undefined, 'udi_event', ev.id);

    return { idempotent: false, eventId: ev.id, status: tr.status, event: ev };
  }

  // ---------------------------------------------------------------- WMS 联动（U5）
  /**
   * 收货扫码联动：扫码 → 建档（幂等）→ 记 RECEIVE 事件。
   * 同一收货单 + 同一单元重复扫 → 事件键幂等回放，status 不变。
   * 单元已在他单收货/已发料 → 409（避免一码多收）。
   */
  async receiveByScan(input: { code: string; receiptNo: string; lineNo?: number; skuCode?: string; qty?: number }) {
    const tenantId = useTenantId();
    const parsed = udiKeyFromCode(input.code);
    if (!parsed.ok) throw new BadRequestException(`UDI 码解析失败：${parsed.errors.join('；')}`);
    if (!input.receiptNo) throw new BadRequestException('缺少收货单号，无法记 RECEIVE 事件');

    // 建档幂等：已存在直接返回 existed
    const reg = await this.registerUnits([{ code: input.code }]);
    const unit = await this.units.findOne({ where: { tenantId, udiKey: parsed.udiKey! } });
    if (!unit) {
      throw new BadRequestException(reg.errors[0]?.message ?? 'UDI 单元建档失败');
    }

    const idemKey = receiveIdemKey(input.receiptNo, parsed.udiKey!);
    const dup = await this.events.findOne({ where: { tenantId, idemKey } });
    if (dup) {
      return { udiKey: unit.udiKey, gtin: unit.gtin, lot: unit.lot, serial: unit.serial, status: dup.statusAfter, eventId: dup.id, idempotent: true, created: false };
    }

    const guard = checkUnitForReceive(unit.status);
    if (!guard.ok) throw new ConflictException(guard.reason!);

    const ev = await this.recordEvent({
      code: input.code, eventType: 'RECEIVE', refType: 'wms_receipt', refNo: input.receiptNo,
      idemKey, detail: receiveDetail(input),
    });
    void this.audit.write(tenantId, 'udi.link.receive', {
      receiptNo: input.receiptNo, udiKey: unit.udiKey, gtin: unit.gtin, lineNo: input.lineNo ?? null,
    }, undefined, 'udi_unit', unit.id);
    return {
      udiKey: unit.udiKey, gtin: unit.gtin, lot: unit.lot, serial: unit.serial,
      status: ev.status, eventId: ev.eventId, idempotent: ev.idempotent, created: reg.created > 0,
    };
  }

  /**
   * 发料扫码联动：只对已收货（RECEIVED）单元记 ISSUE，必须已建档。
   * 同一工单 + 行 + 单元重复提交 → 幂等回放（与发料记录重跑幂等同一语义）。
   */
  async issueByScan(input: { code: string; woNo: string; lineNo: number | string; materialCode?: string; qty?: number }) {
    const tenantId = useTenantId();
    const parsed = udiKeyFromCode(input.code);
    if (!parsed.ok) throw new BadRequestException(`UDI 码解析失败：${parsed.errors.join('；')}`);
    if (!input.woNo) throw new BadRequestException('缺少工单号，无法记 ISSUE 事件');

    const unit = await this.units.findOne({ where: { tenantId, udiKey: parsed.udiKey! } });
    if (!unit) throw new NotFoundException(`UDI 单元未建档：${parsed.udiKey}（请先收货建档）`);

    const idemKey = issueIdemKey(input.woNo, input.lineNo, parsed.udiKey!);
    const dup = await this.events.findOne({ where: { tenantId, idemKey } });
    if (dup) {
      return { udiKey: unit.udiKey, gtin: unit.gtin, lot: unit.lot, serial: unit.serial, status: dup.statusAfter, eventId: dup.id, idempotent: true };
    }

    const guard = checkUnitForIssue(unit.status);
    if (!guard.ok) throw new ConflictException(guard.reason!);

    const ev = await this.recordEvent({
      code: input.code, eventType: 'ISSUE', refType: 'wms_work_order', refNo: input.woNo,
      idemKey, detail: issueDetail(input),
    });
    void this.audit.write(tenantId, 'udi.link.issue', {
      woNo: input.woNo, udiKey: unit.udiKey, gtin: unit.gtin, lineNo: input.lineNo,
    }, undefined, 'udi_unit', unit.id);
    return {
      udiKey: unit.udiKey, gtin: unit.gtin, lot: unit.lot, serial: unit.serial,
      status: ev.status, eventId: ev.eventId, idempotent: ev.idempotent,
    };
  }

  // ---------------------------------------------------------------- 追溯查询
  /** 扫任意一个码（单品 UDI / SSCC / udiKey）→ 正反向追溯 */
  async trace(code: string) {
    const tenantId = useTenantId();
    const raw = String(code ?? '').trim();
    if (!raw) throw new BadRequestException('code 不能为空');

    let unit: UdiUnit | null = null;
    let sscc: string | null = null;

    if (raw.includes('|')) {
      // 直接给单品键（管理端/接口互调用）
      unit = await this.units.findOne({ where: { tenantId, udiKey: raw } });
    } else if (/^\d{18}$/.test(raw) && validateSscc(raw).ok) {
      sscc = raw;
    } else {
      const p = parseUdi(raw);
      if (p.ok && p.udi.gtin) {
        const gtin = normalizeGtin(p.udi.gtin).gtin14;
        const key = [gtin, p.udi.lot ?? '', p.udi.serial ?? '', p.udi.expiry ?? ''].join('|');
        unit = await this.units.findOne({ where: { tenantId, udiKey: key } });
      }
      if (!unit) throw new NotFoundException('该 UDI 码未建档，请先扫码收货/建档');
    }

    if (!unit && !sscc) throw new NotFoundException('未找到追溯对象');

    // 事件时间线：正向（码的生产/打印/入库）+ 反向（发料/出库）
    const whereUnit: any = unit ? { tenantId, unitId: unit.id } : null;
    const whereSscc: any = sscc ? [{ tenantId, packageSscc: sscc }] : [];
    const timeline = unit
      ? await this.events.find({ where: whereUnit, order: { occurredAt: 'ASC' }, take: 500 })
      : await this.events.find({ where: whereSscc, order: { occurredAt: 'ASC' }, take: 500 });

    // 包装层级（正反向都能看：单元挂在哪层中包/托盘，以及同包下还有哪些单元）
    let hierarchy: any = null;
    let packageInfo: UdiPackage | null = null;
    const anchorSscc = sscc ?? unit?.packageSscc ?? null;
    if (anchorSscc) {
      packageInfo = await this.packages.findOne({ where: { tenantId, sscc: anchorSscc } });
      if (packageInfo) {
        const all = await this.packages.find({ where: { tenantId }, order: { createdAt: 'ASC' }, take: 5000 });
        const parentMap = new Map<string, string | null>();
        for (const p of all) parentMap.set(p.sscc, p.parentSscc ?? null);
        // 无论从单品还是从包装进来，都查"这个包装下有哪些单元"（正反向追溯的关键）
        const siblings = await this.units.find({ where: { tenantId, packageSscc: anchorSscc }, take: 2000 });
        hierarchy = {
          current: packageInfo,
          path: ancestorsOf(anchorSscc, parentMap),
          children: descendantsOf(anchorSscc, all.map((p) => ({ sscc: p.sscc, level: p.level, parentSscc: p.parentSscc, qty: Number(p.qty) }))),
          unitsInPackage: siblings.map((u) => ({ udiKey: u.udiKey, serial: u.serial, lot: u.lot, status: u.status })),
        };
      }
    }

    const reversed = unit ? await this.reverseRefs(tenantId, unit) : null;

    void this.audit.write(tenantId, 'udi.trace.query', { code: raw.slice(0, 80), found: unit ? 'unit' : 'package' }, undefined, 'udi_unit', unit?.id);

    return {
      found: unit ? 'unit' : 'package',
      unit: unit ? this.unitView(unit) : null,
      package: packageInfo ? { ...packageInfo, qty: Number(packageInfo.qty) } : null,
      timeline: timeline.map((e) => ({
        id: e.id, eventType: e.eventType, statusBefore: e.statusBefore, statusAfter: e.statusAfter,
        refType: e.refType, refNo: e.refNo, occurredAt: e.occurredAt, detail: e.detail,
      })),
      hierarchy,
      reverse: reversed,
    };
  }

  /** 反向：该单元被哪些单据引用（发料/出库/退料） → 便于飞检时回答"这批用到哪台机器" */
  private async reverseRefs(tenantId: number, unit: UdiUnit) {
    const rows = await this.events.find({
      where: { tenantId, unitId: unit.id },
      order: { occurredAt: 'DESC' }, take: 200,
    });
    const issued = rows.filter((r) => ['ISSUE', 'SHIP', 'RETURN'].includes(r.eventType));
    const byRef = issued
      .filter((r) => r.refNo)
      .map((r) => ({ refType: r.refType, refNo: r.refNo, eventType: r.eventType, occurredAt: r.occurredAt }));
    return { issuedCount: issued.filter((r) => r.eventType === 'ISSUE').length, shippedCount: issued.filter((r) => r.eventType === 'SHIP').length, refs: byRef };
  }

  private unitView(u: UdiUnit) {
    return {
      id: u.id, udiKey: u.udiKey, gtin: u.gtin, lot: u.lot, serial: u.serial,
      expiry: u.expiryDate, production: u.productionDate, status: u.status,
      packageSscc: u.packageSscc, workOrderNo: u.workOrderNo, templateCode: u.templateCode,
      printedAt: u.printedAt, createdAt: u.createdAt,
    };
  }

  /** 单元列表（分页 + 常用过滤） */
  async listUnits(q: {
    status?: string; gtin?: string; lot?: string; workOrderNo?: string;
    since?: string; until?: string; page?: number; pageSize?: number;
  }) {
    const tenantId = useTenantId();
    const where: any = { tenantId };
    if (q.status) where.status = q.status;
    if (q.gtin) where.gtin = normalizeGtin(q.gtin).gtin14;
    if (q.lot) where.lot = q.lot;
    if (q.workOrderNo) where.workOrderNo = q.workOrderNo;
    if (q.since && q.until) where.createdAt = Between(new Date(q.since), new Date(q.until));
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(1000, Math.max(1, Number(q.pageSize ?? 100)));
    const [rows, total] = await this.units.findAndCount({
      where, order: { createdAt: 'DESC' }, skip: (page - 1) * pageSize, take: pageSize,
    });
    return { total, page, pageSize, items: rows.map((u) => this.unitView(u)) };
  }

  async packageDetail(sscc: string) {
    const tenantId = useTenantId();
    const pkg = await this.packages.findOne({ where: { tenantId, sscc } });
    if (!pkg) throw new NotFoundException(`包装不存在：${sscc}`);
    const all = await this.packages.find({ where: { tenantId }, take: 5000 });
    const parentMap = new Map<string, string | null>();
    for (const p of all) parentMap.set(p.sscc, p.parentSscc ?? null);
    const units = await this.units.find({ where: { tenantId, packageSscc: sscc }, take: 2000 });
    return {
      package: { ...pkg, qty: Number(pkg.qty) },
      path: ancestorsOf(sscc, parentMap),
      children: descendantsOf(sscc, all.map((p) => ({ sscc: p.sscc, level: p.level, parentSscc: p.parentSscc }))),
      units: units.map((u) => this.unitView(u)),
      events: await this.events.find({ where: { tenantId, packageSscc: sscc }, order: { occurredAt: 'ASC' }, take: 500 }),
    };
  }

  // ---------------------------------------------------------------- 合规留痕报表
  /** 打印留痕报表：按天/按模板统计成功与失败；数据源=udi_events（PRINT/PRINT_FAIL） */
  async printAudit(q: { since?: string; until?: string; templateCode?: string }) {
    const tenantId = useTenantId();
    const rows = await this.events.find({
      where: { tenantId, eventType: 'PRINT' as any },
      order: { occurredAt: 'ASC' }, take: 20000,
    });
    const failed = await this.events.find({
      where: { tenantId, eventType: 'PRINT_FAIL' as any },
      order: { occurredAt: 'ASC' }, take: 20000,
    });
    const merged = [...rows, ...failed]
      .filter((e) => (!q.since || e.occurredAt >= new Date(q.since)) && (!q.until || e.occurredAt <= new Date(q.until)))
      .filter((e) => !q.templateCode || (e.detail as any)?.templateCode === q.templateCode);

    const day = (d: Date) => new Date(d).toISOString().slice(0, 10);
    const summary = summarizePrintAudit(merged.map((e) => ({
      eventType: e.eventType, day: day(e.occurredAt), unitKey: e.udiKey,
      templateCode: (e.detail as any)?.templateCode ?? null,
    })));
    return { since: q.since ?? null, until: q.until ?? null, totalEvents: merged.length, ...summary };
  }

  /** 单元导出台账 CSV（含 DI/PI 与状态，供飞检/客户审核留档） */
  async exportUnitsCsv(q: { since?: string; until?: string; status?: string; gtin?: string; limit?: number }) {
    const tenantId = useTenantId();
    const where: any = { tenantId };
    if (q.status) where.status = q.status;
    if (q.gtin) where.gtin = normalizeGtin(q.gtin).gtin14;
    const range = this.range(q.since, q.until);
    if (range) where.createdAt = range;
    const rows = await this.units.find({ where, order: { createdAt: 'DESC' }, take: Math.min(20000, Number(q.limit ?? 5000)) });

    const columns = [
      { key: 'udiKey', title: '单品键' },
      { key: 'gtin', title: 'GTIN(DI)' },
      { key: 'lot', title: '批号' },
      { key: 'serial', title: '序列号' },
      { key: 'expiry', title: '有效期' },
      { key: 'production', title: '生产日期' },
      { key: 'status', title: '状态' },
      { key: 'packageSscc', title: '包装SSCC' },
      { key: 'workOrderNo', title: '工单号' },
      { key: 'templateCode', title: '模板' },
      { key: 'printedAt', title: '打印时间' },
      { key: 'createdAt', title: '建档时间' },
    ];
    const csv = toCsv(columns, rows.map((u) => ({
      udiKey: u.udiKey, gtin: u.gtin, lot: u.lot, serial: u.serial,
      expiry: u.expiryDate, production: u.productionDate, status: u.status,
      packageSscc: u.packageSscc, workOrderNo: u.workOrderNo, templateCode: u.templateCode,
      printedAt: u.printedAt ? new Date(u.printedAt).toISOString() : '',
      createdAt: new Date(u.createdAt).toISOString(),
    })));

    void this.audit.write(tenantId, 'udi.export.units', { rows: rows.length, since: q.since, until: q.until });
    return { csv, rows: rows.length, fileName: reportFileName('udi-units', q.since, q.until) };
  }

  /** 留痕报表 CSV：按天汇总 + 按模板汇总两个段，方便直接给审核员 */
  async exportPrintAuditCsv(q: { since?: string; until?: string; templateCode?: string }) {
    const r = await this.printAudit(q);
    const head = toCsv([{ key: 'day', title: '日期' }, { key: 'printed', title: '打印成功' }, { key: 'failed', title: '打印失败' }, { key: 'units', title: '涉及单元数' }], r.byDay);
    const tpl = toCsv([{ key: 'templateCode', title: '模板' }, { key: 'printed', title: '打印成功' }, { key: 'failed', title: '打印失败' }], r.byTemplate);
    const totals = `合计,${r.totals.printed},${r.totals.failed},${r.totals.units}\r\n`;
    return { csv: `${head}\r\n${totals}\r\n${tpl}`, totals: r.totals, fileName: reportFileName('udi-print-audit', q.since, q.until) };
  }

  private range(since?: string, until?: string) {
    if (!since && !until) return null;
    const min = since ? new Date(since) : new Date('1970-01-01');
    const max = until ? new Date(until) : new Date('2999-12-31');
    return Between(min, max);
  }

  /** 能力自述（给前端/实施做探活） */
  status() {
    return {
      module: 'udi.trace',
      statuses: UDI_STATUS,
      endpoints: [
        'POST /udi/units/register', 'POST /udi/units/events', 'GET /udi/units',
        'GET /udi/trace/:code', 'POST /udi/packages', 'GET /udi/packages/:sscc',
        'GET /udi/report/print-audit', 'GET /udi/export/units.csv', 'GET /udi/export/print-audit.csv',
      ],
      caveat: '真库集成验证需在具备 PostgreSQL 的环境执行 backend/test/integration/udi.trace.int.test.ts',
    };
  }
}
