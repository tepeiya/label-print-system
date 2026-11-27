// =============================================================================
// udi.batchprint.service.ts —— 主从层级打印（一箱 N 件）
//
// 一次请求完成四件事，顺序固定，任一步失败都不产出半套标签：
//   1. 号段展开（planSerials）
//   2. 建箱（SSCC：手给或按库里最大流水 +1 自动生成）
//   3. 写台账（udi_packages 一箱 + udi_units N 件，单元挂 package_sscc）
//   4. 出标签（单件模板 N 行 + 箱标模板 1 行，两个打印任务）
//
// 为什么先台账后打印：标签是台账的物理呈现。先打后登记的话，打印失败/重试会留下
// 库里有号、标签没贴的孤儿号；反过来最多是已登记未打印，可用打印任务重打补齐，
// 且重打不会重号（号段已固化在 udi_units 里）。
// =============================================================================

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Template } from '../entities/template.entity';
import { UdiPackage } from './entities/udi.entity';
import { UdiTraceService } from './udi.trace.service';
import { PrintService } from '../print/print.service';
import { formatGs1Date, normalizeGtin } from './udi.calc';
import { gs1DateToIso } from './udi.trace.calc';
import {
  BatchPrintError,
  buildCartonRow,
  buildSscc,
  buildUnitRows,
  FieldMap,
  MAX_UNIT_QTY,
  nextSsccSerial,
  planSerials,
  serialSummary,
  SerialPlan,
  assertSsccUsable,
} from './udi.batchprint.calc';
import { normalizePrefix } from './udi.sscc.calc';

export interface PackPrintDto {
  /** DI（GTIN-14 或 8/12/13 位，内部补零到 14） */
  gtin: string;
  lot: string;
  /** 有效期：YYYY-MM-DD / YYYY-MM / YYMMDD */
  expiry?: string;
  /** 生产日期，同样三种写法 */
  production?: string;
  /** 件数（auto 模式必填） */
  qty?: number;
  serial: SerialPlan;
  /** 箱码；不给则按公司前缀自动生成 */
  sscc?: string;
  /** 上级包装（托盘）已存在时可挂 */
  parentSscc?: string;
  /** 单件标签模板 code（如 UDI_UNIT_V1） */
  unitTemplateCode?: string;
  /** 箱标模板 code（如 UDI_CARTON_V1）；不给则只出单件标 */
  cartonTemplateCode?: string;
  unitTemplateId?: number;
  cartonTemplateId?: number;
  printerId?: number;
  /** 模板变量名映射 */
  fieldMap?: FieldMap;
  copiesUnit?: number;
  copiesCarton?: number;
  /** 只做校验与号段规划，不写库、不打印 */
  dryRun?: boolean;
  workOrderNo?: string;
  /** 是否写 UDI 台账，默认 true；false 时仅生成打印任务（临时补打场景） */
  register?: boolean;
}

export interface PackPrintResult {
  dryRun: boolean;
  gtin14: string;
  lot: string;
  expiryGs1: string | null;
  expiryIso: string | null;
  sscc: string;
  ssccAuto: boolean;
  packageId: number | null;
  unitCount: number;
  serialRange: string;
  unitSerials: string[];
  unitJobId: number | null;
  cartonJobId: number | null;
  registered: { created: number; existed: number; failed: number } | null;
  warnings: string[];
}

@Injectable()
export class UdiBatchPrintService {
  private readonly logger = new Logger(UdiBatchPrintService.name);

  constructor(
    @InjectRepository(Template) private readonly templates: Repository<Template>,
    @InjectRepository(UdiPackage) private readonly packages: Repository<UdiPackage>,
    private readonly trace: UdiTraceService,
    private readonly print: PrintService,
  ) {}

  async packPrint(dto: PackPrintDto, tenantId: number): Promise<PackPrintResult> {
    const warnings: string[] = [];

    // ---- 1. DI / 批号 / 有效期 ----
    if (!dto?.gtin) throw new BadRequestException('缺少 DI（GTIN）');
    const gtin = normalizeGtin(String(dto.gtin));
    if (gtin.errors.length) throw new BadRequestException(gtin.errors.join('；'));
    if (!gtin.checkDigitOk) throw new BadRequestException(`DI ${dto.gtin} 校验位错误（GTIN-14 最后一位是校验位，不能随意改）`);
    const gtin14 = gtin.gtin14;

    const lot = String(dto.lot ?? '').trim();
    if (!lot) throw new BadRequestException('批号不能为空（UDI 单品必须可追溯到批次）');

    let expiryGs1 = '';
    let expiryIso: string | null = null;
    if (dto.expiry) {
      const eff = formatGs1Date(String(dto.expiry));
      if (!eff.value) throw new BadRequestException(`有效期格式错误：${eff.errors.join('；')}`);
      expiryGs1 = eff.value;
      expiryIso = gs1DateToIso(expiryGs1);
    }
    if (dto.production) {
      const prod = formatGs1Date(String(dto.production));
      if (!prod.value) throw new BadRequestException(`生产日期格式错误：${prod.errors.join('；')}`);
    }

    // ---- 2. 号段 ----
    let serials: string[];
    try {
      serials = planSerials({ ...dto.serial, count: dto.serial?.count ?? dto.qty });
    } catch (e: any) {
      if (e instanceof BatchPrintError) throw new BadRequestException(e.message);
      throw e;
    }
    if (serials.length > MAX_UNIT_QTY) throw new BadRequestException(`件数超过单次上限 ${MAX_UNIT_QTY}`);

    // ---- 3. SSCC ----
    const prefix = normalizePrefix(process.env.GS1_COMPANY_PREFIX ?? null);
    let sscc = '';
    let ssccAuto = false;
    if (dto.sscc) {
      try {
        sscc = assertSsccUsable(dto.sscc, prefix);
      } catch (e: any) {
        if (e instanceof BatchPrintError) throw new BadRequestException(e.message);
        throw e;
      }
      const exists = await this.packages.findOne({ where: { tenantId, sscc } });
      if (exists) throw new BadRequestException(`SSCC ${sscc} 已存在，不能重复使用（一箱一码）`);
    } else {
      // 以库里实际出现的同前缀 SSCC 最大流水为准，避免重装后重号
      const used = await this.packages.find({ where: { tenantId }, select: ['sscc'] });
      const next = nextSsccSerial(used.map((p) => p.sscc), prefix);
      sscc = buildSscc(prefix, next);
      ssccAuto = true;
    }

    // ---- 4. 模板 ----
    const unitTplId = dto.unitTemplateId ?? (dto.unitTemplateCode ? await this.templateIdByCode(tenantId, dto.unitTemplateCode, '单件') : null);
    if (!dto.dryRun && !unitTplId) throw new BadRequestException('缺少单件标签模板（unitTemplateCode 或 unitTemplateId）');
    const cartonTplId = dto.cartonTemplateId ?? (dto.cartonTemplateCode ? await this.templateIdByCode(tenantId, dto.cartonTemplateCode, '箱标') : null);

    // 产线场景没有打印机就等于没打印。createJob 在无打印机时会以 skipped 落库并算「成功」，
    // 这条链路不能沿用那个宽松口径 —— 直接拦在入口。
    if (!dto.dryRun && !dto.printerId) throw new BadRequestException('未指定打印机：UDI 标签必须下发到具体打印机，请先选择');

    const fieldMap = dto.fieldMap;
    const unitRows = buildUnitRows(serials, {
      gtin14, lot, expiryGs1, expiryIso: expiryIso ?? '', quantityInCarton: serials.length, fieldMap,
    });
    const cartonRow = buildCartonRow({
      sscc, gtin14, lot, expiryGs1, expiryIso: expiryIso ?? '', qtyInBox: serials.length,
      serialFrom: serials[0], serialTo: serials[serials.length - 1], fieldMap,
    });

    // 模板变量自检：模板里出现、但这里没提供的 {{var}} 会被渲染成空串，
    // 空段在 GS1 码里是直接编码失败，所以要在出标签前就说清楚（拿不到模板内容时跳过）。
    if (unitTplId) {
      const tpl = await this.templates.findOne({ where: { id: unitTplId, tenantId } });
      if (tpl) warnings.push(...this.missingVars(tpl.content, unitRows[0] ?? {}, '单件'));
    }
    if (cartonTplId) {
      const tpl = await this.templates.findOne({ where: { id: cartonTplId, tenantId } });
      if (tpl) warnings.push(...this.missingVars(tpl.content, cartonRow, '箱标'));
    }

    if (dto.dryRun) {
      return {
        dryRun: true, gtin14, lot, expiryGs1: expiryGs1 || null, expiryIso, sscc, ssccAuto,
        packageId: null, unitCount: serials.length, serialRange: serialSummary(serials),
        unitSerials: serials, unitJobId: null, cartonJobId: null, registered: null, warnings,
      };
    }

    // ---- 5. 写台账 ----
    let registered: PackPrintResult['registered'] = null;
    let packageId: number | null = null;
    if (dto.register !== false) {
      const pkg = await this.trace.upsertPackages([{
        sscc, level: 'CARTON', gtin: gtin14, qty: serials.length,
        parentSscc: dto.parentSscc, workOrderNo: dto.workOrderNo,
      }]);
      packageId = pkg.items?.[0]?.id ?? null;

      const reg = await this.trace.registerUnits(
        serials.map((serial) => ({
          gtin: gtin14, lot, serial, expiry: expiryGs1, packageSscc: sscc, workOrderNo: dto.workOrderNo,
        })) as any,
        { templateCode: dto.unitTemplateCode ?? undefined, workOrderNo: dto.workOrderNo },
      );
      registered = { created: reg.created, existed: reg.existed, failed: reg.failed };
      if (reg.failed > 0) {
        const first = reg.errors.slice(0, 5).map((e) => `第 ${e.index + 1} 件：${e.message}`).join('；');
        throw new BadRequestException(
          `有 ${reg.failed}/${reg.total} 件登记失败，已中止打印：${first}。箱 ${sscc} 已建立，修正后可重试（不会重号）`,
        );
      }
      if (reg.existed > 0) {
        warnings.push(`有 ${reg.existed} 件序列号此前已登记（同一 DI+批号+序列号视为同一件），本次不重复建账，仍会出标签`);
      }
    }

    // ---- 6. 出标签 ----
    const unitJob = await this.print.createJob({
      templateId: unitTplId!, printerId: dto.printerId,
      rows: unitRows as any[], copies: Math.max(1, dto.copiesUnit ?? 1), requirePrinter: true,
    });
    const cartonJob = cartonTplId
      ? await this.print.createJob({
        templateId: cartonTplId, printerId: dto.printerId,
        rows: [cartonRow as any], copies: Math.max(1, dto.copiesCarton ?? 1), requirePrinter: true,
      })
      : null;

    if ((unitJob as any).status === 'skipped_no_printer') warnings.push('单件标签任务未下发：没有可用打印机');

    this.logger.log(
      `主从打印 tenant=${tenantId} 箱=${sscc} 件=${serials.length} 单件任务=${(unitJob as any).jobId} 箱标任务=${(cartonJob as any)?.jobId ?? '-'}`,
    );

    return {
      dryRun: false, gtin14, lot, expiryGs1: expiryGs1 || null, expiryIso, sscc, ssccAuto,
      packageId, unitCount: serials.length, serialRange: serialSummary(serials),
      unitSerials: serials, unitJobId: (unitJob as any).jobId ?? null,
      cartonJobId: (cartonJob as any)?.jobId ?? null, registered, warnings,
    };
  }

  /** 表单所需的元信息：单件/箱标模板分开给、公司前缀、单次上限 */
  async meta(tenantId: number) {
    const tpls = await this.templates.find({ where: { tenantId }, select: ['id', 'code', 'name', 'category'] });
    const isUdi = (t: Template) => String(t.category ?? '').toUpperCase() === 'UDI' || /UDI/i.test(String(t.code ?? ''));
    let prefix: { prefix: string; valid: boolean; note?: string };
    try {
      prefix = { prefix: normalizePrefix(process.env.GS1_COMPANY_PREFIX ?? null), valid: true };
    } catch (e: any) {
      prefix = { prefix: '6901234', valid: false, note: String(e?.message ?? e) };
    }
    // 箱级模板：UDI 箱标（UDI_CARTON_*）与普通 WMS 箱标（*CARTON*）都算。单件下拉必须排除，
    // 否则表单默认选中第一个就把箱标当单件打——一次 100 张 A4 大小的箱标是实打实的耗材损失。
    const isCartonTpl = (t: Template) => /CARTON|箱/i.test(`${t.code ?? ''} ${t.name ?? ''}`);
    const brief = (t: Template) => ({ id: t.id, code: t.code, name: t.name, category: t.category });
    const udi = tpls.filter(isUdi);
    return {
      maxUnitQty: MAX_UNIT_QTY,
      prefix,
      unitTemplates: udi.filter((t) => !isCartonTpl(t)).map(brief),
      cartonTemplates: [
        ...udi.filter(isCartonTpl).map(brief),
        ...tpls.filter((t) => !isUdi(t) && isCartonTpl(t)).map(brief),
      ],
      allTemplates: tpls.filter((t) => !!t.code).map((t) => ({ id: t.id, code: t.code, name: t.name })),
    };
  }

  private async templateIdByCode(tenantId: number, code: string, what: string): Promise<number> {
    const tpl = await this.templates.findOne({ where: { tenantId, code }, select: ['id', 'name', 'code'] });
    if (!tpl) throw new NotFoundException(`${what}模板 code「${code}」不存在，请先在模板库导入或选择`);
    return tpl.id;
  }

  /** 模板里引用、但本次数据没有提供的变量（这些会渲染成空串） */
  private missingVars(content: any, row: Record<string, unknown>, what: string): string[] {
    const raw = JSON.stringify(content ?? {});
    const names = new Set<string>();
    raw.replace(/\{\{\s*([^{}"]+?)\s*\}\}/g, (_m, n: string) => {
      names.add(String(n).trim());
      return _m;
    });
    const missing = [...names].filter((n) => !(n in row));
    return missing.length
      ? [`${what}模板引用了 ${missing.slice(0, 6).join('、')}${missing.length > 6 ? ' 等' : ''} 变量，但本次数据未提供，会被渲染成空（GS1 段为空会导致编码失败）`]
      : [];
  }
}

