// =============================================================================
// 设计器数据模型（模板 JSON 的唯一权威类型，schemaVersion=1）
//   与 web/js/model.js 完全同构：后端 templates.content 存的就是这套结构，
//   打印端（backend/src/print）与原生 web 设计器也读同一份，字段不能随意改。
// =============================================================================

export type ElementType =
  | 'text' | 'line' | 'rect' | 'ellipse' | 'table' | 'image'
  | 'barcode' | 'qrcode' | 'formula' | 'serial' | 'datetime' | 'sysvar';

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
  defaultValue?: string | number | null;
  required?: boolean;
  unique?: boolean;
  validation?: string;
  regex?: string;
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
  zIndex?: number;
  locked?: boolean;
  visible?: boolean;
  opacity?: number;
  groupId?: string;
  name?: string;
  printIf?: string;

  // text / formula / serial / datetime / sysvar
  text?: string;
  font?: FontSpec;
  formula?: { expr?: string; defaultOnError?: string };
  serial?: { sequenceRef?: string; digits?: number; prefix?: string; suffix?: string };
  datetime?: { pattern?: string; source?: string };
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
