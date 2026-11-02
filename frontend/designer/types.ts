// =============================================================================
// designer/types.ts —— 设计器完整数据结构
// 坐标/尺寸对外一律 mm；dpi 用于内部渲染换算
// =============================================================================

export type ElementType =
  | 'text' | 'image' | 'line' | 'rect' | 'ellipse'
  | 'table' | 'barcode' | 'qrcode' | 'formula' | 'serial'
  | 'datetime' | 'sysvar';

/** 通用元素基类 */
export interface BaseElement {
  id: string;
  type: ElementType;
  name?: string;
  x: number; y: number;
  w: number; h: number;
  rotation: 0 | 90 | 180 | 270;
  zIndex: number;
  locked?: boolean;
  visible?: boolean;
  printIf?: string;
  opacity?: number;
}

export interface TextElement extends BaseElement {
  type: 'text';
  text: string;
  font: {
    family: string; size: number;
    bold?: boolean; italic?: boolean; underline?: boolean;
    color: string; align?: 'left' | 'center' | 'right';
    vAlign?: 'top' | 'middle' | 'bottom';
    wrap?: boolean; lineHeight?: number; letterSpacing?: number;
  };
}

export interface LineElement extends BaseElement {
  type: 'line';
  /** 直线：x/y 是一端点，x2/y2 是另一端点 */
  x2: number; y2: number;
  stroke: { width: number; color: string; style: 'solid' | 'dashed' | 'dotted' };
}

export interface RectElement extends BaseElement {
  type: 'rect';
  fill?: string;
  stroke?: { width: number; color: string; style: 'solid' | 'dashed' | 'dotted' };
  cornerRadius?: number;
}

export interface EllipseElement extends BaseElement {
  type: 'ellipse';
  fill?: string;
  stroke?: { width: number; color: string; style: 'solid' | 'dashed' | 'dotted' };
}

export interface TableElement extends BaseElement {
  type: 'table';
  rows: number; cols: number;
  /** 每个单元格 content 支持 {{var}} */
  cells: string[];           // rows*cols 展开数组
  showBorder?: boolean;      // 表格线总开关
  borderWidth?: number;
  borderColor?: string;
  headerRow?: boolean;       // 首行表头
  headerBg?: string;
  font?: { family: string; size: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right' };
}

export interface ImageElement extends BaseElement {
  type: 'image';
  src: string;               // data: URL 或文件路径
  opacity?: number;
}

export interface BarcodeElement extends BaseElement {
  type: 'barcode';
  barcode: {
    sym: string; content: string;
    moduleWidthMm: number; wideRatio: number; heightMm: number;
    showText: boolean; textPosition: 'bottom' | 'top';
    checksum?: boolean;
  };
}

export interface QrcodeElement extends BaseElement {
  type: 'qrcode';
  qrcode: {
    sym: string; content: string;
    ecc: 'L' | 'M' | 'Q' | 'H';
    moduleSizeMm: number; quietZoneMm: number;
  };
}

export interface FormulaElement extends BaseElement {
  type: 'formula';
  formula: { expr: string; defaultOnError?: string };
  font: { family: string; size: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right' };
}

export interface SerialElement extends BaseElement {
  type: 'serial';
  serial: { sequenceRef: string; digits?: number; prefix?: string; suffix?: string };
  font: { family: string; size: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right' };
}

export interface DateTimeElement extends BaseElement {
  type: 'datetime';
  datetime: { pattern: string; source: 'print' | 'now' };
  font: { family: string; size: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right' };
}

export interface SysvarElement extends BaseElement {
  type: 'sysvar';
  sysvar: { key: string };   // printDate / pageNo / ...
  font: { family: string; size: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right' };
}

export type AnyElement =
  | TextElement | LineElement | RectElement | EllipseElement
  | TableElement | ImageElement
  | BarcodeElement | QrcodeElement | FormulaElement
  | SerialElement | DateTimeElement | SysvarElement;

/** 页面设置 */
export interface PageSettings {
  widthMm: number; heightMm: number; dpi: number;
  orientation: 0 | 90 | 180 | 270;
  unit: 'mm' | 'inch';
  columns?: number; rows?: number;
  gapXMm?: number; gapYMm?: number;
  marginMm?: number;
  copies?: number;
  duplex?: boolean;
}

/** 变量定义 */
export interface TemplateVariable {
  name: string;
  type: 'text' | 'number' | 'date' | 'boolean';
  defaultValue?: unknown;
  label?: string;
  required?: boolean;
}

/** 模板（设计器内存态） */
export interface DesignerTemplate {
  schemaVersion: number;
  page: PageSettings;
  variables: TemplateVariable[];
  elements: AnyElement[];
}

export type SysVarKey = 'printDate' | 'printTime' | 'pageNo' | 'pageTotal'
  | 'printerName' | 'tenantName' | 'printUser' | 'uuid';

export type DesignerAction =
  | { type: 'add'; element: AnyElement }
  | { type: 'remove'; id: string }
  | { type: 'update'; id: string; patch: Partial<AnyElement> }
  | { type: 'reorder'; id: string; zIndex: number }
  | { type: 'page'; patch: Partial<PageSettings> }
  | { type: 'var'; patch: TemplateVariable }
  | { type: 'batch'; actions: DesignerAction[] };
