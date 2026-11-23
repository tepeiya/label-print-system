// =============================================================================
// udi.printer-profiles.ts —— UDI 真机适配矩阵与校准清单（UDI 里程碑 U3 前置）
//
// 【边界】这里不写任何打印机指令流（ZPL/TSPL 由既有 HardwareAgent/模板渲染负责）；
//   本文件只声明"哪些机型已适配/待现场验、用什么通道、DM 最小模块、校准步骤、验收项"。
// 【诚实口径】status='POC' 表示"参数按厂商手册预设、未在真机出过合格样张"，
//   交付时必须让实施在客户现场按 calibration 逐条打勾签字（docs/18 §6 附表）。
// =============================================================================
import { UDI_TEMPLATES } from './udi.templates';

export interface PrinterProfile {
  id: string;
  vendor: string;
  model: string;
  dpi: number[];
  /** 通道：RAW_IMAGE = 走图片光栅（与本系统最稳）、NATIVE = 原生指令（需厂商确认 FNC1） */
  channel: 'RAW_IMAGE' | 'NATIVE';
  protocols: string[];
  /** 推荐最小模块尺寸（mm）：GS1 要求 ≥0.25mm（203dpi 下 1 dot=0.125mm，建议 ≥2 dot） */
  minModuleMm: number;
  /** 该机型上已验证/建议的 UDI 模板 */
  templateCodes: string[];
  /** 打印参数预设：速度/浓度/介质，现场按样张再调 */
  preset: { speedIps?: number; darkness?: number; media?: string; labelWidthMm?: number; labelHeightMm?: number };
  status: 'POC' | 'SITE_VERIFIED';
  notes: string;
}

/** 三款目标机型（用户认可"先适配三台"）：桌面型主力 + 国产性价比 + 工业型 */
export const PRINTER_PROFILES: PrinterProfile[] = [
  {
    id: 'zebra-zd421',
    vendor: 'Zebra 斑马',
    model: 'ZD421（203dpi / 300dpi 可选）',
    dpi: [203, 300],
    channel: 'RAW_IMAGE',
    protocols: ['ZPL', 'EPL', 'USB', 'Ethernet', 'BT'],
    minModuleMm: 0.25,
    templateCodes: ['UDI_UNIT_V1', 'UDI_CARTON_V1', 'UDI_VIAL_V1'],
    preset: { speedIps: 4, darkness: 12, media: '热转印 PET/铜版纸 + 树脂碳带', labelWidthMm: 50, labelHeightMm: 30 },
    status: 'POC',
    notes: '203dpi 下 DataMatrix 建议模块 ≥2 dot（0.25mm）；UDI_VIAL_V1(30×20) 在 203dpi 上必须用 0.25mm 模块并关掉 quietZone 压缩，否则解码率下降。',
  },
  {
    id: 'hprt-n41',
    vendor: '汉印 HPRT',
    model: 'N41 / SL42（203dpi）',
    dpi: [203],
    channel: 'RAW_IMAGE',
    protocols: ['TSPL', 'USB', 'BT'],
    minModuleMm: 0.3,
    templateCodes: ['UDI_CARTON_V1', 'UDI_UNIT_V1'],
    preset: { speedIps: 3, darkness: 10, media: '热敏/热转印 铜版纸', labelWidthMm: 100, labelHeightMm: 70 },
    status: 'POC',
    notes: '国产机型 TSPL 的 DM 指令带 FNC1 需固件支持，故走图片光栅通道（由本系统渲染 PNG 后下发），可绕开固件差异；100×70 箱标首选。',
  },
  {
    id: 'godex-rt700i',
    vendor: 'GODEX 科诚',
    model: 'RT700i / DT4x（203dpi）',
    dpi: [203, 300],
    channel: 'RAW_IMAGE',
    protocols: ['EZPL', 'USB', 'Ethernet'],
    minModuleMm: 0.25,
    templateCodes: ['UDI_UNIT_V1', 'UDI_CARTON_V1'],
    preset: { speedIps: 4, darkness: 10, media: '热转印 合成纸', labelWidthMm: 50, labelHeightMm: 30 },
    status: 'POC',
    notes: 'EZPL 与 ZPL 近似但非等价，勿直接套 ZPL 头；统一走图片光栅最稳。',
  },
];

/** 每台机的现场校准步骤（实施照做、逐条打勾，附样张照片归档） */
export const CALIBRATION_STEPS: Array<{ step: number; title: string; detail: string; evidence: string }> = [
  { step: 1, title: '介质与碳带确认', detail: '核对标签材质（合成纸/PET）与碳带类型（树脂/混合），记录批次', evidence: '介质照片 + 批次号' },
  { step: 2, title: '走纸与间隙校准', detail: '执行厂商自动测纸（Zebra 长按 FEED；汉印/GODEX 自检页），确认 203dpi 下 50×30 定位无偏移', evidence: '自检页照片' },
  { step: 3, title: '首件打印（UDI_UNIT_V1）', detail: '打 3 张，检查 DM 是否完整、quietZone 是否被裁切、HRI 是否清晰可读', evidence: '3 张样张 + 目视记录' },
  { step: 4, title: '解码验证（本系统回环）', detail: '用本系统 verify 接口或 PDA 扫码，确认 DI/PI 与系统值一致（≥3/3 通过）', evidence: '扫码结果截图' },
  { step: 5, title: '箱标与层级码（UDI_CARTON_V1）', detail: '打 100×70 箱标，确认 SSCC 与箱内单品能建立父子关系', evidence: '箱标照片 + 追溯查询截图' },
  { step: 6, title: '小尺寸极限（UDI_VIAL_V1）', detail: '30×20 试剂瓶标，确认 0.25–0.3mm 模块下 10 次扫描 ≥9 次成功', evidence: '10 次扫描记录表' },
  { step: 7, title: '打印质量抽检（可选）', detail: '若有 ISO/IEC 15415 验码仪，记录符号等级（本系统不承诺等级判定，只做记录）', evidence: '验码仪报告' },
  { step: 8, title: '速度/浓度定版', detail: '在合格样张上锁定速度与浓度，写入机型 preset，禁止现场随意改动', evidence: '参数定版截图' },
];

/** 交付口径：哪些能做、哪些不承诺（对客户/销售统一话术） */
export const ADAPTER_SCOPE = {
  inScope: [
    '图片光栅通道（PNG → 打印机驱动/Agent），绕开固件 FNC1 差异',
    'GS1 DataMatrix 内容与 HRI 由 UdiService 统一生成（bwip gs1datamatrix）',
    '三款机型的参数预设、校准清单、验收记录模板',
    '解码回环验证（服务端 zxing-wasm + PDA 扫码双通道）',
  ],
  outOfScope: [
    'ISO/IEC 15415/15416 打印质量等级判定（需硬件验码仪，只做记录不做判定）',
    '各机型原生指令流逆向与固件升级（交厂商/代理）',
    '多语言碳带/特殊介质（客户自备介质时另行现场验证）',
  ],
} as const;

/** 适配矩阵 + 校准清单（前端/实施可直接渲染成表） */
export function printerAdapterPayload() {
  return {
    profiles: PRINTER_PROFILES,
    calibration: CALIBRATION_STEPS,
    scope: ADAPTER_SCOPE,
    templates: UDI_TEMPLATES.map((t) => ({ code: t.code, name: t.name, page: t.template?.page ?? null })),
    caveat: 'status=POC 的机型参数来自厂商手册与同类机型经验，未在真机出过样张；交付前必须现场校准并签字（docs/18 §6）。',
  };
}

export function printerProfileById(id: string) {
  return PRINTER_PROFILES.find((p) => p.id === id) ?? null;
}
