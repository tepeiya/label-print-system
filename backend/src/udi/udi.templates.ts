// =============================================================================
// udi.templates —— UDI 标准模板包（3 个规格，按 docs/04 模板 Schema 组织）
//
// 【用途】医疗客户开箱即可用：不用从零画模板，导入后改公司名/规格即可上线。
//   · UDI_UNIT_V1   单件贴（袋/盒）：50×30mm，DataMatrix + HRI 明文 + 产品信息
//   · UDI_CARTON_V1 中箱/外箱：100×70mm，大码 + SSCC(AI 00) + 数量 + 批号
//   · UDI_VIAL_V1   试剂瓶窄标签：30×20mm，小码 + 三行极简信息
//
// 【导入方式】POST /api/v1/templates/import（body 为该模板 JSON），或前端"导入模板"。
// 【变量约定】gtin / expiry / lot / serial 由 UDI 构造器产出，前端/接口填值即可；
//   expiry 为 YYMMDD（GS1 口径），lot/serial ≤20 位。
// 【诚实边界】模板只保证"数据与码制正确"；打印质量等级（ISO/IEC 15415）需真机+验证仪验收。
// =============================================================================

export interface UdiTemplateBlueprint {
  code: string;
  name: string;
  scenario: string;
  template: Record<string, any>;
}

const FONT = { family: 'Microsoft YaHei', size: 8, color: '#000000', align: 'left', vAlign: 'top', wrap: true };

/** DataMatrix 元素：gs1=true 走原生 GS1 码制（HRI 带括号） */
function dmElement(id: string, x: number, y: number, w: number, h: number, content: string, moduleSizeMm: number) {
  return {
    id, type: 'qrcode', name: 'UDI DataMatrix', x, y, w, h, rotation: 0, zIndex: 5,
    qrcode: {
      sym: 'DATAMATRIX', content, ecc: 'M', moduleSizeMm, quietZoneMm: 1, gs1: true,
    },
  };
}

function textElement(id: string, x: number, y: number, w: number, h: number, text: string, font: Record<string, any>) {
  return { id, type: 'text', x, y, w, h, rotation: 0, zIndex: 3, text, font: { ...FONT, ...font } };
}

/** 1) 单件贴 50×30 */
const UNIT: Record<string, any> = {
  schemaVersion: 1,
  page: { widthMm: 50, heightMm: 30, dpi: 300, orientation: 0, unit: 'mm' },
  variables: [
    { name: 'gtin', type: 'text', required: true, validation: { pattern: '^(01)?\\d{14}$' } },
    { name: 'expiry', type: 'text', required: true, validation: { pattern: '^\\d{6}$' } },
    { name: 'lot', type: 'text', required: true, validation: { maxLength: 20 } },
    { name: 'serial', type: 'text', required: false, validation: { maxLength: 20 } },
    { name: 'productName', type: 'text', required: true, defaultValue: '产品名称' },
    { name: 'spec', type: 'text', defaultValue: '' },
    { name: 'manufacturer', type: 'text', defaultValue: '生产企业名称' },
  ],
  elements: [
    textElement('el-name', 2, 1.5, 46, 5, '{{productName}}', { size: 9, bold: true, align: 'center', vAlign: 'middle', wrap: false }),
    textElement('el-spec', 2, 6.5, 46, 4, '规格：{{spec}}', { size: 7, wrap: false }),
    dmElement('el-udi-dm', 2, 11, 16, 16, '(01){{gtin}}(17){{expiry}}(10){{lot}}(21){{serial}}', 0.3),
    textElement('el-hri', 19.5, 11, 28.5, 16,
      '(01){{gtin}}\n(17){{expiry}}\n(10){{lot}}\n(21){{serial}}', { size: 6, wrap: true }),
    textElement('el-mfr', 2, 27.5, 46, 2.2, '{{manufacturer}}', { size: 5, color: '#333333', wrap: false }),
  ],
  print: { copies: 1 },
};

/** 2) 中箱/外箱 100×70 */
const CARTON: Record<string, any> = {
  schemaVersion: 1,
  page: { widthMm: 100, heightMm: 70, dpi: 300, orientation: 0, unit: 'mm' },
  variables: [
    { name: 'gtin', type: 'text', required: true },
    { name: 'expiry', type: 'text', required: true },
    { name: 'lot', type: 'text', required: true },
    { name: 'sscc', type: 'text', required: false, validation: { pattern: '^\\d{18}$' } },
    { name: 'qty', type: 'number', defaultValue: 1 },
    { name: 'productName', type: 'text', defaultValue: '产品名称' },
    { name: 'manufacturer', type: 'text', defaultValue: '生产企业名称' },
  ],
  elements: [
    textElement('el-name', 3, 3, 94, 8, '{{productName}}', { size: 12, bold: true, align: 'center', vAlign: 'middle', wrap: false }),
    dmElement('el-udi-dm', 3, 14, 32, 32, '(01){{gtin}}(17){{expiry}}(10){{lot}}', 0.45),
    textElement('el-hri', 38, 14, 59, 32,
      '(01){{gtin}}\n(17){{expiry}}\n(10){{lot}}\n数量：{{qty}}', { size: 9, wrap: true }),
    {
      id: 'el-sscc', type: 'barcode', x: 3, y: 50, w: 94, h: 12, rotation: 0, zIndex: 5,
      barcode: {
        sym: 'GS1_128', content: '(00){{sscc}}', moduleWidthMm: 0.35, wideRatio: 2.5,
        heightMm: 10, showText: false, textPosition: 'bottom',
      },
    },
    textElement('el-mfr', 3, 63, 94, 4, '{{manufacturer}}', { size: 8, color: '#333333', wrap: false }),
  ],
  print: { copies: 1 },
};

/** 3) 试剂瓶窄标签 30×20 */
const VIAL: Record<string, any> = {
  schemaVersion: 1,
  page: { widthMm: 30, heightMm: 20, dpi: 300, orientation: 0, unit: 'mm' },
  variables: [
    { name: 'gtin', type: 'text', required: true },
    { name: 'expiry', type: 'text', required: true },
    { name: 'lot', type: 'text', required: true },
    { name: 'productName', type: 'text', defaultValue: '试剂名称' },
  ],
  elements: [
    dmElement('el-udi-dm', 1.5, 3, 13, 13, '(01){{gtin}}(17){{expiry}}(10){{lot}}', 0.25),
    textElement('el-name', 16, 3, 12.5, 5, '{{productName}}', { size: 6, bold: true, wrap: true }),
    textElement('el-info', 16, 8.5, 12.5, 8, '17:{{expiry}}\n10:{{lot}}', { size: 6, wrap: true }),
    textElement('el-hri', 1.5, 16.5, 27, 2.5, '(01){{gtin}}', { size: 5, color: '#333333', wrap: false }),
  ],
  print: { copies: 1 },
};

export const UDI_TEMPLATES: UdiTemplateBlueprint[] = [
  { code: 'UDI_UNIT_V1', name: 'UDI 单件标签（50×30）', scenario: '灭菌袋 / 单件盒 / 三类高值耗材', template: UNIT },
  { code: 'UDI_CARTON_V1', name: 'UDI 箱标签（100×70）', scenario: '中箱 / 外箱，含 SSCC 物流码', template: CARTON },
  { code: 'UDI_VIAL_V1', name: 'UDI 试剂瓶标签（30×20）', scenario: '体外诊断试剂 / 小瓶身', template: VIAL },
];

export function udiTemplateList() {
  return UDI_TEMPLATES.map((t) => ({
    code: t.code, name: t.name, scenario: t.scenario,
    page: t.template.page,
    variables: (t.template.variables ?? []).map((v: any) => v.name),
  }));
}

export function udiTemplateByCode(code: string): UdiTemplateBlueprint | null {
  return UDI_TEMPLATES.find((t) => t.code === String(code ?? '').trim()) ?? null;
}
