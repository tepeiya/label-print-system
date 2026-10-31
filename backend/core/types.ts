// =============================================================================
// types.ts —— 后端核心共享类型（与模板 JSON Schema 对齐）
// =============================================================================

export interface BarcodeSpec {
  sym: 'CODE128' | 'CODE39' | 'EAN13' | 'EAN8' | 'UPC_A' | 'ITF14' | 'GS1_128' | 'CODABAR' | 'MSI';
  content: string;            // 已解析变量/公式后的最终内容
  moduleWidthMm: number;      // 窄条宽（mm）
  wideRatio: number;          // 宽窄比
  heightMm: number;
  showText: boolean;
  textPosition: 'bottom' | 'top';
  textFont?: { size: number; family: string };
  checksum?: boolean;
}

export interface QrcodeSpec {
  sym: 'QR' | 'MICRO_QR' | 'DATAMATRIX' | 'PDF417' | 'AZTEC';
  content: string;
  ecc: 'L' | 'M' | 'Q' | 'H';
  moduleSizeMm: number;
  quietZoneMm: number;
}

/** 打印任务上下文：模板 + 数据行 + 打印机 */
export interface RenderContext {
  tenantId: number;
  templateId: number;
  printer: {
    dpi: number;
    widthMm: number;
    heightMm: number;
    offsetXMm: number;
    offsetYMm: number;
    orientation: 0 | 90 | 180 | 270;
  };
  row: Record<string, any>;       // 当前数据行（变量值来源之一）
  serialValues: string[];          // 预分配流水号（按 consume_mode 切片）
  systemVars: Record<string, any>; // 系统变量：页码/打印人/UUID…
}

export interface PrintResult {
  ok: boolean;
  bytes?: Buffer;        // RawTcp/Image 通道的出图/指令字节
  jobId?: number;
  error?: string;
}
