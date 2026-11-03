# 9. AI 标签图片 → 模板自动生成

> 核心诉求：用户上传一张实拍/扫描的成品标签图片，选好标签宽高 mm，系统**全自动**生成一份可编辑的 LabelTemplate JSON，
> 其中文本/条码/二维码/表格/线条/图片/流水号/变量/常量 已被正确识别并归类。
> 生成后用户只需要导入 Excel，就能直接批量打印。

---

## 9.1 功能矩阵

| 能力 | 优先级 | 说明 |
| --- | --- | --- |
| 用户上传标签图片（jpg/png/webp/tiff） | P0 | 支持单张上传 |
| 指定标签物理尺寸（宽 × 高 mm + DPI） | P0 | 精确换算像素 → mm |
| OCR 文本提取（含中英文 + 数字 + 符号） | P0 | 行级 + 字级坐标 |
| 一维/二维条码自动定位 + 解码 | P0 | 内容 + 类型（Code128 / EAN13 / QR / DataMatrix …） |
| 元素自动分类（常量 / 变量 / 流水号 / 图片 / 线条 / 矩形 / 表格） | P0 | 基于启发式 + Vision LLM |
| 元素坐标 mm 级换算 + 几何对齐 | P0 | 输出直接符合 ElementBase {x,y,w,h} |
| 表格结构识别（行/列/表头/合并单元格） | P1 | Vision LLM + 线检测辅助 |
| 变量命名与模板变量定义自动写入 | P1 | 从周围文本/形态推断变量名 |
| 模板 JSON 直出 LabelFlow schema | P0 | 直接 save 进 templates 表 |
| 置信度打分 + 人工校验界面 | P1 | 低置信度元素高亮让用户改 |
| 多联/多行列排布识别 | P2 | 一次上传多标签大图自动切分 |
| 历史模板作为 few-shot 参考 | P2 | 用户已有模板时复用其命名风格 |

---

## 9.2 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                      前端 AI 生成 Tab                                │
│  [📷 上传图片]  [📐 选尺寸 mm × mm] [🎯 识别 → 生成模板 → 载入画布] │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ POST /api/v1/ai-template/generate
                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Backend: AiTemplateService                        │
│                                                                      │
│  1. 文件接收 → 解码为 ImageData (RGBA Float32Array)                 │
│  2. 预处理：灰度化 / 透视矫正（可选） / 降噪 / 二值化                │
│  3. 条码/二维码定位+解码（ZXing）  ──────────────────► barcodes[]     │
│  4. 文本 OCR（PaddleOCR / EasyOCR） ──────────────────► texts[]      │
│  5. 几何原语：Hough 线检测 + 连通域 → lines[] / rects[] / images[]  │
│  6. Vision LLM 融合（多模态） ── 对齐 + 分类 + 变量命名 + 表格结构  │
│  7. 启发式分类器：常量 / 变量 / 流水号  ──────────────► variables[]   │
│  8. 坐标换算 px → mm (mm = px × 25.4 / userDpi)                     │
│  9. 对齐 + 去重 + 层级排序                                          │
│  10. 输出 LabelTemplate + confidence  + warnings                    │
└──────────────────────────────────────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    ┌─────────┐   ┌──────────┐  ┌─────────────────┐
    │  ZXing  │   │ PaddleOCR │  │  Vision LLM      │
    │ (barcode)│   │  (text)   │  │ (GPT-4o / Qwen  │
    └─────────┘   └──────────┘  │  VL / Llava)     │
                                └─────────────────┘
```

### 9.2.1 组件职责边界

| 组件 | 职责 | 选型说明 |
| --- | --- | --- |
| **ZXing / zxing-cpp / JPEG2000 + libdmtx** | 一维/二维码定位 + 解码 | 成熟、本地离线、支持 40+ 码制。ZXing 原生支持 QR/DataMatrix/PDF417/EAN/Code128 等；Code39 有坑需注意校验位；Aztec 需额外库。**首选 ZXing + dmtx-rust** 组合 |
| **OCR** | 文字识别（行级 + 字级坐标） | 三种路径：(A) PaddleOCR 本地服务（Python + ONNX，精度最好）；(B) EasyOCR（Python pip install，多语言）；(C) 纯前端 tesseract.js（无需部署但精度一般）。**推荐 PaddleOCR 作为服务**，后端 HTTP 调用，fallback 到 tesseract.js |
| **几何原语** | 线条、矩形、圆检测 | OpenCV HoughLinesP + findContours。Node 侧可用 `opencv4nodejs` 或**纯 CPU 手写 Hough（400 行代码）** 避免原生依赖。表格网格从水平线 + 垂直线交叉推断 |
| **Vision LLM** | 全局语义 + 对齐 + 分类 + 变量命名 | 输入：预处理后的标签图 + OCR + 条码 + 几何 JSON 作为 context。输出：结构化 JSON（见 §9.3 输出契约）。可用 OpenAI GPT-4o / 阿里 Qwen-VL / 智谱 GLM-4V / 本地 Llava-v1.6-70B。**建议支持配置化切换** |
| **启发式分类器** | 常量 vs 变量 vs 流水号 | 纯规则引擎（§9.4），不依赖 LLM，先跑规则再由 LLM 修正 |

---

## 9.3 输出契约（LabelTemplate 直出）

AI 生成的 JSON **直接符合** 4.1 节 LabelTemplate 定义，可以不经任何转换直接 `POST /templates`。
额外包含一个 `meta.aiGenerate` 字段，前端用来做"置信度高亮 + 人工校验"。

```ts
interface AiTemplateGenerateResponse {
  // ---- 主产物：直接可保存的模板 ----
  template: LabelTemplate;

  // ---- 辅助信息 ----
  meta: {
    /** 生成耗时 ms */
    elapsedMs: number;
    /** 使用的模型标识，如 "qwen-vl-max-202509" */
    model: string;
    /** 输入图原始尺寸 px */
    inputImagePx: { w: number; h: number };
    /** 用户指定的物理尺寸 mm */
    targetMm: { w: number; h: number; dpi: number };

    /** 每个元素的置信度（0-1），前端可按阈值高亮让用户人工校验 */
    confidence: Record<string, number>;  // key = element.id

    /** LLM 无法确定或需要用户确认的点 */
    warnings: AiWarning[];

    /** AI 建议的变量名/流水号名，以及推荐理由 */
    variableHints: VariableHint[];
  };
}

interface AiWarning {
  level: 'low' | 'medium' | 'high';
  elementId?: string;
  message: string;        // 自然语言描述
  suggestion?: string;    // 可选建议值
}

interface VariableHint {
  elementId: string;
  suggestedName: string;        // 如 "productName" / "serialNo" / "date"
  reason: string;               // 为什么这么命名
  category: 'constant' | 'variable' | 'serial' | 'datetime' | 'sysvar' | 'image';
}
```

### 9.3.1 输出示例（从"一张成品标签图"生成）

> 字段以 `web/js/model.js` 中 `createElement()` 实际产物为准（前端渲染器直接消费），
> 与 `04-template-schema.md` 的抽象 schema 保持一致但更具体。**AI 生成必须直接产出这个形状**，
> 前端可零转换载入画布。

```json
{
  "template": {
    "schemaVersion": 1,
    "page": {
      "widthMm": 100, "heightMm": 60, "dpi": 300,
      "orientation": 0, "unit": "mm",
      "columns": 1, "rows": 1, "gapXMm": 2, "gapYMm": 2, "marginMm": 0,
      "copies": 1, "duplex": false,
      "mediaType": "gap", "gapMm": 2, "blackMarkMm": 3,
      "offsetXMm": 0, "offsetYMm": 0, "calibrateXMm": 0, "calibrateYMm": 0,
      "guides": []
    },
    "variables": [
      { "name": "productName", "type": "text",   "label": "产品名",   "defaultValue": "有机苹果", "required": true, "unique": false },
      { "name": "expiryDate",  "type": "date",   "label": "保质期",   "defaultValue": "",        "required": true, "unique": false },
      { "name": "batchNo",     "type": "text",   "label": "批号",     "defaultValue": "",        "required": true, "unique": true  },
      { "name": "serialNo",    "type": "text",   "label": "流水号",   "defaultValue": "000001",  "required": true, "unique": true  }
    ],
    "elements": [
      {
        "id": "a1f2c3", "type": "text",
        "x": 5, "y": 5, "w": 60, "h": 10,
        "rotation": 0, "zIndex": 1, "locked": false, "visible": true, "opacity": 1,
        "text": "Apple Co., Ltd.",
        "font": { "family": "Arial", "size": 12, "color": "#000000", "bold": true,
                  "italic": false, "align": "left", "vAlign": "middle", "wrap": true }
      },
      {
        "id": "b2e4d6", "type": "text",
        "x": 5, "y": 18, "w": 70, "h": 6,
        "rotation": 0, "zIndex": 2, "locked": false, "visible": true, "opacity": 1,
        "text": "{{productName}}",
        "font": { "family": "Arial", "size": 9, "color": "#000000", "bold": false,
                  "italic": false, "align": "left", "vAlign": "middle", "wrap": true }
      },
      {
        "id": "c3g5f7", "type": "barcode",
        "x": 62, "y": 15, "w": 30, "h": 20,
        "rotation": 0, "zIndex": 3, "locked": false, "visible": true, "opacity": 1,
        "barcode": {
          "sym": "CODE128", "content": "{{serialNo}}",
          "moduleWidthMm": 0.25, "wideRatio": 2.5,
          "heightMm": 18, "showText": true, "textPosition": "bottom",
          "checksum": false, "quietZoneMm": 2,
          "textFont": { "family": "Arial", "size": 2.4 }
        }
      },
      {
        "id": "d4h6g8", "type": "qrcode",
        "x": 75, "y": 40, "w": 18, "h": 18,
        "rotation": 0, "zIndex": 4, "locked": false, "visible": true, "opacity": 1,
        "qrcode": {
          "sym": "QRCODE", "content": "https://example.com/trace/{{batchNo}}",
          "ecc": "M", "moduleSizeMm": 0.4, "quietZoneMm": 2, "version": 0
        }
      },
      {
        "id": "e5i7h9", "type": "line",
        "x": 5, "y": 35, "x2": 95, "y2": 35, "w": 90, "h": 0,
        "rotation": 0, "zIndex": 5, "locked": false, "visible": true, "opacity": 1,
        "stroke": { "width": 0.2, "color": "#000000", "style": "solid" }
      },
      {
        "id": "f6j8i0", "type": "text",
        "x": 5, "y": 38, "w": 40, "h": 5,
        "rotation": 0, "zIndex": 6, "locked": false, "visible": true, "opacity": 1,
        "text": "Best before: {{expiryDate}}",
        "font": { "family": "Arial", "size": 7, "color": "#000000", "bold": false,
                  "italic": false, "align": "left", "vAlign": "middle", "wrap": true }
      },
      {
        "id": "g7k9j1", "type": "image",
        "x": 75, "y": 5, "w": 18, "h": 14,
        "rotation": 0, "zIndex": 7, "locked": false, "visible": true, "opacity": 1,
        "src": "data:image/png;base64,iVBORw0KGgo…"
      }
    ]
  },
  "meta": {
    "elapsedMs": 2340,
    "model": "qwen-vl-max-202509",
    "inputImagePx": { "w": 1500, "h": 900 },
    "targetMm": { "w": 100, "h": 60, "dpi": 300 },
    "confidence": {
      "a1f2c3": 0.98, "b2e4d6": 0.91, "c3g5f7": 0.99,
      "d4h6g8": 0.97, "e5i7h9": 0.95, "f6j8i0": 0.88, "g7k9j1": 0.82
    },
    "warnings": [
      { "level": "medium", "elementId": "g7k9j1",
        "message": "Logo 区域从图片中切出，但背景可能残留",
        "suggestion": "上传带透明背景的 PNG" },
      { "level": "low", "message": "标签右侧有 ~3mm 白边未覆盖，是否裁剪？" }
    ],
    "variableHints": [
      { "elementId": "b2e4d6", "suggestedName": "productName",
        "reason": "周围是固定文本 'Product:'，下方出现多种品类名",
        "category": "variable" },
      { "elementId": "c3g5f7", "suggestedName": "serialNo",
        "reason": "连续编号，条码类型 CODE128 适合变长流水号",
        "category": "serial" },
      { "elementId": "d4h6g8", "suggestedName": "batchNo",
        "reason": "QR 码编码内容里有 trace/ABC12345，符合批次号格式",
        "category": "variable" }
    ]
  }
}
```

#### 关键字段约束（AI 输出必须遵守，否则前端渲染异常）

| 元素类型 | 必须字段 | 注意 |
| --- | --- | --- |
| `text` | `text` + `font{family,size,color,bold,align,vAlign,wrap}` | 字号单位是 **pt**（`font.size`），不是 mm；由渲染器按 DPI 换算 |
| `barcode` | `barcode{sym,content,moduleWidthMm,wideRatio,heightMm,showText,textPosition}` | `sym` 取值 `CODE128/CODE39/EAN13/UPC_A/ITF14/GS1_128/CODABAR/MSI` |
| `qrcode` | `qrcode{sym,content,ecc,moduleSizeMm}` | `sym` 固定为 **`QRCODE`**（不是 `QR`）；纠错级字段名是 **`ecc`**（不是 `errorLevel`） |
| `serial` | `serial{sequenceRef,digits,prefix,suffix}` + `font` | 通过 `sequenceRef` 关联 `serial_sequences`；AI 只给格式，真实号段由后端分配 |
| `line` | `x,y,x2,y2` + `stroke{width,color,style}` | **用端点坐标**，不是 w/h；w/h 仅供选中框计算（可留 0） |
| `rect` / `ellipse` | `fill` + `stroke{width,color,style}` | 纯装饰或表格外框 |
| `table` | `rows,cols,cells[],showBorder,borderWidth,borderColor,headerRow,headerBg,font` | `cells` 是 **扁平数组**（行优先，长度 = rows × cols） |
| `image` | `src` | 支持 `data:image/...;base64,` 内联；大图走 `template_assets` 表 |

---

## 9.4 核心算法：元素分类启发式（不依赖 LLM 也能跑到 70% 准确率）

在调 Vision LLM 之前先跑一遍纯规则，结果传给 LLM 当"先验"，既省钱又提升稳定性。

### 9.4.1 条码/二维码

ZXing 定位 + 解码后，根据 **内容 + 周围文本** 分类：

| 模式 | 判断规则 | 分类 |
| --- | --- | --- |
| 解码内容匹配纯数字连续递增（或用户提供示例值序列） | 流水号 | `serial` |
| 解码内容是 URL / JSON / UUID / traceId | 数据源字段 | `variable` |
| 解码内容与周围文本高度相似（= 常量） | 常量 | `constant` |
| 解码内容包含 `{{placeholder}}` 形态（原始模板截图） | 保留为模板变量 | `variable` |
| 周围文本有 "批号 / 批次 / 日期 / 序列号 / Lot / SN / No." 等关键词 | 变量 + 从关键词推断命名 | `variable` 或 `serial` |

### 9.4.2 文本块

| 模式 | 判断规则 | 分类 |
| --- | --- | --- |
| 数字正则匹配日期（YYYY-MM-DD / MM/DD/YYYY / dd.MM.yyyy） | 日期 | `datetime` 或变量 |
| 数字正则匹配序列号（连续数字、补零位数固定、长度≥6） | 流水号 | `serial` |
| 数字正则匹配时间（HH:MM / HH:MM:SS） | 日期 | `datetime` |
| 纯数字，长度固定，周围是文本 | 可能是产品号/批次号 | `variable`（置信度中等） |
| 固定短文本且多次重复出现（如 "No." / "Batch:"） | 常量标签 | `constant` |
| 多语言长文本 | 常量正文 | `constant` |
| 原始图中能看到 `{{xxx}}` | 模板变量占位符 | `variable`，保留原变量名 |

### 9.4.3 几何原语

| 模式 | 判断规则 | 分类 |
| --- | --- | --- |
| HoughLines 提取的水平线/垂直线 | 线条元素 | `line` |
| findContours 提取的矩形（长宽比 ≥3 且长宽比固定） | 表格或装饰矩形 | 交给 LLM 判断 |
| findContours 提取的大面积纯色区域（非白/非黑） | 可能是 Logo 或产品图 | `image` |
| 连通域检测到圆形/椭圆 | 装饰或 logo | `ellipse` 或 `image` |

### 9.4.4 表格识别

表格需要水平 + 垂直两组线交叉：
1. 从 Canny 边缘图分别跑水平 / 垂直方向 HoughLines，取最长的 N 条
2. 交叉点做聚类，推断行列结构
3. 单元格内的文本合并为 `table` 元素，每格保留 OCR 内容

---

## 9.5 坐标换算（px → mm）

用户上传的图片像素尺寸已知；用户指定的物理尺寸（宽 × 高 mm）和 DPI 已知。

```
scale = userWidthMm / imagePixelWidth        // mm per px
// 或者
scale = 25.4 / userDpi                       // mm per dot（若用户提供的是 dot 尺寸）

element.xMm = element.xPx * scale
element.yMm = element.yPx * scale
element.wMm = element.wPx * scale
element.hMm = element.hPx * scale
```

> **边缘情况**：用户上传的图可能包含非标签背景（比如桌面上放着标签拍的照）。需要做：
> 1. **透视矫正**（可选增强，不做的话要求用户上传"标签满幅"的图）
> 2. 四边检测：识别四条黑色边框 → 裁出标签区域 → 再换算
> 3. **前端 DPI 自动推断**：用户选"标准 DPI"时按 203/300/600 走；也允许用户直接填 px-per-mm

### 9.5.1 输出尺寸精度

| 场景 | 目标精度 | 做法 |
| --- | --- | --- |
| 标准方形标签（快递面单/食品标签） | ±0.5mm | 透视矫正 + 边界检测 + 用户选 mm |
| 异形标签（圆/椭圆/不规则） | ±1mm | 边界检测 + 用户手动校准点 |
| 低清手机拍 | ±2mm | 提示用户"建议 ≥ 600 DPI 扫描图" |

---

## 9.6 Vision LLM Prompt 模板

### 9.6.1 输入给 LLM 的上下文（结构化，不是纯图）

```jsonc
{
  "image": "(预处理后 PNG base64，JPEG 压缩到 ≤ 1MB)",
  "userSpec": { "targetWidthMm": 100, "targetHeightMm": 60, "dpi": 300 },
  "priors": {
    "ocrLines": [
      { "text": "Apple Co., Ltd.",  "bboxPx": [50, 40, 600, 140] },
      { "text": "Product: 有机苹果", "bboxPx": [50, 180, 720, 240] },
      // ...
    ],
    "barcodes": [
      { "sym": "CODE128", "content": "8801234567", "bboxPx": [930, 250, 1500, 550] },
      { "sym": "QR",       "content": "https://example.com/trace/ABC12345", "bboxPx": [1120, 620, 1480, 980] }
    ],
    "geometries": [
      { "kind": "hline", "bboxPx": [50, 525, 1450, 530] },
      { "kind": "rect",  "bboxPx": [1120, 50, 1500, 260], "note": "纯色 logo 区域" }
    ]
  }
}
```

### 9.6.2 输出契约（必须严格）

要求 LLM 输出一个 JSON 对象，结构必须与 §9.3 的 `LabelTemplate` 一致，外加 `meta.aiGenerate`：

```
System: 你是一个专业的标签模板结构化工程师。你会得到一张标签图片、OCR 结果、条码解码结果、几何检测结果，
以及用户指定的标签物理尺寸。请输出一个 LabelFlow 模板 JSON（schemaVersion=1），
严格遵循 LabelTemplate schema（见 system prompt 附录）。所有 x/y/w/h 单位为 mm。

分类规则（你要做最终裁决，启发式可能判断错误）：
- 常量文本：内容固定不变，周围没有变化线索
- 变量： 出现在 "XXX: <value>" 这种键值对里；或内容在类似位置出现多种不同值
- 流水号：连续递增的编码；长度固定；经常出现在条码里
- 图片：不规则形状、彩色、不是文字不是条码的区域（如 logo、产品图）
- 线条/矩形/圆：纯色几何形状
- 表格：水平线+垂直线交叉形成网格

变量命名：
- 优先用周围标签：若左边/上方有 "产品名" 就叫 productName；"批号" 就叫 batchNo
- 否则按语义：expiryDate / serialNo / qrCodeUrl
- 日期一律叫 expiryDate 或 productionDate（区分用 default 值里有没有日期）

必须输出纯 JSON，不要 markdown，不要解释。

输出字段必须严格使用 §9.3.1「关键字段约束」表里的字段名，特别注意：
- 文本字号是 font.size（pt），不是 fontHeightMm
- 二维码 sym 固定 "QRCODE"，纠错级字段是 ecc
- 直线用 x/y/x2/y2 端点坐标 + stroke
- 表格 cells 是扁平数组（行优先）
- image 用 src（data URL），不是 image.src
```

### 9.6.3 输出后校验（防止 LLM 幻觉）

LLM 返回的 JSON **不能直接信任**，必须过一道 `validateAiTemplate()`：

| 校验项 | 失败处理 |
| --- | --- |
| JSON 可解析 | 5023 → 回退到启发式结果 |
| `schemaVersion === 1` | 强制覆写 |
| `page.widthMm/heightMm` 等于用户输入 | 强制覆写（防止 LLM 乱填） |
| 每个 element 有 `id` + `type` + `x/y/w/h` 数值 | 丢弃该元素并记 warning |
| `type` 在白名单内（text/line/rect/ellipse/table/image/barcode/qrcode/formula/serial/datetime/sysvar） | 丢弃 |
| `barcode.sym` / `qrcode.sym` 在允许枚举内 | 回落为 `CODE128` / `QRCODE` |
| `qrcode.ecc` 在 `L/M/Q/H` 内 | 回落 `M` |
| 元素坐标不超出 `page` 范围（允许 5% 溢出容差） | 自动 clamp 到边界 |
| `variables[].name` 无重复且符合 `^[A-Za-z_][A-Za-z0-9_]*$` | 重命名 `var1`、`var2`… |
| `elements` 中 `{{var}}` 引用的变量都在 `variables` 里声明 | 自动补声明（type=text, required=false） |

### 9.6.4 成本估算（按 Qwen-VL-Max）

| 模式 | 单张输入 | 单张输出 | 成本估算 |
| --- | --- | --- | --- |
| 仅图（OCR 由 OCR 引擎完成） | ~500 tokens | ~1500 tokens | ≈ ¥0.015 / 张 |
| 图 + OCR + 条码 + 几何 JSON 先验 | ~2000 tokens | ~1500 tokens | ≈ ¥0.02 / 张 |
| 多标签拼图 10 联 | ~2000 tokens | ~5000 tokens | ≈ ¥0.05 / 张 |

**先跑启发式再调 LLM 可以节省 ~70% token** —— 启发式结果已经给出了大部分分类，LLM 主要负责修正和变量命名。

---

## 9.7 后端 API 设计

### 9.7.1 路由

```
POST /api/v1/ai-template/generate        # 主入口：上传 + 生成
GET  /api/v1/ai-template/status/:jobId  # 异步查询（大图走异步）
POST /api/v1/ai-template/save            # 用户在前端校验后保存为正式模板

(admin) DELETE /api/v1/ai-template/models/:id  # 删除 LLM 配置
```

### 9.7.2 主入口请求体

```jsonc
// multipart/form-data
{
  "image":                "(文件，必填，≤ 10MB，jpg/png/webp)",
  "targetWidthMm":        100,        // 必填
  "targetHeightMm":       60,         // 必填
  "dpi":                  300,         // 必填
  "backgroundType":       "auto"|"white"|"transparent",  // 可选，默认 auto
  "tagMode":              "single"|"multi",             // 可选，默认 single
  "variableHintKeywords": ["批号","序列号","日期"],        // 可选，用户已知的变量关键词
  "serialHint":           { "prefix": "", "digits": 6 }   // 可选，用户已知的流水号格式
}
```

### 9.7.3 主入口响应

同步返回（小图 ≤ 3MB 建议同步；大图返回 202 + jobId）：
- **200** → 直接返回 §9.3 的 `AiTemplateGenerateResponse`
- **202** → `{ jobId: "xxx", status: "queued", estimatedMs: 5000 }`
- **400** → `{ code: 4001, message: "仅支持 jpg/png/webp", detail: "..." }`
- **400** → `{ code: 4002, message: "缺少 targetWidthMm" }`
- **413** → `{ code: 4003, message: "图片超限 10MB" }`
- **502** → `{ code: 5021, message: "Vision LLM 服务不可用" }`
- **502** → `{ code: 5022, message: "OCR 服务不可用" }`

### 9.7.4 Module 结构

```
backend/src/ai-template/
├── ai-template.module.ts
├── ai-template.controller.ts
├── ai-template.service.ts        # 主流程编排
├── preprocessing.ts              # 解码 + 预处理（灰度/二值/透视）
├── barcode-decoder.ts            # 包装 ZXing，bbox + 内容 + 类型
├── ocr-adapter.ts                # PaddleOCR / EasyOCR / tesseract.js 切换
├── geometry.ts                   # Hough + findContours（纯 CPU）
├── heuristics.ts                 # §9.4 分类规则引擎
├── vision-llm-adapter.ts         # GPT-4o / Qwen-VL / Llava 切换
├── coords-transform.ts           # px → mm
└── ai-template.entity.ts         # job 表（异步用）
```

### 9.7.5 数据库

完整 DDL 已写入 `docs/03-database.sql` 第 8.5 节，此处为摘要：

```sql
-- 生成任务（大图 / 异步场景）
CREATE TABLE ai_template_jobs (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL,            -- 租户隔离字段
  status        VARCHAR(20) NOT NULL        -- queued/running/done/failed
                CHECK (status IN ('queued','running','done','failed')),
  image_path    TEXT,                       -- 临时存储路径（24h 定时清理）
  image_bytes   BIGINT,
  params        JSONB NOT NULL DEFAULT '{}',-- 用户输入：尺寸/DPI/tagMode/...
  result        JSONB,                      -- §9.3 响应体
  error_msg     TEXT,
  elapsed_ms    INTEGER,
  model         VARCHAR(120),
  created_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

-- LLM 配置（用户可切换模型 / 自定义 API Key）
CREATE TABLE ai_model_configs (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL,            -- 租户隔离字段
  name          VARCHAR(60) NOT NULL,       -- "qwen-vl-max" / "gpt-4o-vision" / "llava-local"
  provider      VARCHAR(40) NOT NULL
                CHECK (provider IN ('qwen','openai','zhipu','ollama','custom')),
  api_endpoint  TEXT,
  api_key_enc   TEXT,                       -- AES-GCM 加密，复用 datasource/sql-crypto.ts
  model_id      VARCHAR(120) NOT NULL,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  settings      JSONB NOT NULL DEFAULT '{}',-- temperature / max_tokens / prompt_override
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_aimodel_tenant_name UNIQUE (tenant_id, name)
);
```

> 表名统一 `ai_` 前缀；`ai_template_jobs` 的 `result` 直接存 §9.3 完整响应，便于前端重放与问题复现。

---

## 9.8 前端设计

### 9.8.1 新 Tab

在现有 6 个 tab 基础上加第 7 个：`🎨 AI 生成`。AI 生成的模板自动载入现有 design tab，用户可以**继续手动微调** —— 设计器画布不做任何改动。

### 9.8.2 流程

```
┌─────────────────────────────────────────────────────────────────┐
│ 🎨 AI 生成                                                       │
│                                                                  │
│  Step 1  上传图片  ──▸  (拖拽区 + 选择按钮 + 预览)              │
│                                                                  │
│  Step 2  指定尺寸                                                │
│    宽 [100] mm    高 [60] mm   DPI [300 ▼]                      │
│    (可选) 变量关键词: 批号,序列号,日期                             │
│                                                                  │
│  Step 3  🚀 识别 → 生成模板                                      │
│                                                                  │
│  Step 4  置信度校验（可跳过）                                     │
│    ┌────────┬──────────┬──────────┬─────────┬──────┐            │
│    │ 元素   │ 识别结果  │ AI 建议   │ 置信度  │ 操作 │            │
│    ├────────┼──────────┼──────────┼─────────┼──────┤            │
│    │ text   │ Apple... │ constant  │ 0.98    │ ✓   │            │
│    │ barcode│ CODE128 │ serialNo  │ 0.99    │ ✓   │            │
│    │ text   │ Best bef │ expiryDate│ 0.88    │ ✎   │            │
│    └────────┴──────────┴──────────┴─────────┴──────┘            │
│                                                                  │
│  [✅ 确认并载入画布]   [↩️ 重新生成]   [💾 直接保存到模板库]       │
└─────────────────────────────────────────────────────────────────┘
```

### 9.8.3 画布上的置信度高亮

载入 design tab 后，置信度 < 0.9 的元素：
- 外层显示虚线橙色边框 + 小问号图标
- 点击问号弹出 AI 的 `meta.warnings` 和 `meta.variableHints`
- 用户可以快速改"这个元素应该是什么"，前端调用 `ai-template/regenerate-element?elementId=xx`（独立重算，不重跑整图）

---

## 9.9 边界与已知局限性

| 场景 | 能力 | 降级策略 |
| --- | --- | --- |
| 手绘图 / 素描 | ❌ 无法识别几何结构 | 提示"AI 识别不出手绘，请用扫描件或清晰照片" |
| 彩色渐变 / 艺术字 / 书法 | ⚠️ 只能抓到 OCR 文字内容，字体样式丢失 | 保留内容，提醒用户调整样式 |
| 完全空白 / 白底 / 低对比度 | ⚠️ OCR 漏字；几何漏线 | 预处理增强对比度；提示用户"提高扫描质量" |
| 异形标签（圆 / 三角 / 任意裁切） | ⚠️ 坐标换算需要透视矫正 | 提示用户填写标签四角手动校准 |
| 扫描图含噪音 / 折痕 / 污渍 | ⚠️ 可能误检为线条/元素 | 预处理降噪（median blur + despeckle）；低置信度元素由用户裁剪 |
| 同一元素既像条码又像二维码 | ✅ ZXing 两种都尝试，取"可解码且码制合法"的那个 | — |
| 用户不上传图，直接要 AI 凭空造一个 | ❌ 不支持 | 这是另一项功能"AI 描述生成模板"，需要 LLM 纯 text → JSON |
| 网络完全隔离 / 无法访问外部 LLM | ⚠️ 只能跑启发式（§9.4），变量命名质量下降 | 提示用户"请配置 Vision LLM"；可以先跑启发式出一个"可用但命名粗糙"的模板 |

---

## 9.10 分阶段实施

| 阶段 | 范围 | 关键交付 | 工时（1 人） |
| --- | --- | --- | --- |
| **P0-MVP** | 上传 → ZXing 条码 → OCR 文本 → 启发式分类 → px→mm → 直出 JSON（**不调 LLM**） | 能跑通闭环、变量命名按周围关键词硬规则、可用度 ~60% | 4 天 |
| **P1-Vision** | 接入 Vision LLM → 启发式先验作为 context → LLM 输出对齐 + 命名 → `meta.warnings` + 置信度 → 前端置信度校验 UI | 可用度升到 ~90%、变量命名语义正确、表格结构识别 | 5 天 |
| **P1-Robust** | 透视矫正 / 四边边界检测 / 多标签拼图自动切分 / 图片内 logo 区域切出 | 异形标签、多联标签可用 | 3 天 |
| **P2-Expand** | LLM 配置化（支持用户自带 API Key / 本地 Llama） / 异步队列（大图） / 历史模板 few-shot | SaaS 化、多模型竞争 | 3 天 |
| **P2-Alternative** | **不依赖图片**：用户描述产品 → LLM 凭空生成模板（"帮我做一个 50×30 mm 的食品标签，有公司名 + 产品名 + 批号 QR 码 + EAN13"） | 纯文本生成模板，和图片生成共享同一输出契约 | 2 天 |
| **P2-Regenerate** | `POST /ai-template/regenerate-element` —— 用户改某个元素时只重算这一个，不重跑整图 | 修一个元素不耗 token | 1 天 |
| **测试** | 100 张真实标签图回归（覆盖食品/药品/物流/电子）、单元测试、E2E | 可用度 ≥ 95% | 3 天 |
| **合计** | | | **约 21 人日（1 个月左右）** |

> **建议落地顺序**：P0-MVP 先跑通，马上能在 1 周内看到效果；P1-Vision 接 LLM 提升命名质量；之后再按用户反馈排 P1-Robust。

---

## 9.11 测试矩阵

### 9.11.1 真实标签图回归用例（需要积累 100+ 张）

| # | 类别 | 图样例 | 验收 |
| --- | --- | --- | --- |
| T-01 | 食品保质期标签 | 白底 + 黑字 + 一条 CODE128 + 一个 QR | 条码码制正确、流水号/批次号/日期都识别对 |
| T-02 | 药品外盒标签 | 中文药名 + EAN-13 + 生产日期 + 批号 | EAN-13 校验位正确、日期字段分类对 |
| T-03 | 物流面单 | 大尺寸 100×150mm + DataMatrix + 多行文本 | DataMatrix 正确、多行文本按行正确摆放 |
| T-04 | 电子元件标签 | 高密度小字 + 细线条分割 + 二维码 | 细线条识别对、网格结构识别对 |
| T-05 | 异形标签（圆形） | 圆标签 50mm 直径 | 透视矫正正确、元素坐标落在圆内 |
| T-06 | 低质手机拍照 | 室内光线 + 折痕 + 低 DPI | 至少能识别出条码区域；低置信度元素正确标注 |
| T-07 | 纯手写/草图 | 手绘框 + 手写数字 | 明确返回 warnings 不生成，或只出低置信度占位 |

### 9.11.2 单元测试要点

```ts
// coords-transform.test.ts
assert.equal(pxToMm({ wPx: 1500, wMm: 100 })(150), 10);  // 150px = 10mm

// heuristics.test.ts
assert.equal(classifyText("2024-12-31"), "datetime");
assert.equal(classifyText("ABC12345"), "variable");     // 批号格式
assert.equal(classifyText("8801234567"), "serial");     // EAN 风格连续码

// sql-executor 类似：assert 禁止多语句、禁止 INSERT
// vision-llm-adapter.test.ts：mock LLM 返回固定 JSON，确保格式符合契约
```

### 9.11.3 性能指标

| 场景 | 目标 |
| --- | --- |
| P0-MVP（不调 LLM）单张 2MB | < 1.5s |
| P1-Vision 单张 2MB（含 LLM 响应） | < 5s |
| 100 张批量（异步队列） | ≤ 10min |
| 失败重试（Vision LLM 超时/错误） | 自动重试 1 次 + 回退启发式 |

### 9.11.4 安全

| 项 | 措施 |
| --- | --- |
| 图片上传限制 | ≤ 10MB、白名单后缀 `jpg/jpeg/png/webp/tiff`、真实 MIME 二次校验、写入临时目录并设置定时清理（24h） |
| API Key 加密 | Vision LLM 的 API Key 用 AES-GCM 加密后存 DB（复用 `sql-crypto.ts` 的 encrypt/decrypt） |
| 外部 LLM 调用超时 | 15s connect / 60s total，超时抛 502，不阻塞后续请求 |
| 成本护栏 | 每租户每天最多 50 次 Vision LLM 调用（可配），超过后只跑启发式 |

---

## 9.12 参考实现 / 竞品调研

| 产品 | 能力 | 优势 | 局限 |
| --- | --- | --- | --- |
| **NiceLabel Design AI** | 上传图 → 生成模板结构 | 商用成熟 | 封闭、贵、中文支持弱 |
| **Labelary Label Recognition** | ZPL 标签图 → ZPL 指令反向解析 | ZPL 生态友好 | 只支持 ZPL 输出 |
| **Stable Diffusion + ControlNet** | text → 标签图（正向） | 创意无限 | 不能结构化输出元素 |
| **GPT-4o / Qwen-VL** | 图 → JSON（任何结构） | 通用、可扩展 | 需自己做几何定位、费用不可忽略 |
| **PaddleOCR + ZXing + OpenCV** | 纯规则 → 结构化 | 本地离线、免费 | 分类和变量命名需要额外 LLM 或规则 |

**本方案的核心优势**：组合了规则引擎（免费、稳定）+ Vision LLM（语义、命名）+ 启发式先验（降 token 降成本），在精度、成本、可控性三者之间走平衡路线。

---

## 9.13 实现落地说明（P0-MVP + P1-Vision 已交付）

### 9.13.1 技术选型落地结果

| 环节 | 设计文档原方案 | 实际实现 | 原因 |
| --- | --- | --- | --- |
| 条码/二维码 | ZXing | **`zxing-wasm`**（zxing-cpp 的 WASM 版） | 纯 JS 版 `@zxing/library` 实测 EAN13 / DataMatrix / Code93 全部识别失败；`zxing-wasm` 上述码制全部命中，且支持一次返回多个符号 + 四角坐标 |
| OCR（首选） | PaddleOCR 服务 | **PaddleOCR HTTP**（`OCR_ENDPOINT`） | 精度最好，按用户要求作为首选；契约兼容 PaddleOCR / RapidOCR 多种返回形状 |
| OCR（兜底） | tesseract.js | **`tesseract.js` 本地** | PaddleOCR 服务未部署时自动回落，零外部依赖；字级 bbox + 置信度均可用 |
| 几何检测 | OpenCV Hough | **纯 CPU 手写**（行/列扫描 + 连通域） | 避免 opencv 原生依赖；实测可正确提取分隔线/表格框线，并能识别「密集竖线簇」反推未解码的一维码区域 |
| Vision LLM | GPT-4o / Qwen-VL | **OpenAI 兼容协议** | 按用户要求走 OpenAI 通用模型；`baseURL + apiKey + model` 可指向任何兼容网关（Qwen / 智谱 / Ollama / 自建） |
| 图片解码 | node-canvas | **`sharp`** | 安装体积小、性能好；`flatten()` 处理透明底（否则整图变黑导致解码失败） |

### 9.13.2 后端文件清单

```
backend/src/ai-template/
├── ai-template.module.ts          # 模块注册（AiTemplateJob / AiModelConfig / Template）
├── ai-template.controller.ts      # 7 个路由（generate/save/jobs/models CRUD+test）
├── ai-template.service.ts         # 主流程编排 + 置信度继承 + 落库 + 审计
├── barcode-reader.ts              # zxing-wasm 封装（整图扫 + 2×2/3×3 分块提召回 + 去重）
├── ocr-adapter.ts                 # PaddleOCR HTTP → tesseract.js 兜底（worker 复用）
├── geometry.ts                    # Otsu 二值化 + 长直线检测 + 彩色连通域
├── heuristics.ts                  # 分类规则引擎 + 条码区域抑制 + px→mm 组装
├── coords-transform.ts            # px→mm、字号 pt 估算、模块宽估算
├── prompt.ts                      # System prompt（含完整字段契约）+ User prompt（先验）
├── vision-llm.ts                  # OpenAI 兼容 /chat/completions + 图片压缩 + JSON 提取
└── validate-ai-template.ts        # LLM 输出校验（类型白名单/坐标 clamp/变量补全）
```

### 9.13.3 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `OCR_ENDPOINT` | PaddleOCR HTTP 服务地址（POST multipart `file`）。不配置则用本地 tesseract.js | 空 |
| `OCR_LANG` | tesseract 语言，支持 `eng+chi_sim` | `eng+chi_sim` |
| `OPENAI_API_KEY` | OpenAI 兼容接口密钥（也可在「AI 模型」中保存到 DB） | 空 |
| `OPENAI_BASE_URL` | 接口基址 | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | 模型名 | `gpt-4o` |
| `SQL_SECRET_KEY` | 复用 SQL 数据源密钥加密 AI API Key | dev key |

> 模型配置优先读 DB 中 `is_default=true` 的 `ai_model_configs` 记录，其次读环境变量。
> 两者都没有时，`/ai-template/generate` 只跑规则引擎，并在 `meta.warnings` 中显式提示。

### 9.13.4 tesseract 语言包

语言包放在 `backend/assets/tessdata/`（`eng.traineddata.gz`、`chi_sim.traineddata.gz`），
构建后路径为 `backend/dist/` 同级，代码中按 3 个候选路径自动探测，兼容 `tsx` 直跑与 `node dist` 两种启动方式。

> 语言包约 30MB，**不纳入 Git**（见 `.gitignore`）。新环境首次部署需执行：
>
> ```bash
> mkdir -p backend/assets/tessdata
> curl -L -o backend/assets/tessdata/eng.traineddata.gz     https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz
> curl -L -o backend/assets/tessdata/chi_sim.traineddata.gz https://tessdata.projectnaptha.com/4.0.0/chi_sim.traineddata.gz
> ```
>
> 若已部署 PaddleOCR 服务（配置 `OCR_ENDPOINT`），可跳过此步骤。

### 9.13.5 实测效果（合成标签：800×400 px → 100×50 mm）

| 输入 | 结果 |
| --- | --- |
| `EAN13 6901234567892` | 识别为 `EAN13` → 变量 `barcodeNo`（商品条码） |
| `Code128 8801234567` | 识别为 `Code128` → 变量 `serialNo`（流水号） |
| `Product: Organic Apple` | → `Product: {{productName}}` |
| `Lot: LOT20241103` | → `Lot: {{batchNo}}` |
| `Exp: 2026-12-31` | → `Exp: {{expiryDate}}`（type=date） |
| `Weight: 500g` | → `Weight: {{weight}}` |
| 分隔线 / 表格框线 | 识别为 6 个 `line` 元素（条码竖条被正确抑制） |
| 条码下方明文 | 被抑制（由条码自身 `showText` 输出，避免重复元素） |
| 耗时 | 约 1.2s（本地 OCR，不含 LLM） |

### 9.13.6 已知待办（P1-Robust / P2）

| 项 | 状态 |
| --- | --- |
| 透视矫正 / 四边检测 | 未实现（当前要求上传满幅标签图） |
| 表格结构识别（合并单元格） | 未实现（当前只输出线段，交给 LLM 或人工调整） |
| 多联拼图自动切分 | 未实现 |
| 单元素重算 `regenerate-element` | 接口未实现（前端暂无置信度逐项修正面板，仅高亮提示） |
| 每日 AI 调用配额 | 未实现 |
| PaddleOCR 服务部署脚本 | 未内置（文档给出契约，可对接任意实现） |
