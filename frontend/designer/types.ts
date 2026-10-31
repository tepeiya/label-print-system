// =============================================================================
// designer/types.ts —— 前端设计器核心数据结构
// 与后端模板 JSON Schema 一一对应；坐标/尺寸对外一律 mm。
// =============================================================================

/** 元素类型（12 类） */
export type ElementType =
  | 'text' | 'richtext' | 'image' | 'line' | 'rect' | 'ellipse'
  | 'table' | 'barcode' | 'qrcode' | 'formula' | 'serial'
  | 'datetime' | 'sysvar' | 'dbField';

/** 通用元素基类 */
export interface BaseElement {
  id: string;
  type: ElementType;
  name?: string;
  x: number; y: number;          // 左上角（mm）
  w: number; h: number;          // 尺寸（mm）
  rotation: 0 | 90 | 180 | 270;
  zIndex: number;
  locked?: boolean;
  visible?: boolean;             // 是否打印
  printIf?: string;              // 打印条件表达式
  border?: { width: number; color: string; style: 'solid' | 'dashed' | 'dotted' };
  opacity?: number;
}

export interface TextElement extends BaseElement {
  type: 'text';
  text: string;                  // 支持 {{var}}
  font: { family: string; size: number; bold?: boolean; italic?: boolean;
          underline?: boolean; color: string; lineHeight?: number;
          letterSpacing?: number; align?: 'left' | 'center' | 'right';
          vAlign?: 'top' | 'middle' | 'bottom'; wrap?: boolean;
          direction?: 0 | 90 | 180 | 270 };
}

export interface BarcodeElement extends BaseElement {
  type: 'barcode';
  barcode: { sym: string; content: string; moduleWidthMm: number; wideRatio: number;
             heightMm: number; showText: boolean; textPosition: 'bottom' | 'top';
             checksum?: boolean };
}

export interface QrcodeElement extends BaseElement {
  type: 'qrcode';
  qrcode: { sym: string; content: string; ecc: 'L' | 'M' | 'Q' | 'H';
            moduleSizeMm: number; quietZoneMm: number };
}

export type AnyElement = TextElement | BarcodeElement | QrcodeElement | BaseElement;

/** 页面设置 */
export interface PageSettings {
  widthMm: number; heightMm: number; dpi: number;
  orientation: 0 | 90 | 180 | 270; unit: 'mm';
  columns?: number; rows?: number; gapXMm?: number; gapYMm?: number;
  marginMm?: number; copies?: number; duplex?: boolean;
}

/** 模板（设计器内存态） */
export interface DesignerTemplate {
  schemaVersion: number;
  page: PageSettings;
  variables: TemplateVariable[];
  elements: AnyElement[];
  dataSources?: any[];
  print?: Record<string, any>;
}

export interface TemplateVariable {
  name: string; type: 'text' | 'number' | 'date' | 'boolean' | 'image';
  defaultValue?: unknown; required?: boolean;
  validation?: { pattern?: string; min?: number; max?: number; maxLength?: number };
}

/** 系统变量键 */
export type SysVarKey = 'printTime' | 'printDate' | 'pageNo' | 'pageTotal'
  | 'printerName' | 'tenantName' | 'printUser' | 'uuid';

/** 设计器操作（用于撤销/重做 diff） */
export type DesignerAction =
  | { type: 'add'; element: AnyElement }
  | { type: 'remove'; id: string }
  | { type: 'update'; id: string; patch: Partial<AnyElement> }
  | { type: 'reorder'; id: string; zIndex: number }
  | { type: 'batch'; actions: DesignerAction[] };
