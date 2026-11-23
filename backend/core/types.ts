// =============================================================================
// types.ts —— 后端核心共享类型（与模板 JSON Schema 对齐）
// =============================================================================

export interface BarcodeSpec {
  /** UI 码制：CODE128 / GS1_128 / CODE39 / EAN13 / UPC / ITF14 / MSI / … */
  sym: string;
  content: string;            // 已解析变量/公式后的最终内容
  moduleWidthMm: number;      // 窄条宽（X-dimension，mm）
  wideRatio: number;          // 宽窄比
  heightMm: number;
  showText: boolean;
  textPosition: 'bottom' | 'top';
  textFont?: { size: number; family: string };
  checksum?: boolean;
  /**
   * GS1 模式（UDI 赋码用）：content 必须是带括号的 HRI，如 (01)…(17)…(10)…(21)。
   * 渲染器对 DataMatrix 走 bwip 原生 gs1datamatrix（自动处理 FNC1 与 AI 断句），
   * 避免手拼 \u001D 在某些解码器/打印机上丢分隔符。
   */
  gs1?: boolean;
}

export interface QrcodeSpec {
  /** UI 码制：QRCODE / MICROQR / DATAMATRIX / PDF417 / AZTEC / … */
  sym: string;
  content: string;
  ecc: 'L' | 'M' | 'Q' | 'H';
  moduleSizeMm: number;
  quietZoneMm: number;
  /**
   * GS1 模式（UDI 赋码用）：content 传带括号 HRI，DataMatrix 走原生 gs1datamatrix，
   * 由 bwip 负责 FNC1 与 AI 断句（避免手拼 \u001D 在扫码枪/打印机上丢分隔符）。
   */
  gs1?: boolean;
}

/**
 * 位图回填数据（P7.3）。由 raster.ts 预生成，生成器只负责按协议封装下发。
 * 生成器本身保持同步：拿到 raster 就出图像指令，拿不到就跳过 + warnings。
 */
export interface BitmapFallback {
  widthDots: number;
  heightDots: number;
  bytesPerRow: number;
  /** 逐行 ASCII hex 拼接（长度 = bytesPerRow*heightDots*2） */
  hex: string;
  /** 每模块打印点数 */
  moduleDots: number;
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
