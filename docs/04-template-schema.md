# 4. 模板 JSON Schema 定义与示例

> 模板 `content` 以 JSONB 存储，顶层结构如下。所有 `x/y/w/h` 单位为 **mm**（对外约定）。
> `schemaVersion` 用于导入时兼容迁移；`variables` 定义模板内变量；`elements` 为元素数组；
> `dataSources` 为绑定数据源；`print` 为默认打印参数。

## 4.1 顶层结构（TypeScript 类型）

```ts
interface LabelTemplate {
  schemaVersion: number;                 // 当前 1
  page: PageSettings;                    // 页面/纸张/多联设置
  variables: TemplateVariable[];         // 模板变量定义
  elements: ElementBase[];               // 元素列表（12 类，联合类型）
  dataSources?: DataSourceRef[];         // 可选数据源绑定
  print?: PrintDefaults;                 // 默认打印参数
  meta?: Record<string, unknown>;
}

interface PageSettings {
  widthMm: number;        // 标签宽（mm）
  heightMm: number;       // 标签高（mm）
  dpi: number;            // 目标 DPI（203/300/600），渲染基准
  orientation: 0 | 90 | 180 | 270;
  unit: 'mm';             // 逻辑单位恒为 mm
  // 每页多标签排布
  columns?: number;       // 列数
  rows?: number;          // 行数
  gapXMm?: number;        // 水平间距
  gapYMm?: number;        // 垂直间距
  marginMm?: number;      // 页边距
  // 多联/双面
  copies?: number;        // 默认份数
  duplex?: boolean;
}
```

## 4.2 元素基类与通用属性

```ts
interface ElementBase {
  id: string;                 // 元素唯一 id（uuid）
  type: ElementType;         // 'text'|'richtext'|'image'|'line'|'rect'|'ellipse'
                             // |'table'|'barcode'|'qrcode'|'formula'|'serial'
                             // |'datetime'|'sysvar'|'dbField'
  name?: string;
  x: number; y: number;       // 左上角（mm）
  w: number; h: number;       // 尺寸（mm）
  rotation: number;           // 旋转角度 0/90/180/270
  zIndex: number;             // 层级
  locked?: boolean;
  visible?: boolean;          // 是否打印（false 则不输出）
  printIf?: string;           // 打印条件表达式，为真才输出；空=始终输出
  // 外观通用
  border?: { width: number; color: string; style: 'solid'|'dashed'|'dotted' };
  opacity?: number;           // 0-1
}
```

## 4.3 变量定义

```ts
interface TemplateVariable {
  name: string;               // 占位 {{name}}
  type: 'text'|'number'|'date'|'boolean'|'image';
  defaultValue?: unknown;
  required?: boolean;
  validation?: {              // 校验规则
    pattern?: string;         // 正则
    min?: number; max?: number;
    maxLength?: number;
  };
  source?: 'manual'|'import'|'datasource'|'default'; // 优先级由引擎按 manual>import>ds>default
}
```

## 4.4 各元素专属属性（节选）

```ts
// 文本
interface TextElement extends ElementBase {
  type: 'text';
  text: string;               // 支持 {{var}} 占位
  font: { family: string; size: number; bold?: boolean; italic?: boolean;
          underline?: boolean; color: string; lineHeight?: number;
          letterSpacing?: number; align?: 'left'|'center'|'right';
          vAlign?: 'top'|'middle'|'bottom'; wrap?: boolean;
          direction?: 0|90|180|270 };
}
// 条码
interface BarcodeElement extends ElementBase {
  type: 'barcode';
  barcode: {
    sym: 'CODE128'|'CODE39'|'EAN13'|'UPC_A'|'ITF14'|'GS1_128'|'CODABAR'|'MSI';
    content: string;          // 支持 {{var}} 与公式
    moduleWidthMm: number;    // 窄条宽
    wideRatio: number;        // 宽窄比（2-3）
    heightMm: number;
    showText: boolean;
    textPosition: 'bottom'|'top';
    textFont?: { size: number; family: string };
    checksum?: boolean;       // 是否自动校验位
  };
}
// 二维码
interface QrcodeElement extends ElementBase {
  type: 'qrcode';
  qrcode: {
    sym: 'QR'|'MICRO_QR'|'DATAMATRIX'|'PDF417'|'AZTEC';
    content: string;
    ecc: 'L'|'M'|'Q'|'H';
    moduleSizeMm: number;
    quietZoneMm: number;      // 静区
  };
}
// 流水号
interface SerialElement extends ElementBase {
  type: 'serial';
  serial: {
    sequenceRef: string;      // 关联 serial_sequences.name 或 uuid
    displayFormat?: string;   // 覆盖前缀/位数展示
  };
}
// 公式
interface FormulaElement extends ElementBase {
  type: 'formula';
  formula: { expr: string; font?: TextElement['font'] }; // expr 如 IF(len({{sku})>6,'A','B')
}
// 日期/系统变量/数据库字段：分别用 datetime/sysvar/dbField + 各自配置
```

## 4.5 完整示例模板（商品标签：含文本/条码/二维码/流水号/系统变量）

```json
{
  "schemaVersion": 1,
  "page": {
    "widthMm": 60, "heightMm": 40, "dpi": 300, "orientation": 0,
    "unit": "mm", "columns": 1, "rows": 1, "gapXMm": 0, "gapYMm": 0,
    "marginMm": 1, "copies": 1, "duplex": false
  },
  "variables": [
    { "name": "sku",      "type": "text",  "required": true, "defaultValue": "" },
    { "name": "product",  "type": "text",  "required": true, "defaultValue": "示例商品" },
    { "name": "price",    "type": "number","defaultValue": 0 },
    { "name": "mfgDate",  "type": "date",  "defaultValue": "" }
  ],
  "elements": [
    {
      "id": "el-title", "type": "text", "x": 2, "y": 2, "w": 56, "h": 8,
      "rotation": 0, "zIndex": 1,
      "text": "{{product}}",
      "font": { "family": "Microsoft YaHei", "size": 12, "bold": true,
                "color": "#000000", "align": "center", "vAlign": "middle", "wrap": true }
    },
    {
      "id": "el-sku", "type": "text", "x": 2, "y": 12, "w": 56, "h": 6,
      "rotation": 0, "zIndex": 2,
      "text": "SKU: {{sku}}  价格: ¥{{price}}",
      "font": { "family": "Arial", "size": 9, "color": "#222222", "align": "left" }
    },
    {
      "id": "el-barcode", "type": "barcode", "x": 4, "y": 20, "w": 52, "h": 10,
      "rotation": 0, "zIndex": 3,
      "barcode": {
        "sym": "CODE128", "content": "{{sku}}", "moduleWidthMm": 0.25,
        "wideRatio": 2.5, "heightMm": 10, "showText": true,
        "textPosition": "bottom", "textFont": { "size": 8, "family": "Arial" },
        "checksum": true
      }
    },
    {
      "id": "el-qr", "type": "qrcode", "x": 42, "y": 2, "w": 16, "h": 16,
      "rotation": 0, "zIndex": 4,
      "qrcode": {
        "sym": "QR", "content": "https://example.com/p/{{sku}}",
        "ecc": "M", "moduleSizeMm": 0.5, "quietZoneMm": 2
      }
    },
    {
      "id": "el-serial", "type": "serial", "x": 2, "y": 32, "w": 40, "h": 5,
      "rotation": 0, "zIndex": 5,
      "serial": { "sequenceRef": "SN_PRODUCT", "displayFormat": "NO.{value}" }
    },
    {
      "id": "el-sys", "type": "sysvar", "x": 2, "y": 37, "w": 56, "h": 3,
      "rotation": 0, "zIndex": 6,
      "sysvar": { "key": "printTime", "format": "YYYY-MM-DD HH:mm" }
    }
  ],
  "print": { "copies": 1, "rotate": 0, "mirror": false, "preview": true }
}
```

## 4.6 导入兼容迁移

导入时按 `schemaVersion` 路由迁移函数：

```ts
const migrators: Record<number, (t: any) => any> = {
  // 0->1: 旧版无 orientation 字段，补默认 0
  0: (t) => ({ ...t, page: { ...t.page, orientation: t.page.orientation ?? 0 }, schemaVersion: 1 }),
};
function migrate(raw: any): LabelTemplate {
  let t = raw;
  while (t.schemaVersion < CURRENT_SCHEMA_VERSION) t = migrators[t.schemaVersion](t);
  return t;
}
```
