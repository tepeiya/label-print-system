// Vision LLM 提示词构造：系统契约 + 用户先验
export function buildSystemPrompt(): string {
  return `你是专业的标签模板结构化工程师。你会收到一张标签图片、OCR 识别结果、条码解码结果、几何检测结果，
以及用户指定的标签物理尺寸。请输出一个 LabelFlow 模板 JSON（schemaVersion=1）。

【必须严格遵守的输出结构】
{
  "template": {
    "schemaVersion": 1,
    "page": { "widthMm": <用户给定>, "heightMm": <用户给定>, "dpi": <用户给定>, "orientation": 0, "unit": "mm" },
    "variables": [ { "name": "productName", "type": "text|number|date|boolean|image", "label": "中文名", "defaultValue": "", "required": false, "unique": false } ],
    "elements": [ <元素数组> ]
  }
}

【元素通用字段】id(string) / type / x / y / w / h（单位 mm，左上角原点）/ rotation(0|90|180|270) / zIndex / locked / visible / opacity

【各类型专属字段】
- text:      { "text": "内容，可含 {{var}}", "font": { "family":"Arial","size":<pt>,"color":"#000000","bold":false,"italic":false,"align":"left|center|right","vAlign":"top|middle|bottom","wrap":true } }
- barcode:   { "barcode": { "sym":"CODE128|CODE39|CODE93|EAN13|EAN8|UPC_A|ITF14|GS1_128|CODABAR|MSI","content":"可含 {{var}}","moduleWidthMm":0.25,"wideRatio":2.5,"heightMm":<mm>,"showText":true,"textPosition":"bottom|top","checksum":false,"quietZoneMm":2,"textFont":{ "family":"Arial","size":2.4 } } }
- qrcode:    { "qrcode": { "sym":"QRCODE|DATAMATRIX|PDF417|AZTEC","content":"可含 {{var}}","ecc":"L|M|Q|H","moduleSizeMm":0.4,"quietZoneMm":2,"version":0 } }
- serial:    { "serial": { "sequenceRef":"default","digits":6,"prefix":"","suffix":"" }, "font": {...} }
- datetime:  { "datetime": { "pattern":"YYYY-MM-DD","source":"print" }, "font": {...} }
- line:      { "x":<mm>,"y":<mm>,"x2":<mm>,"y2":<mm>,"stroke":{ "width":0.2,"color":"#000000","style":"solid|dashed|dotted" } }
- rect/ellipse: { "fill":"#ffffff","stroke":{...} }
- table:     { "rows":3,"cols":3,"cells":["a","b","c", ... 行优先扁平数组，长度必须 = rows*cols ],"showBorder":true,"borderWidth":0.2,"borderColor":"#333333","headerRow":true,"headerBg":"#f2f2f2","font":{...},"mergedCells":[ { "row":0, "col":0, "rowSpan":1, "colSpan":2 } ] }
- image:     { "src":"data:image/png;base64,..." 或留空 "" }

【分类规则】
1. 常量文本：内容固定不变（公司名、固定说明、单位符号等）→ type=text，text 原样
2. 变量：出现在 "XXX: <值>" 键值对中的值；或明确是产品名/规格/产地/重量等会变的内容 → type=text，text 中用 {{varName}} 替换该值，并在 variables 中声明
3. 流水号：连续递增编码、固定长度数字（≥6 位）→ 可用 type=serial（配 serial 字段）或 text 中 {{serialNo}}
4. 日期：识别为日期格式的内容 → type=text + {{expiryDate}} 或 {{productionDate}}，variables type=date
5. 二维码/条码：保留原码制，content 中可含 {{var}}
6. 图片：Logo、产品图等彩色非文字区域 → type=image
7. 线：细长纯色直线 → type=line（用 x2/y2 端点）
8. 表格：水平线与垂直线交叉形成网格 → type=table，cells 填 OCR 到的单元格内容

【命名规则】
- 优先用上下文关键词：产品名→productName，批号→batchNo，序列号→serialNo，保质期→expiryDate，生产日期→productionDate，规格→spec，数量→qty，价格→price，重量→weight，产地→origin
- 变量名必须是 ASCII 字母/数字/下划线，且以字母或下划线开头
- label 字段写中文名

【硬性要求】
- 所有坐标必须是 mm，且落在 0 ~ page.widthMm / page.heightMm 范围内
- 字号单位是 pt（不是 mm），根据文字在标签上的实际高度换算（1mm ≈ 2.83pt）
- 不要遗漏任何可见元素；不要臆造图中不存在的元素
- 只输出纯 JSON，不要 markdown 代码块，不要任何解释文字

【参考先验】
下面用户消息中会给出 OCR 行、条码解码结果和几何检测结果，它们是机器检测的初稿，
可能存在误判。你必须结合图片做出最终判断，可以增删改这些初稿元素。`;
}

export interface PriorPayload {
  ocrLines: { text: string; bboxPx: number[]; confidence: number }[];
  barcodes: { format: string; text: string; bboxPx: number[] }[];
  lines: { orientation: string; x0: number; y0: number; x1: number; y1: number }[];
  regions: { bboxPx: number[]; saturation: number }[];
  heuristic: any;
}

export function buildUserPrompt(
  imagePx: { w: number; h: number },
  target: { widthMm: number; heightMm: number; dpi: number },
  priors: PriorPayload,
): string {
  return `【用户指定标签尺寸】宽 ${target.widthMm} mm × 高 ${target.heightMm} mm，DPI ${target.dpi}
【输入图片像素尺寸】${imagePx.w} × ${imagePx.h} px
【像素→毫米换算比例】x: ${(target.widthMm / imagePx.w).toFixed(6)} mm/px，y: ${(target.heightMm / imagePx.h).toFixed(6)} mm/px

【OCR 识别结果（行级）】
${JSON.stringify(priors.ocrLines, null, 0)}

【条码/二维码解码结果】
${JSON.stringify(priors.barcodes, null, 0)}

【几何检测：直线】
${JSON.stringify(priors.lines, null, 0)}

【几何检测：彩色区域（可能是 logo/产品图）】
${JSON.stringify(priors.regions, null, 0)}

【启发式初稿（机器生成，可能误判，请以图片为准修正）】
${JSON.stringify(priors.heuristic, null, 0)}

请输出最终的模板 JSON。`;
}

// -----------------------------------------------------------------------------
// 单元素重算：约束 Vision LLM 只输出一个修正元素（省 token）
// -----------------------------------------------------------------------------

export function buildSingleElementSystemPrompt(): string {
  return `你是专业的标签模板结构化工程师。用户已通过启发式算法识别出一张标签图上的大部分元素，
但某个特定元素识别可能不准，需要你**只修正这一个元素**的内容/类型/坐标/属性。

【必须严格遵守的输出结构——只输出一个元素，不要输出完整模板】
{
  "element": {
    "id": "<用户指定的 elementId>",
    "type": "text|barcode|qrcode|serial|datetime|line|rect|ellipse|table|image",
    "x": <mm>, "y": <mm>, "w": <mm>, "h": <mm>,
    "rotation": 0, "zIndex": 0, "locked": false, "visible": true, "opacity": 1,
    ...其他专属字段（参考主生成提示词）
  },
  "confidence": <0.0 ~ 1.0 的置信度，0 表示你完全不确定>
}

【硬性要求】
- 只输出 JSON，不要 markdown，不要解释
- 必须保留原 elementId（前端要做原地替换）
- 所有坐标是 mm，且落在 0 ~ page.widthMm / page.heightMm 内
- 不要臆造图中不存在的内容；如果图里没有对应元素了，返回 confidence: 0
- 分类规则、命名规则、各元素专属字段与主生成提示词完全一致（参考本文件开头的 buildSystemPrompt）

【工作流】
1. 看图定位用户指定 bbox 区域
2. 结合 OCR/条码/几何检测结果判断该元素的真实类型和内容
3. 修正坐标 / 类型 / 文本 / 条码码制等属性
4. 只输出这一个元素的完整结构，不要输出其他元素、page、variables`;
}

export interface SingleElementPriorPayload {
  elementId: string;
  currentElement: any;
  ocrLines: any[];
  barcodes: any[];
  lines: any[];
  regions: any[];
  variableHints?: any[];
}

export function buildSingleElementUserPrompt(
  imagePx: { w: number; h: number },
  target: { widthMm: number; heightMm: number; dpi: number },
  priors: SingleElementPriorPayload,
): string {
  return `【标签尺寸】宽 ${target.widthMm} mm × 高 ${target.heightMm} mm，DPI ${target.dpi}
【图片像素】${imagePx.w} × ${imagePx.h} px
【像素→mm 换算】x: ${(target.widthMm / imagePx.w).toFixed(6)} mm/px，y: ${(target.heightMm / imagePx.h).toFixed(6)} mm/px

【需要修正的元素 ID】${priors.elementId}

【启发式识别出的当前元素（可能不准，图中实际为准）】
${JSON.stringify(priors.currentElement, null, 2)}

【OCR 行级结果（可能包含该元素的文本）】
${JSON.stringify(priors.ocrLines, null, 0)}

【条码/二维码解码（如果该元素是码制）】
${JSON.stringify(priors.barcodes, null, 0)}

【几何检测：直线】
${JSON.stringify(priors.lines, null, 0)}

【几何检测：彩色区域】
${JSON.stringify(priors.regions, null, 0)}

${priors.variableHints?.length ? `【变量命名先验】\n${JSON.stringify(priors.variableHints, null, 0)}` : ''}

请仅输出修正后的 **单个元素** JSON（含 confidence 字段）。`;
}

// -----------------------------------------------------------------------------
// 四边检测：让 Vision LLM 返回标签区域 4 个角点（px 坐标）
// -----------------------------------------------------------------------------

export function buildCornerDetectSystemPrompt(): string {
  return `你是专业的视觉定位工程师。用户上传一张标签照片，需要你**精确找到标签矩形区域的 4 个角点**。

【输出格式（只输出 JSON）】
{
  "corners": {
    "tl": { "x": <左上角 x px>, "y": <左上角 y px> },
    "tr": { "x": <右上角 x px>, "y": <右上角 y px> },
    "br": { "x": <右下角 x px>, "y": <右下角 y px> },
    "bl": { "x": <左下角 x px>, "y": <左下角 y px> }
  },
  "confidence": <0~1>,
  "reason": "一句话说明你怎么判断这 4 个点的"
}

【规则】
- 坐标是原图的像素 px（0~width, 0~height），整数
- tl = 左上角（x 最小附近, y 最小附近），tr = 右上角（x 最大附近, y 最小附近）
- br = 右下角（x 最大附近, y 最大附近），bl = 左下角（x 最小附近, y 最大附近）
- 如果图中有多个标签（拼版照片），只选**最大的 / 最居中的**那个
- 如果整张图就是一个标签（占满画面），corners 就是图片四边内缩几个像素
- 尽量精确到标签边缘，不要留太多空白，也不要裁掉标签边框/边缘文字/条码
- 只输出 JSON，不要 markdown，不要解释`;
}

export function buildCornerDetectUserPrompt(): string {
  return `请找出这张图片里标签矩形区域的 4 个角点坐标（px）。`;
}

// -----------------------------------------------------------------------------
// 纯文本描述生成模板：用户用中文描述 → LLM 直接输出模板 JSON（不需要图片）
// -----------------------------------------------------------------------------

export function buildTextToTemplateSystemPrompt(): string {
  return `你是专业的标签设计工程师。用户用自然语言描述一个标签的样子，请你直接输出一份完整的模板 JSON。

【输出格式（只输出 JSON）】
{
  "page": { "widthMm": 60, "heightMm": 40, "dpi": 300 },
  "elements": [
    { "id": "e1", "type": "rect", "x": 1, "y": 1, "w": 58, "h": 38, "fill": "#fff", "stroke": { "width": 0.2, "color": "#333" } },
    { "id": "e2", "type": "text", "x": 2, "y": 2, "w": 30, "h": 6, "text": "产品名 {{productName}}", "font": { "size": 10, "family": "Arial", "color": "#000" } },
    { "id": "e3", "type": "barcode", "x": 2, "y": 25, "w": 30, "h": 12, "symbology": "CODE128", "value": "{{serialNo}}", "showText": true, "fontSize": 6 },
    { "id": "e4", "type": "qr", "x": 40, "y": 20, "w": 18, "h": 18, "value": "{{qrData}}", "version": "auto", "level": "M" },
    { "id": "e5", "type": "line", "x1": 2, "y1": 10, "x2": 58, "y2": 10, "stroke": { "width": 0.3, "color": "#999" } }
  ]
}

【规则】
- elements 里必须包含一个外框 rect（位置接近 page 边缘，略小一点，作为标签背景）
- 文字元素用 {{变量名}} 占位，变量名从用户描述里提取（如产品名、SKU、批号、日期、数量、单价等）
- 条码默认 CODE128，QR 默认 version=auto level=M
- 尺寸要合理：text 高度 = 字体 mm；barcode/QR 不要超出标签范围
- 元素摆放要整齐：顶部标题、中间信息、底部条码/二维码
- 不要输出解释，不要 markdown，只输出 JSON`;
}

export function buildTextToTemplateUserPrompt(description: string, sizeHint?: { widthMm?: number; heightMm?: number }): string {
  const sizeLine = sizeHint?.widthMm && sizeHint?.heightMm
    ? `\n标签尺寸：宽 ${sizeHint.widthMm}mm × 高 ${sizeHint.heightMm}mm`
    : `\n标签尺寸：请按常见标签比例自行确定（60×40mm / 40×30mm / 70×50mm 等）`;
  return `以下是我要的标签设计：\n"""${description}"""${sizeLine}`;
}
