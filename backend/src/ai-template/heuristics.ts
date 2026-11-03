// 启发式分类：把 OCR 行 / 条码 / 线段 / 彩色区域组装成 LabelTemplate 元素
// 不依赖 LLM，先跑一遍拿到 70%+ 准确率的结构，再交给 Vision LLM 修正与命名。
import {
  CoordMapper, estimateFontPt, estimateModuleWidthMm, estimateQrModuleSizeMm,
} from './coords-transform';
import { DetectedBarcode, toBarcodeSym } from './barcode-reader';
import { OcrLine } from './ocr-adapter';
import { DetectedLine, DetectedRegion, Box, insideRatio } from './geometry';

export interface Hint {
  elementId: string;
  suggestedName: string;
  reason: string;
  category: 'constant' | 'variable' | 'serial' | 'datetime' | 'sysvar' | 'image';
}

export interface AiWarning {
  level: 'low' | 'medium' | 'high';
  elementId?: string;
  message: string;
  suggestion?: string;
}

export interface BuildInput {
  ocr: OcrLine[];
  barcodes: DetectedBarcode[];
  lines: DetectedLine[];
  regions: DetectedRegion[];
  imagePx: { w: number; h: number };
  targetMm: { w: number; h: number; dpi: number };
  mapper: CoordMapper;
  /** 彩色区域裁出的 data URL（key = 区域索引） */
  regionImages?: string[];
}

export interface BuildOutput {
  elements: any[];
  variables: any[];
  confidence: Record<string, number>;
  warnings: AiWarning[];
  variableHints: Hint[];
}

let seq = 0;
const newId = () => `ai${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;

/** 中文/英文关键词 → 变量名 */
const NAME_RULES: { re: RegExp; name: string; label: string }[] = [
  { re: /(产品名|品名|商品名|名称|货品|product\s*name|item\s*name|description)/i, name: 'productName', label: '产品名' },
  { re: /(批号|批次|lot|batch)/i, name: 'batchNo', label: '批号' },
  { re: /(生产日期|制造日期|mfg|production\s*date|mfd)/i, name: 'productionDate', label: '生产日期' },
  { re: /(保质期|有效期|失效|到期|best\s*before|expir|exp\.?\s*date|use\s*by)/i, name: 'expiryDate', label: '保质期' },
  { re: /(序列号|流水号|序号|serial|s\/n|sn\b|seq)/i, name: 'serialNo', label: '流水号' },
  { re: /(规格|型号|spec|model|size)/i, name: 'spec', label: '规格' },
  { re: /(数量|qty|quantity|count)/i, name: 'qty', label: '数量' },
  { re: /(价格|单价|售价|price|amount)/i, name: 'price', label: '价格' },
  { re: /(重量|净重|毛重|weight|net\s*wt|gross\s*wt)/i, name: 'weight', label: '重量' },
  { re: /(产地|原产地|origin|made\s*in)/i, name: 'origin', label: '产地' },
  { re: /(供应商|厂家|厂商|supplier|vendor|manufacturer)/i, name: 'supplier', label: '供应商' },
  { re: /(条码|条形码|barcode|bar\s*code)/i, name: 'barcodeNo', label: '条码' },
  { re: /(二维码|qr\s*code|trace|追溯)/i, name: 'traceCode', label: '追溯码' },
  // 兜底：单独的 product / 产品
  { re: /^(\s*product\s*[:：]?|\s*产品\s*[:：]?)$/i, name: 'productName', label: '产品名' },
  { re: /\bproduct\b|产品/i, name: 'productName', label: '产品名' },
];

const DATE_RE = /\b((?:19|20)\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b|\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.]((?:19|20)\d{2})\b/;
const TIME_RE = /^\s*\d{1,2}:\d{2}(:\d{2})?\s*$/;
const KV_RE = /^(.{1,24}?)[:：]\s*(.+)$/;
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/;

/** 安全变量名 */
function safeName(raw: string): string {
  const s = raw.replace(/[^\w]/g, '_').replace(/^(\d)/, 'v$1').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return s || 'field';
}

/** 从上下文文本推断变量名 */
function inferName(context: string): { name: string; label: string } {
  for (const r of NAME_RULES) {
    if (r.re.test(context)) return { name: r.name, label: r.label };
  }
  return { name: '', label: '' };
}

type TextKind = 'constant' | 'variable' | 'serial' | 'datetime' | 'sysvar';

interface Classified {
  kind: TextKind;
  /** 变量名（kind=variable/serial/datetime 时有效） */
  varName?: string;
  varLabel?: string;
  /** 需要替换成 {{var}} 的子串（精确匹配） */
  replaceFrom?: string;
  confidence: number;
  reason: string;
}

/** 清理 OCR 行尾噪声（孤立符号 / 单字符残片 / 英文行误识别的 CJK 碎片） */
function cleanText(s: string): string {
  let out = s.replace(/\s+/g, ' ').trim();
  // 拉丁字符占比高的行，尾部 1-3 个 CJK 通常是 OCR 噪声
  const latin = (out.match(/[A-Za-z0-9]/g) ?? []).length;
  const cjk = (out.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (latin > 0 && latin >= cjk * 3) out = out.replace(/(\s*[\u4e00-\u9fff]{1,3})+\s*$/, '').trim();
  return out
    .replace(/\s+[-–—|丨]\s*[A-Za-z0-9]{1,2}$/, '')
    .replace(/\s+[^\w\u4e00-\u9fff]{1,3}$/, '')
    .trim();
}

/** 用字级 bbox 收紧文本行外框（去掉行尾空白与噪声字符占的宽度） */
function tightBox(line: OcrLine): Box | null {
  const all = (line.words ?? []).filter((w) => w.text.trim());
  if (!all.length) return null;
  const strong = all.filter((w) => w.confidence >= 50 && /[A-Za-z0-9\u4e00-\u9fff]/.test(w.text));
  const words = strong.length ? strong : all;
  const x0 = Math.min(...words.map((w) => w.bboxPx.x0));
  const y0 = Math.min(...words.map((w) => w.bboxPx.y0));
  const x1 = Math.max(...words.map((w) => w.bboxPx.x1));
  const y1 = Math.max(...words.map((w) => w.bboxPx.y1));
  // 收紧后过窄说明不可靠，退回整行框
  if (x1 - x0 < (line.bboxPx.x1 - line.bboxPx.x0) * 0.15) return null;
  return { x0, y0, x1, y1 };
}

/** 文本行的水平宽度被条码类区域覆盖的比例（用于过滤条码下方的明文重复/噪声） */
function coveredByBoxes(box: Box, boxes: Box[]): number {
  const width = Math.max(1, box.x1 - box.x0);
  let covered = 0;
  for (const b of boxes) {
    const ix = Math.max(0, Math.min(box.x1, b.x1) - Math.max(box.x0, b.x0));
    // 仅当纵向也有交集时才算覆盖
    const iy = Math.max(0, Math.min(box.y1, b.y1) - Math.max(box.y0, b.y0));
    if (iy > 0) covered += ix;
  }
  return Math.min(1, covered / width);
}

/** 单行文本分类 */
export function classifyText(line: OcrLine): Classified {
  const text = line.text.trim();
  const baseConf = Math.max(0.35, Math.min(1, (line.confidence || 70) / 100));

  // 1) 原始图就是模板截图（含 {{var}}）
  const ph = text.match(PLACEHOLDER_RE);
  if (ph) {
    return { kind: 'variable', varName: safeName(ph[1]), varLabel: ph[1], confidence: baseConf, reason: '原文含 {{变量}} 占位符' };
  }

  // 2) 纯时间
  if (TIME_RE.test(text)) {
    return { kind: 'sysvar', confidence: baseConf * 0.9, reason: '内容为时间格式，判定为打印时间' };
  }

  // 3) 日期
  const dm = text.match(DATE_RE);
  if (dm) {
    const ctx = inferName(text);
    const name = ctx.name || 'expiryDate';
    return {
      kind: 'datetime', varName: name, varLabel: ctx.label || '日期',
      replaceFrom: dm[0], confidence: baseConf * 0.95,
      reason: `识别到日期 "${dm[0]}"，按上下文命名为 ${name}`,
    };
  }

  // 4) 键值对 "Label: value"
  const kv = text.match(KV_RE);
  if (kv) {
    const key = kv[1];
    const value = kv[2].trim();
    const ctx = inferName(key);
    if (value && value.length <= 40) {
      const name = ctx.name || safeName(value.length <= 20 ? key : 'field');
      const isSerial = /^\d{5,}$/.test(value);
      return {
        kind: isSerial ? 'serial' : 'variable',
        varName: name,
        varLabel: ctx.label || key,
        replaceFrom: value,
        confidence: baseConf * (ctx.name ? 0.97 : 0.85),
        reason: `键值对 "${key.trim()}: ${value}"，值部分判定为${isSerial ? '流水号' : '变量'}`,
      };
    }
  }

  // 5) 孤立纯数字串（可能是流水号/批次号）
  if (/^\d{5,}$/.test(text)) {
    const isSerial = text.length >= 6;
    return {
      kind: isSerial ? 'serial' : 'variable',
      varName: isSerial ? 'serialNo' : 'batchNo',
      varLabel: isSerial ? '流水号' : '批号',
      confidence: baseConf * 0.8,
      reason: '孤立的长数字串，疑似流水号/批次号',
    };
  }

  // 6) 字母+数字混合的长串（批次号形态）
  if (/^[A-Z]{1,4}\d{4,}$/i.test(text)) {
    return {
      kind: 'variable', varName: 'batchNo', varLabel: '批号',
      confidence: baseConf * 0.75, reason: '字母+数字的编码形态，疑似批次号',
    };
  }

  // 7) 其余视为常量
  return { kind: 'constant', confidence: baseConf, reason: '固定文本，判定为常量' };
}

export function buildTemplateFromPriors(input: BuildInput): BuildOutput {
  const { ocr, barcodes, lines, regions, imagePx, targetMm, mapper } = input;
  const elements: any[] = [];
  const variables: any[] = [];
  const confidence: Record<string, number> = {};
  const warnings: AiWarning[] = [];
  const variableHints: Hint[] = [];
  const usedNames = new Set<string>();

  const varIndex = new Map<string, any>();
  const addVariable = (name: string, label: string, type: string, defaultValue: any = '') => {
    const key = safeName(name);
    if (varIndex.has(key)) return varIndex.get(key);
    const v = { name: key, type, label, defaultValue, required: false, unique: type === 'text' && /serial|batch/i.test(key) };
    varIndex.set(key, v);
    variables.push(v);
    return v;
  };
  const uniqueName = (base: string) => {
    let n = safeName(base);
    let i = 2;
    while (usedNames.has(n)) n = `${safeName(base)}${i++}`;
    usedNames.add(n);
    return n;
  };

  const barcodeBoxes = barcodes.map((b) => b.bboxPx);
  const regionBoxes = regions.map((r) => r.bboxPx);

  // 从密集竖线簇推断"疑似条码区域"（覆盖 zxing 解码失败的一维码）。
  // 判据：线段长度 > 图高 30%，相邻线段水平间距 < 12px 且 y 区间重叠 > 60%，簇内 ≥ 8 条。
  const barClusters: Box[] = [];
  {
    const vlines = lines
      .filter((l) => l.orientation === 'v' && Math.abs(l.y1 - l.y0) > imagePx.h * 0.3)
      .sort((a, b) => a.x0 - b.x0);
    let group: DetectedLine[] = [];
    const flush = () => {
      if (group.length >= 8) {
        const x0 = Math.min(...group.map((g) => g.x0));
        const x1 = Math.max(...group.map((g) => g.x0));
        const y0 = Math.min(...group.map((g) => Math.min(g.y0, g.y1)));
        const y1 = Math.max(...group.map((g) => Math.max(g.y0, g.y1)));
        if (x1 - x0 > 12) barClusters.push({ x0, y0, x1, y1 });
      }
      group = [];
    };
    for (const l of vlines) {
      if (!group.length) { group.push(l); continue; }
      const prev = group[group.length - 1];
      const gap = l.x0 - prev.x0;
      const oy0 = Math.max(Math.min(prev.y0, prev.y1), Math.min(l.y0, l.y1));
      const oy1 = Math.min(Math.max(prev.y0, prev.y1), Math.max(l.y0, l.y1));
      const overlap = Math.max(0, oy1 - oy0);
      const minLen = Math.min(Math.abs(prev.y1 - prev.y0), Math.abs(l.y1 - l.y0));
      if (gap <= 12 && overlap > minLen * 0.6) group.push(l);
      else { flush(); group.push(l); }
    }
    flush();
  }
  /** 用于过滤 OCR / 线条的全部"条码类"区域 */
  const suppressBoxes: Box[] = [...barcodeBoxes, ...barClusters];
  // zxing 上报的一维码 bbox 通常只覆盖解码条带（不含条码下方明文），
  // 因此纵向放宽 60%，避免明文行 / 条码竖条被误判为独立元素。
  const expandV = (b: Box): Box => {
    const pad = Math.max(6, (b.y1 - b.y0) * 0.6);
    return { x0: b.x0 - 2, y0: b.y0 - pad, x1: b.x1 + 2, y1: b.y1 + pad };
  };
  const suppressBoxesV: Box[] = suppressBoxes.map(expandV);

  // ---------------- 文本元素 ----------------
  for (const line of ocr) {
    const box = line.bboxPx;
    // 落在条码区域内的 OCR 噪声丢弃（条码下方明文由条码自身 showText 输出）
    if (suppressBoxes.some((b) => insideRatio(box, b) > 0.5)) continue;
    // 条码下方明文常与相邻条码被 OCR 合并成一行：按水平覆盖率判定
    if (coveredByBoxes(box, suppressBoxesV) > 0.55) continue;
    // 落在图片区域内丢弃
    if (regionBoxes.some((b) => insideRatio(box, b) > 0.6)) continue;
    if (line.confidence < 25) continue;
    // 低置信度的短残片视为 OCR 噪声（常见于条码/二维码周边的误识别）
    const rawText = line.text.trim();
    const looksLikeKeyword = NAME_RULES.some((r) => r.re.test(rawText));
    if (line.confidence < 50 && rawText.length <= 8 && !looksLikeKeyword) continue;

    const cleaned = cleanText(line.text.trim());
    // 分类与替换必须基于同一份文本，否则清洗掉尾部噪声后 replaceFrom 会匹配失败
    const cls = classifyText({ ...line, text: cleaned });
    const id = newId();
    let text = cleaned;
    let zIndex = elements.length + 1;

    // 用字级 bbox 收紧文本框（整行 bbox 常包含行尾空白/噪声，导致元素过宽）
    const gbox = tightBox(line) ?? box;
    const heightMm = mapper.h(gbox.y1 - gbox.y0);
    const widthMm = mapper.w(gbox.x1 - gbox.x0);

    if (cls.kind !== 'constant' && cls.varName) {
      const vname = uniqueName(cls.varName);
      const type = cls.kind === 'datetime' ? 'date' : 'text';
      addVariable(vname, cls.varLabel || vname, type, '');
      if (cls.replaceFrom) {
        text = text.replace(cls.replaceFrom, `{{${vname}}}`);
      } else {
        text = `{{${vname}}}`;
      }
      variableHints.push({
        elementId: id, suggestedName: vname, reason: cls.reason, category: cls.kind,
      });
    }

    const el = {
      id, type: 'text',
      x: mapper.x(box.x0), y: mapper.y(box.y0),
      w: Math.max(2, widthMm), h: Math.max(2, heightMm),
      rotation: 0, zIndex, locked: false, visible: true, opacity: 1,
      text,
      font: {
        family: 'Arial', size: estimateFontPt(heightMm), color: '#000000',
        bold: false, italic: false, align: 'left', vAlign: 'middle', wrap: true,
      },
    };
    elements.push(el);
    confidence[id] = Math.round(cls.confidence * 100) / 100;

    if (line.confidence > 0 && line.confidence < 60) {
      warnings.push({
        level: 'low', elementId: id,
        message: `"${line.text}" OCR 置信度仅 ${Math.round(line.confidence)}%，建议人工核对`,
      });
    }
  }

  // ---------------- 条码 / 二维码 ----------------
  for (const bc of barcodes) {
    const id = newId();
    const is2d = /qr|datamatrix|pdf417|aztec/i.test(bc.format);
    const wMm = mapper.w(bc.bboxPx.x1 - bc.bboxPx.x0);
    const hMm = mapper.h(bc.bboxPx.y1 - bc.bboxPx.y0);

    // 内容分类：零售码制 → 商品码；纯数字长串 → 流水号；URL/UUID/含 trace → 变量；否则常量
    let content = bc.text;
    let cls: Classified;
    const fmtLower = bc.format.toLowerCase();
    const isRetail = /ean|upc/i.test(fmtLower);
    if (isRetail) {
      cls = { kind: 'variable', varName: 'barcodeNo', varLabel: '商品条码', confidence: 0.92, reason: `${bc.format} 为零售商品码，判定为商品条码变量` };
    } else if (/^\d{5,}$/.test(bc.text) && bc.text.length >= 6) {
      cls = { kind: 'serial', varName: 'serialNo', varLabel: '流水号', confidence: 0.93, reason: '条码内容为连续数字，判定为流水号' };
    } else if (/^https?:\/\//i.test(bc.text) || /trace|uuid|[0-9a-f]{8}-[0-9a-f]{4}/i.test(bc.text)) {
      cls = { kind: 'variable', varName: /trace/i.test(bc.text) ? 'traceCode' : 'qrContent', varLabel: '追溯码', confidence: 0.86, reason: '条码内容为 URL/追溯码形态，判定为变量' };
    } else {
      cls = { kind: 'constant', confidence: 0.8, reason: '条码内容为固定编码，判定为常量' };
    }

    if (cls.kind !== 'constant' && cls.varName) {
      const vname = uniqueName(cls.varName);
      addVariable(vname, cls.varLabel || vname, 'text', '');
      // 条码内容整体作为变量值（不再保留原常量文本）
      content = `{{${vname}}}`;
      variableHints.push({ elementId: id, suggestedName: vname, reason: cls.reason, category: cls.kind });
    }

    const sym = toBarcodeSym(bc.format);
    const el: any = is2d
      ? {
        id, type: 'qrcode',
        x: mapper.x(bc.bboxPx.x0), y: mapper.y(bc.bboxPx.y0),
        w: Math.max(4, wMm), h: Math.max(4, hMm),
        rotation: 0, zIndex: elements.length + 1, locked: false, visible: true, opacity: 1,
        qrcode: {
          sym: ['DATAMATRIX', 'PDF417', 'AZTEC'].includes(sym) ? sym : 'QRCODE',
          content,
          ecc: 'M',
          moduleSizeMm: estimateQrModuleSizeMm(wMm, bc.text.length),
          quietZoneMm: 2,
          version: 0,
        },
      }
      : {
        id, type: 'barcode',
        x: mapper.x(bc.bboxPx.x0), y: mapper.y(bc.bboxPx.y0),
        w: Math.max(6, wMm), h: Math.max(4, hMm),
        rotation: 0, zIndex: elements.length + 1, locked: false, visible: true, opacity: 1,
        barcode: {
          sym,
          content,
          moduleWidthMm: estimateModuleWidthMm(wMm, bc.text.length, bc.format),
          wideRatio: 2.5,
          heightMm: Math.max(3, hMm * 0.78),
          showText: true,
          textPosition: 'bottom',
          checksum: false,
          quietZoneMm: 2,
          textFont: { family: 'Arial', size: Math.max(4, Math.min(9, estimateFontPt(hMm * 0.18))) },
        },
      };
    elements.push(el);
    confidence[id] = bc.valid ? 0.99 : 0.8;
  }

  // ---------------- 线条 ----------------
  const seenLines = new Set<string>();
  const centerIn = (b: Box, x: number, y: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

  for (const ln of lines) {
    const midX = (ln.x0 + ln.x1) / 2;
    const midY = (ln.y0 + ln.y1) / 2;
    if (suppressBoxesV.some((b) => centerIn(b, midX, midY))) continue;
    // 线段过短（不足标签短边的 8%）视为噪声
    const lenPx = Math.hypot(ln.x1 - ln.x0, ln.y1 - ln.y0);
    if (lenPx < Math.min(imagePx.w, imagePx.h) * 0.08) continue;

    const key = `${ln.orientation}:${Math.round(ln.orientation === 'h' ? ln.y0 : ln.x0)}:${Math.round(ln.orientation === 'h' ? ln.x0 : ln.y0)}`;
    if (seenLines.has(key)) continue;
    seenLines.add(key);

    const id = newId();
    const thicknessMm = Math.max(0.15, mapper.w(ln.thickness));
    elements.push({
      id, type: 'line',
      x: mapper.x(ln.x0), y: mapper.y(ln.y0),
      x2: mapper.x(ln.x1), y2: mapper.y(ln.y1),
      w: Math.abs(mapper.x(ln.x1) - mapper.x(ln.x0)),
      h: Math.abs(mapper.y(ln.y1) - mapper.y(ln.y0)),
      rotation: 0, zIndex: elements.length + 1, locked: false, visible: true, opacity: 1,
      stroke: { width: Math.round(Math.min(1.5, thicknessMm) * 100) / 100, color: '#000000', style: 'solid' },
    });
    confidence[id] = 0.9;
  }

  // ---------------- 图片区域（logo / 产品图） ----------------
  regions.forEach((rg, i) => {
    const id = newId();
    const wMm = mapper.w(rg.bboxPx.x1 - rg.bboxPx.x0);
    const hMm = mapper.h(rg.bboxPx.y1 - rg.bboxPx.y0);
    if (wMm < 2 || hMm < 2) return;
    elements.push({
      id, type: 'image',
      x: mapper.x(rg.bboxPx.x0), y: mapper.y(rg.bboxPx.y0),
      w: wMm, h: hMm,
      rotation: 0, zIndex: 1, locked: false, visible: true, opacity: 1,
      src: input.regionImages?.[i] ?? '',
    });
    confidence[id] = 0.75;
    warnings.push({
      level: 'medium', elementId: id,
      message: '该彩色区域被裁切为图片，背景可能带入原图底色',
      suggestion: '建议替换为透明背景 PNG',
    });
  });

  // ---------------- 收尾 ----------------
  if (!barcodes.length) {
    warnings.push({ level: 'low', message: '未在图中识别到条码/二维码，如需请手动添加' });
  }
  if (!ocr.length) {
    warnings.push({ level: 'high', message: '未识别到任何文字，请确认图片清晰度或更换扫描件' });
  }

  // 层级：图片最底，线条其次，文本与条码在上
  elements.sort((a, b) => {
    const rank = (t: string) => (t === 'image' ? 0 : t === 'line' ? 1 : t === 'rect' ? 2 : 3);
    return rank(a.type) - rank(b.type);
  });
  elements.forEach((e, i) => { e.zIndex = i + 1; });

  return { elements, variables, confidence, warnings, variableHints };
}
