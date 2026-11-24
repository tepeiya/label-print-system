// =============================================================================
// UdiComplianceService —— UDI 合规闭环：DI 台账 / 提交前校验 / 召回范围 / 申报
//
// 与 udi.trace.service 的分工：
//   · trace.service 管"单品/包装/事件的流水"（打印、收货、发料、追溯、报表）
//   · 本服务管"台账与申报"（DI 主数据、规则校验、召回影响面、提交通道）
// 两者共用 udi_units / udi_packages / udi_events，不另建流水表。
// =============================================================================
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UdiDiMaster, UdiSubmission, UdiUnit, UdiPackage, UdiEvent } from './entities/udi.entity';
import { normalizeGtin } from './udi.calc';
import { NmpaUdidClient } from './udi.nmpa.client';

const LEVEL_ORDER: Record<string, number> = { UNIT: 0, CARTON: 1, PALLET: 2 };
const CHANNELS = ['NMPA', 'EUDAMED', 'GUDID', 'FILE'] as const;
const MODES = ['validate', 'file', 'api'] as const;

export interface DiInput {
  di: string;
  name: string;
  spec?: string;
  model?: string;
  registrationNo?: string;
  catalogCode?: string;
  gmdn?: string;
  emdn?: string;
  issuingAgency?: string;
  isSterile?: boolean;
  isSingleUse?: boolean;
  packageLevel?: string;
  qtyInPackage?: number | string;
  parentDi?: string;
  status?: string;
  remark?: string;
}

export interface ValidationIssue {
  di: string;
  field: string;
  message: string;
  level: 'error' | 'warn';
}

@Injectable()
export class UdiComplianceService {
  constructor(
    @InjectRepository(UdiDiMaster) private diRepo: Repository<UdiDiMaster>,
    @InjectRepository(UdiSubmission) private subRepo: Repository<UdiSubmission>,
    @InjectRepository(UdiUnit) private unitRepo: Repository<UdiUnit>,
    @InjectRepository(UdiPackage) private pkgRepo: Repository<UdiPackage>,
    @InjectRepository(UdiEvent) private eventRepo: Repository<UdiEvent>,
    private nmpa: NmpaUdidClient,
  ) {}

  // ------------------------------------------------------------------ DI 台账

  async listDi(tenantId: number, q: { packageLevel?: string; status?: string; keyword?: string } = {}) {
    const where: any = { tenantId };
    if (q.packageLevel) where.packageLevel = q.packageLevel;
    if (q.status) where.status = q.status;
    const rows = await this.diRepo.find({
      where,
      order: { packageLevel: 'ASC', di: 'ASC' },
      take: 500,
    });
    const kw = (q.keyword ?? '').trim().toLowerCase();
    const filtered = kw
      ? rows.filter((r) => [r.di, r.name, r.spec, r.model, r.registrationNo]
        .some((v) => String(v ?? '').toLowerCase().includes(kw)))
      : rows;
    return { total: filtered.length, items: filtered };
  }

  /** 增量写入（按 di upsert，便于 Excel/接口反复同步） */
  async saveDi(tenantId: number, actorId: number | null, rows: DiInput[]) {
    if (!Array.isArray(rows) || !rows.length) throw new BadRequestException('rows 不能为空');
    const saved: Array<{ di: string; action: 'created' | 'updated' }> = [];
    const rejected: Array<{ di: string; message: string }> = [];
    for (const raw of rows) {
      const norm = normalizeGtin(String(raw?.di ?? ''));
      if (!norm.gtin14 || !norm.checkDigitOk) {
        rejected.push({ di: String(raw?.di ?? ''), message: norm.errors.join('；') || 'GTIN 校验位不通过' });
        continue;
      }
      if (!raw?.name) {
        rejected.push({ di: norm.gtin14, message: '产品名称必填' });
        continue;
      }
      const existing = await this.diRepo.findOne({ where: { tenantId, di: norm.gtin14 } });
      const entity = existing ?? this.diRepo.create({ tenantId, di: norm.gtin14 });
      Object.assign(entity, {
        name: raw.name,
        spec: raw.spec ?? null,
        model: raw.model ?? null,
        registrationNo: raw.registrationNo ?? null,
        catalogCode: raw.catalogCode ?? null,
        gmdn: raw.gmdn ?? null,
        emdn: raw.emdn ?? null,
        issuingAgency: raw.issuingAgency ?? 'GS1',
        isSterile: Boolean(raw.isSterile),
        isSingleUse: Boolean(raw.isSingleUse),
        packageLevel: raw.packageLevel ?? 'UNIT',
        qtyInPackage: raw.qtyInPackage == null ? null : String(raw.qtyInPackage),
        parentDi: raw.parentDi ? normalizeGtin(String(raw.parentDi)).gtin14 || null : null,
        status: raw.status ?? 'active',
        remark: raw.remark ?? null,
      });
      await this.diRepo.save(entity);
      saved.push({ di: norm.gtin14, action: existing ? 'updated' : 'created' });
    }
    return { saved: saved.length, created: saved.filter((s) => s.action === 'created').length, items: saved, rejected };
  }

  async removeDi(tenantId: number, di: string) {
    const g = normalizeGtin(di).gtin14 || di;
    const hit = await this.diRepo.findOne({ where: { tenantId, di: g } });
    if (!hit) throw new NotFoundException(`DI ${g} 不在台账里`);
    const children = await this.diRepo.count({ where: { tenantId, parentDi: g } });
    if (children) throw new BadRequestException(`还有 ${children} 个包装 DI 挂在它下面，先解绑再删`);
    await this.diRepo.delete({ id: hit.id });
    return { di: g, deleted: true };
  }

  /** 包装层级树：PALLET → CARTON → UNIT */
  async diTree(tenantId: number) {
    const rows = await this.diRepo.find({ where: { tenantId }, order: { di: 'ASC' } });
    const byDi = new Map(rows.map((r) => [r.di, r]));
    const roots = rows.filter((r) => !r.parentDi || !byDi.has(r.parentDi));
    const build = (node: UdiDiMaster, depth = 0): any => ({
      di: node.di,
      name: node.name,
      spec: node.spec,
      packageLevel: node.packageLevel,
      qtyInPackage: node.qtyInPackage,
      status: node.status,
      depth,
      children: depth >= 3 ? [] : rows.filter((c) => c.parentDi === node.di).map((c) => build(c, depth + 1)),
    });
    return { total: rows.length, tree: roots.map((r) => build(r)) };
  }

  // ------------------------------------------------------------ 提交前校验

  async validate(tenantId: number, dis: string[]): Promise<{ ok: boolean; checked: number; issues: ValidationIssue[] }> {
    const list = (dis?.length ? dis : (await this.diRepo.find({ where: { tenantId }, take: 2000 })).map((r) => r.di))
      .map((d) => normalizeGtin(String(d)).gtin14 || String(d));
    const rows = list.length ? await this.diRepo.find({ where: { tenantId, di: In(list) } }) : [];
    const byDi = new Map(rows.map((r) => [r.di, r]));
    const issues: ValidationIssue[] = [];

    for (const di of list) {
      const r = byDi.get(di);
      if (!r) { issues.push({ di, field: 'di', message: '台账里没有这个 DI', level: 'error' }); continue; }
      const n = normalizeGtin(r.di);
      if (!n.checkDigitOk) issues.push({ di, field: 'di', message: `GTIN 校验位不对（${n.errors.join('；')}）`, level: 'error' });
      if (!r.name) issues.push({ di, field: 'name', message: '产品名称必填', level: 'error' });
      if (!r.spec && !r.model) issues.push({ di, field: 'spec', message: '规格与型号至少要填一个（注册证口径）', level: 'error' });
      if (!r.registrationNo) issues.push({ di, field: 'registrationNo', message: '注册证号/备案号必填', level: 'error' });
      if (!r.catalogCode) issues.push({ di, field: 'catalogCode', message: '分类目录必填', level: 'error' });
      else if (!/^\d{2}-\d{2}-\d{2}$/.test(r.catalogCode)) {
        issues.push({ di, field: 'catalogCode', message: `分类目录格式应为 XX-XX-XX，现在是 ${r.catalogCode}`, level: 'error' });
      }
      if (!['GS1', 'HIBCC', 'ICCBBA'].includes(r.issuingAgency)) {
        issues.push({ di, field: 'issuingAgency', message: '发码机构只能是 GS1 / HIBCC / ICCBBA', level: 'error' });
      }
      if (r.packageLevel !== 'UNIT' && !r.parentDi) {
        issues.push({ di, field: 'parentDi', message: `${r.packageLevel} 应挂到上级包装 DI 下`, level: 'warn' });
      }
      if (r.parentDi) {
        const parent = byDi.get(r.parentDi);
        if (!parent) issues.push({ di, field: 'parentDi', message: `上级 DI ${r.parentDi} 不在台账里`, level: 'error' });
        else if ((LEVEL_ORDER[parent.packageLevel] ?? 0) <= (LEVEL_ORDER[r.packageLevel] ?? 0)) {
          issues.push({ di, field: 'parentDi', message: `上级 ${parent.di} 的层级(${parent.packageLevel})必须高于当前(${r.packageLevel})`, level: 'error' });
        }
        if (!r.qtyInPackage || Number(r.qtyInPackage) <= 0) {
          issues.push({ di, field: 'qtyInPackage', message: '挂了上级包装就必须填包装内含数量', level: 'error' });
        }
      }
    }
    const errors = issues.filter((i) => i.level === 'error');
    return { ok: errors.length === 0, checked: list.length, issues };
  }

  // ------------------------------------------------------------ 召回范围

  /**
   * 召回影响面：给定 DI / 批号 / 序列号 / 包装 SSCC 中的任意组合，
   * 反查 udi_units + 所在包装 + 下游事件（发料/发运单据），给出"发给谁、多少件"。
   */
  async recallScope(tenantId: number, q: {
    gtin?: string; lot?: string; serial?: string; sscc?: string; since?: string; until?: string; limit?: number;
  }) {
    const where: any = { tenantId };
    if (q.gtin) where.gtin = normalizeGtin(q.gtin).gtin14 || q.gtin;
    if (q.lot) where.lot = q.lot;
    if (q.serial) where.serial = q.serial;
    if (q.sscc) where.packageSscc = q.sscc;
    if (q.since || q.until) {
      where.createdAt = {};
      if (q.since) where.createdAt.gte = new Date(q.since);
      if (q.until) where.createdAt.lte = new Date(q.until);
    }
    if (Object.keys(where).length <= 1) throw new BadRequestException('至少给一个条件：gtin / lot / serial / sscc');

    const units = await this.unitRepo.find({ where, take: Math.min(Number(q.limit ?? 500) || 500, 2000), order: { id: 'DESC' } });
    const unitIds = units.map((u) => u.id);
    const ssccs = Array.from(new Set(units.map((u) => u.packageSscc).filter(Boolean) as string[]));

    const packaging = ssccs.length ? await this.pkgRepo.find({ where: { tenantId, sscc: In(ssccs) } }) : [];
    const events = unitIds.length
      ? await this.eventRepo.find({ where: { tenantId, unitId: In(unitIds) }, order: { occurredAt: 'DESC' }, take: 3000 })
      : [];

    // 下游单据聚合：同一张发料/发运单里命中了多少件
    const downstreamMap = new Map<string, { refType: string | null; refNo: string; units: number; lastAt: string | null }>();
    for (const e of events) {
      // 追溯事件里下游单据的 refType 实际有两套口径（UDI 侧大写下划线、WMS 侧 wms_*），都要认
      const refType = String(e.refType ?? '');
      const isReceipt = refType === 'RECEIPT' || refType === 'wms_receipt';
      const isIssue = refType === 'ISSUE' || refType === 'wms_work_order';
      const isShipment = refType === 'SHIPMENT' || refType === 'wms_shipment';
      if (!(isReceipt || isIssue || isShipment) || !e.refNo) continue;
      const norm = isShipment ? 'SHIPMENT' : (isIssue ? 'ISSUE' : 'RECEIPT');
      const key = `${norm}|${e.refNo}`;
      const hit = downstreamMap.get(key) ?? { refType: norm, refNo: e.refNo, units: 0, lastAt: null };
      hit.units += 1;
      if (!hit.lastAt || String(e.occurredAt) > hit.lastAt) hit.lastAt = new Date(e.occurredAt).toISOString();
      downstreamMap.set(key, hit);
    }

    const statusCount: Record<string, number> = {};
    for (const u of units) statusCount[u.status] = (statusCount[u.status] ?? 0) + 1;

    return {
      query: q,
      summary: {
        units: units.length,
        packages: packaging.length,
        ssccList: ssccs.slice(0, 100),
        shippedRefs: Array.from(downstreamMap.values()).filter((d) => d.refType === 'SHIPMENT').length,
        issuedRefs: Array.from(downstreamMap.values()).filter((d) => d.refType === 'ISSUE').length,
        statusCount,
      },
      downstream: Array.from(downstreamMap.values()).sort((a, b) => b.units - a.units).slice(0, 200),
      units: units.map((u) => ({
        udiKey: u.udiKey, gtin: u.gtin, lot: u.lot, serial: u.serial,
        expiryDate: u.expiryDate, status: u.status, packageSscc: u.packageSscc, workOrderNo: u.workOrderNo,
      })),
      packages: packaging.map((p) => ({ sscc: p.sscc, level: p.level, qty: p.qty, parentSscc: p.parentSscc })),
    };
  }

  /** 召回清单 CSV（给质量部门直接归档） */
  async recallCsv(tenantId: number, q: any): Promise<{ filename: string; content: string }> {
    const scope = await this.recallScope(tenantId, q);
    const lines = [
      'UDI,GTIN,批号,序列号,有效期,状态,包装SSCC,工单,下游单据类型,下游单据号',
    ];
    const refByUnit = new Map<string, string>();
    for (const d of scope.downstream) refByUnit.set(d.refNo, `${d.refType}|${d.refNo}`);
    for (const u of scope.units) {
      lines.push([
        u.udiKey, u.gtin, u.lot ?? '', u.serial ?? '', u.expiryDate ?? '', u.status,
        u.packageSscc ?? '', u.workOrderNo ?? '', '', '',
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return { filename: `udi-recall-${stamp}.csv`, content: lines.join('\n') };
  }

  // ------------------------------------------------------------ 申报提交

  async createSubmission(
    tenantId: number,
    actorId: number | null,
    body: { channel: string; mode?: string; dis?: string[] },
  ) {
    const channel = String(body?.channel ?? '').toUpperCase();
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      throw new BadRequestException(`channel 只能是 ${CHANNELS.join(' / ')}`);
    }
    const mode = String(body?.mode ?? 'validate');
    if (!(MODES as readonly string[]).includes(mode)) {
      throw new BadRequestException(`mode 只能是 ${MODES.join(' / ')}`);
    }
    const dis = (body?.dis ?? []).map((d) => normalizeGtin(String(d)).gtin14 || String(d));
    const check = await this.validate(tenantId, dis);
    const rows = dis.length
      ? await this.diRepo.find({ where: { tenantId, di: In(dis) } })
      : await this.diRepo.find({ where: { tenantId }, take: 2000 });
    const effectiveDis = dis.length ? dis : rows.map((r) => r.di);

    const submission = this.subRepo.create({
      tenantId, channel, mode, dis: effectiveDis,
      issues: check.issues, status: 'draft', createdBy: actorId,
    });

    if (!check.ok && mode !== 'validate') {
      submission.status = 'failed';
      submission.remoteCode = 'LOCAL_VALIDATION';
      submission.remoteMsg = `本地校验未通过：${check.issues.filter((i) => i.level === 'error').length} 条错误`;
      return this.subRepo.save(submission);
    }

    if (mode === 'validate') {
      submission.status = 'validated';
      return this.subRepo.save(submission);
    }

    const payload = this.buildPayload(channel, rows);
    submission.payload = payload;

    if (mode === 'file') {
      submission.status = 'generated';
      return this.subRepo.save(submission);
    }

    // mode=api：只有 NMPA 有公开 REST 接口；其余渠道没有自助 API，直接拒绝，避免假成功
    if (channel !== 'NMPA') {
      submission.status = 'failed';
      submission.remoteCode = 'NO_API';
      submission.remoteMsg = `${channel} 没有开放自助申报接口，请用 file 模式生成文件后上传`;
      return this.subRepo.save(submission);
    }

    const result = await this.nmpa.submitIdentifiers(payload);
    submission.attempts = 1;
    submission.remoteCode = result.code;
    submission.remoteMsg = result.message;
    submission.status = result.ok ? 'submitted' : 'failed';
    if (result.ok) submission.submittedAt = new Date();
    return this.subRepo.save(submission);
  }

  async listSubmissions(tenantId: number, q: { channel?: string; status?: string; limit?: number } = {}) {
    const where: any = { tenantId };
    if (q.channel) where.channel = q.channel.toUpperCase();
    if (q.status) where.status = q.status;
    const [items, total] = await this.subRepo.findAndCount({
      where, order: { id: 'DESC' }, take: Math.min(Number(q.limit ?? 50) || 50, 200),
    });
    return { total, items };
  }

  async submissionDetail(tenantId: number, id: number) {
    const row = await this.subRepo.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException(`提交记录 ${id} 不存在`);
    return row;
  }

  /** NMPA 连通性自检（测试/正式环境可配），不消耗 token */
  async nmpaProbe() {
    return this.nmpa.probe();
  }

  /**
   * 组装各渠道报文。
   * NMPA：按《业务申报API标准文档》的 dataSet 结构，字段名以官方 V3 文档为准（见 docs/18 §5.2）。
   * EUDAMED：UDI-DI 基础数据集 XML。GUDID：HL7 SPL 最小骨架（Device/Identifier）。
   */
  private buildPayload(channel: string, rows: UdiDiMaster[]): Record<string, any> {
    const clean = rows.map((r) => ({
      udi: r.di,
      productName: r.name,
      specification: r.spec ?? '',
      model: r.model ?? '',
      registrationNo: r.registrationNo ?? '',
      catalogCode: r.catalogCode ?? '',
      gmdn: r.gmdn ?? '',
      emdn: r.emdn ?? '',
      issuingAgency: r.issuingAgency,
      isSterile: r.isSterile,
      isSingleUse: r.isSingleUse,
      packageLevel: r.packageLevel,
      qtyInPackage: r.qtyInPackage ? Number(r.qtyInPackage) : null,
      parentUdi: r.parentDi ?? '',
    }));
    if (channel === 'NMPA') return { dataSet: clean };
    if (channel === 'EUDAMED') {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<UDIDeviceData>',
        ...clean.map((d) => [
          '  <Device>',
          `    <UDI-DI>${esc(d.udi)}</UDI-DI>`,
          `    <DeviceName>${esc(d.productName)}</DeviceName>`,
          `    <Model>${esc(d.model)}</Model>`,
          `    <EMDN>${esc(d.emdn)}</EMDN>`,
          `    <IssuingAgency>${esc(d.issuingAgency)}</IssuingAgency>`,
          '  </Device>',
        ].join('\n')),
        '</UDIDeviceData>',
      ].join('\n');
      return { format: 'xml', content: xml };
    }
    if (channel === 'GUDID') {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<SPL xmlns="urn:hl7-org:v3">',
        '  <id root="labelflow-udi-export"/>',
        '  <title>GUDID Device Identifiers</title>',
        ...clean.map((d) => [
          '  <subject>',
          `    <manufacturedProduct><manufacturedMaterial><code code="${esc(d.udi)}"/></manufacturedMaterial></manufacturedProduct>`,
          `    <name>${esc(d.productName)}</name>`,
          '  </subject>',
        ].join('\n')),
        '</SPL>',
      ].join('\n');
      return { format: 'xml', content: xml };
    }
    return { format: 'csv', content: clean.map((d) => Object.values(d).join(',')).join('\n') };
  }
}

function esc(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
