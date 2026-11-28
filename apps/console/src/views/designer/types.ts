// =============================================================================
// 设计器数据模型（模板 JSON 的唯一权威类型，schemaVersion=1）
//   与 web/js/model.js 完全同构：后端 templates.content 存的就是这套结构，
//   打印端（backend/src/print）与原生 web 设计器也读同一份，字段不能随意改。
// =============================================================================

export type ElementType =
  | 'text' | 'richtext' | 'line' | 'rect' | 'ellipse' | 'table' | 'image'
  | 'barcode' | 'qrcode' | 'formula' | 'serial' | 'datetime' | 'sysvar' | 'dbField';

/** 第四层：富文本片段（与后端 core/rich-text.ts parity） */
export interface RichTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  /** pt 覆盖 */
  size?: number;
  script?: 'sub' | 'super';
}

/** 第四层：DB 字段元素（绑定数据源字段，打印时按行取值） */
export interface DbFieldSpec {
  /** 数据源 id（datasource 模块）；空=模板变量兜底 */
  datasetId?: string;
  /** 字段名（列标题/变量 key） */
  field: string;
  /** 取值格式化：date:YYYY-MM-DD / num:2 / upper / lower，空=原样 */
  format?: string;
  /** 无值时的占位文本 */
  fallback?: string;
}

export interface FontSpec {
  family?: string;
  /** pt（设计态按 96dpi 换算成 px，打印态直接用 pt） */
  size?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  lineHeight?: number;
  letterSpacing?: number;
}

export interface StrokeSpec {
  width?: number;
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
}

/** 第二层：弧形排布。radiusMm 建议 ≥ 元素宽/2；sweepDeg 10–180。 */
export interface CurveSpec {
  enabled?: boolean;
  radiusMm?: number;
  sweepDeg?: number;
  direction?: 'up' | 'down';
}

export interface BarcodeSpec {
  sym?: string;
  content?: string;
  moduleWidthMm?: number;
  wideRatio?: number;
  heightMm?: number;
  showText?: boolean;
  textPosition?: 'top' | 'bottom';
  checksum?: boolean;
  quietZoneMm?: number;
  textFont?: { family?: string; size?: number };
}

export interface QrcodeSpec {
  sym?: string;
  content?: string;
  /** GS1 模式：DataMatrix 走原生 gs1datamatrix（内部 FNC1，HRI 带括号）。UDI 标签必须开。 */
  gs1?: boolean;
  ecc?: 'L' | 'M' | 'Q' | 'H';
  moduleSizeMm?: number;
  quietZoneMm?: number;
  version?: number;
}

export interface Guide {
  id: string;
  axis: 'x' | 'y';
  pos: number;
}

export interface PageSpec {
  widthMm: number;
  heightMm: number;
  dpi: number;
  orientation: number;
  unit: string;
  columns: number;
  rows: number;
  gapXMm: number;
  gapYMm: number;
  marginMm: number;
  copies: number;
  duplex: boolean;
  mediaType: string;
  gapMm: number;
  blackMarkMm: number;
  offsetXMm: number;
  offsetYMm: number;
  calibrateXMm: number;
  calibrateYMm: number;
  guides: Guide[];
}

export interface VariableSpec {
  name: string;
  type?: string;
  label?: string;
  /** 计算变量：填公式后由数据行实时求值；与 defaultValue 互斥（有 expr 时 defaultValue 仅作错误兜底） */
  expr?: string;
  defaultValue?: string | number | null;
  required?: boolean;
  unique?: boolean;
  validation?: string;
  regex?: string;
  /**
   * 打印时录入：打印页会给操作员一个输入框（批号/有效期/序列号这种每次都要换的值）。
   * 字段定义只有这一份——后端拿它做必填与格式校验，前端拿它渲染表单。
   */
  atPrint?: boolean;
}

/** 画布元素：字段按 type 取用，未使用的键不存在（与原生成器一致，别补默认值） */
export interface ElementData {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  /** 第二层：弧形排布（text/barcode 有效；SVG 导出真曲线，指令通道退化为直线） */
  curve?: CurveSpec;
  zIndex?: number;
  locked?: boolean;
  visible?: boolean;
  opacity?: number;
  groupId?: string;
  name?: string;
  printIf?: string;

  // text / richtext / formula / serial / datetime / sysvar
  text?: string;
  /**
   * HRI 绑定：文本内容跟随某个条码/二维码元素（填该元素 id）。
   * 用于二维码旁的人眼可读文本 —— 内容永远等于码里真正编进去的串，
   * 避免「改了码没改字」导致 GS1/UDI 合规检查不一致。
   */
  bindId?: string;
  /** 第四层：富文本片段（richtext 元素正文） */
  runs?: RichTextRun[];
  font?: FontSpec;
  /** 第四层：DB 字段元素绑定 */
  dbField?: DbFieldSpec;
  formula?: { expr?: string; defaultOnError?: string };
  serial?: { sequenceRef?: string; digits?: number; prefix?: string; suffix?: string };
  datetime?: { pattern?: string; source?: string; offset?: string };
  sysvar?: { key?: string };

  // 图形
  fill?: string;
  cornerRadius?: number;
  stroke?: StrokeSpec;
  x2?: number;
  y2?: number;

  // 表格
  rows?: number;
  cols?: number;
  cells?: string[];
  /** 第四层：合并单元格 [{row,col,rowSpan,colSpan}]（P8 AI 表格识别已用此形状） */
  mergedCells?: Array<{ row: number; col: number; rowSpan: number; colSpan: number }>;
  /** 第四层：单元格自动换行（默认 true） */
  cellWrap?: boolean;
  showBorder?: boolean;
  borderWidth?: number;
  borderColor?: string;
  headerRow?: boolean;
  headerBg?: string;

  // 图片 / 条码
  src?: string;
  barcode?: BarcodeSpec;
  qrcode?: QrcodeSpec;

  [key: string]: unknown;
}

export interface TemplateData {
  schemaVersion: number;
  page: PageSpec;
  variables: VariableSpec[];
  elements: ElementData[];
  name?: string;
  category?: string;
  tags?: string[];
}

/** 服务端返回的模板行（backend/src/template/template.entity.ts 的对外形状） */
export interface TemplateRecord {
  id: number;
  name: string;
  category?: string | null;
  tags?: string[] | null;
  content: TemplateData;
  currentVersion?: number;
  isFavorite?: boolean;
  updatedAt?: string;
  createdAt?: string;
}

export interface TemplateVersion {
  id: number;
  templateId: number;
  version: number;
  content: TemplateData;
  createdBy?: number | null;
  createdAt?: string;
}
