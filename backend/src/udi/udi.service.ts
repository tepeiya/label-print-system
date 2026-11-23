// =============================================================================
// UdiService —— UDI 赋码/解析/扫码复核的业务入口（无库依赖）
//
// 【为什么单独成服务】三个消费方：模板设计器（预览码）、PDA（扫码复核）、
//   外部系统（MES/ERP 通过 internal API 取码串）。共用一套规则，必须单一入口。
// 【边界】本服务只做数据与判定；打印走既有 PrintGateway/模板通道；追溯落库在后续里程碑。
// =============================================================================
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  buildUdi, parseUdi, udiBarcodeSpec, udiUnitKey, normalizeGtin, formatGs1Date,
  UdiInput, UdiBuildResult,
} from './udi.calc';
import { udiTemplateByCode, udiTemplateList, UDI_TEMPLATES } from './udi.templates';

export interface ScanExpectation {
  gtin?: string;
  expiry?: string;
  lot?: string;
  serial?: string;
}

@Injectable()
export class UdiService {
  /** 构造 UDI：返回 HRI、元素串、DI/PI、模板可用规格与单品键 */
  encode(dto: UdiInput & { templateCode?: string }) {
    const r = buildUdi(dto);
    const spec = udiBarcodeSpec(r);
    return {
      ...r,
      unitKey: r.ok ? udiUnitKey(r) : null,
      barcode: { ...spec, note: 'DataMatrix 走 GS1 原生码制；ZPL/TSPL 指令通道请用 elementString 或走 image 通道' },
      template: dto.templateCode ? udiTemplateByCode(dto.templateCode)?.name ?? null : null,
      templateCodes: UDI_TEMPLATES.map((t) => t.code),
    };
  }

  /** 解析扫码内容（HRI 或原始元素串） */
  parse(dto: { code: string }) {
    const code = String(dto?.code ?? '').trim();
    if (!code) throw new BadRequestException('code 不能为空');
    return parseUdi(code);
  }

  /**
   * 扫码复核（PDA 用）：扫到的码与工单/标签预期逐字段比对。
   * mismatch 明确到字段，便于现场直接提示"批号不符"而不是笼统"扫错了"。
   */
  scanVerify(dto: { code: string; expect: ScanExpectation; strict?: boolean }) {
    const parsed = parseUdi(dto?.code ?? '');
    const expect = dto?.expect ?? {};
    const mismatches: Array<{ field: string; expected: string; actual: string | null }> = [];

    const cmp = (field: string, expected?: string, normalize?: (v: string) => string) => {
      if (!expected) return;
      const act = (parsed.udi as any)[field] as string | null;
      const e = normalize ? normalize(expected) : expected;
      const a = act == null ? null : normalize ? normalize(act) : act;
      if (e !== a) mismatches.push({ field, expected: e, actual: a });
    };
    cmp('gtin', expect.gtin, (v) => normalizeGtin(v).gtin14);
    cmp('expiry', expect.expiry, (v) => formatGs1Date(v).value ?? v);
    cmp('lot', expect.lot);
    cmp('serial', expect.serial);

    // strict：缺字段也算不符（用于"整包复核"，如发货前整单校验）
    if (dto?.strict) {
      for (const [field, exp] of Object.entries(expect)) {
        if (!exp) continue;
        if ((parsed.udi as any)[field] == null && !mismatches.some((m) => m.field === field)) {
          mismatches.push({ field, expected: String(exp), actual: null });
        }
      }
    }

    return {
      ok: parsed.ok && mismatches.length === 0,
      codeOk: parsed.ok,
      match: mismatches.length === 0,
      mismatches,
      parsed,
      message: !parsed.ok
        ? `码内容不合规：${parsed.errors.slice(0, 2).join('；')}`
        : mismatches.length
          ? `与预期不符：${mismatches.map((m) => `${m.field} 期望 ${m.expected}、实际 ${m.actual ?? '空'}`).join('；')}`
          : '复核通过：码内容合规且与预期一致',
    };
  }

  /** 批量构造（Excel 导入场景）：逐行返回，部分成功口径与阶段一导入一致 */
  batchEncode(dto: { rows: Array<UdiInput & { rowNo?: number }> }) {
    const rows = dto?.rows ?? [];
    if (!rows.length) throw new BadRequestException('rows 不能为空');
    if (rows.length > 5000) throw new BadRequestException('单次最多 5000 行，请分批导入');
    const results = rows.map((r, i) => {
      const built: UdiBuildResult = buildUdi(r);
      return {
        rowNo: r.rowNo ?? i + 1,
        ok: built.ok,
        errors: built.errors,
        warnings: built.warnings,
        hri: built.hri,
        elementString: built.elementString,
        unitKey: built.ok ? udiUnitKey(built) : null,
      };
    });
    return {
      total: results.length,
      created: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /** UDI 模板包清单（医疗客户开箱即用） */
  templates() {
    return {
      items: udiTemplateList(),
      notice: '通过 POST /api/v1/templates/import 导入模板 JSON；变量 gtin/expiry/lot/serial 由本模块产出',
    };
  }

  /** 取某个模板包的完整 JSON（供导入接口直接使用） */
  templatePayload(code: string) {
    const t = udiTemplateByCode(code);
    if (!t) throw new BadRequestException(`UDI 模板不存在：${code}（可用：${UDI_TEMPLATES.map((x) => x.code).join(' / ')}）`);
    return { code: t.code, name: t.name, scenario: t.scenario, template: t.template };
  }
}
