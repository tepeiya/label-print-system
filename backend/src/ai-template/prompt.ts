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
- table:     { "rows":3,"cols":3,"cells":["a","b","c", ... 行优先扁平数组，长度必须 = rows*cols ],"showBorder":true,"borderWidth":0.2,"borderColor":"#333333","headerRow":true,"headerBg":"#f2f2f2","font":{...} }
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
