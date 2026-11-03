// OCR 适配层
// 优先调用 PaddleOCR HTTP 服务（精度最好，用户确认要求）；
// 若未配置 OCR_ENDPOINT，则回落到本地 tesseract.js（零部署，精度次之）。
import { createWorker, Worker } from 'tesseract.js';
import * as path from 'path';
import * as fs from 'fs';

/** 兼容 dist 编译产物与 tsx 直跑两种目录层级 */
function resolveTessdataDir(): string {
  const candidates = [
    path.join(__dirname, '../../../assets/tessdata'), // dist/src/ai-template → backend/assets
    path.join(__dirname, '../../assets/tessdata'),    // src/ai-template → backend/assets
    path.join(process.cwd(), 'assets/tessdata'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return candidates[0];
}

const TESSDATA_DIR = resolveTessdataDir();

export interface OcrWord {
  text: string;
  /** 像素包围盒 */
  bboxPx: { x0: number; y0: number; x1: number; y1: number };
  /** 0-100 */
  confidence: number;
}

export interface OcrLine {
  text: string;
  bboxPx: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
  words: OcrWord[];
}

export interface OcrResult {
  lines: OcrLine[];
  /** 实际使用的引擎 */
  engine: 'paddle' | 'tesseract';
  warnings: string[];
  durationMs: number;
}

/** PaddleOCR HTTP 服务返回的宽松契约（兼容 PaddleOCR / RapidOCR / PP-Structure 常见输出） */
interface PaddleRawLine {
  text?: string;
  confidence?: number;
  bbox?: number[][];      // [[x,y],[x,y],[x,y],[x,y]]
  box?: number[][];
  points?: number[][];
  score?: number;
}

let _worker: Worker | null = null;
let _workerLangs = '';

/** 复用 tesseract worker（初始化约 1-2s，避免每次请求重建） */
async function getTesseract(langs: string): Promise<Worker> {
  if (_worker && _workerLangs === langs) return _worker;
  if (_worker) { try { await _worker.terminate(); } catch { /* ignore */ } }
  _worker = await createWorker(langs.split('+'), 1, {
    langPath: TESSDATA_DIR,
    gzip: true,
    logger: () => { /* 静默 */ },
  });
  _workerLangs = langs;
  return _worker;
}

/**
 * 识别图片中的文字。
 * @param buf    图片 buffer
 * @param opts.lang  语言，默认 'eng+chi_sim'（中英混排标签）
 * @param opts.endpoint  PaddleOCR 服务地址；未传则读 env OCR_ENDPOINT
 */
export async function recognize(
  buf: Buffer,
  opts: { lang?: string; endpoint?: string; timeoutMs?: number } = {},
): Promise<OcrResult> {
  const t0 = Date.now();
  const lang = opts.lang || process.env.OCR_LANG || 'eng+chi_sim';
  const endpoint = opts.endpoint || process.env.OCR_ENDPOINT || '';

  if (endpoint) {
    try {
      const r = await callPaddle(buf, endpoint, opts.timeoutMs ?? 20000);
      if (r) return { ...r, engine: 'paddle', durationMs: Date.now() - t0 };
    } catch (e: any) {
      // 服务不可用 → 回落本地，并把原因作为 warning 上报
      const local = await callTesseract(buf, lang);
      local.warnings.unshift(`PaddleOCR 服务不可用（${e?.message ?? e}），已回落到本地 OCR`);
      return { ...local, engine: 'tesseract', durationMs: Date.now() - t0 };
    }
  }

  const r = await callTesseract(buf, lang);
  return { ...r, engine: 'tesseract', durationMs: Date.now() - t0 };
}

/** PaddleOCR HTTP：POST multipart(file) 或 JSON(base64)，两种都尝试 */
async function callPaddle(buf: Buffer, endpoint: string, timeoutMs: number): Promise<{ lines: OcrLine[]; warnings: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: 'image/png' }), 'label.png');
    const res = await fetch(endpoint, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    return { lines: normalizePaddle(json), warnings: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** 兼容多种 Paddle 输出形状 */
function normalizePaddle(json: any): OcrLine[] {
  // 形状 A：[{ text, confidence, bbox }]
  // 形状 B：{ result: [[ [box], [text, score] ], ...] }（PaddleOCR 原生）
  // 形状 C：{ data: [{ text, box }] }
  const arr: any[] = Array.isArray(json) ? json
    : Array.isArray(json?.result) ? json.result
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json?.lines) ? json.lines
    : [];

  const out: OcrLine[] = [];
  for (const item of arr) {
    let text = '';
    let conf = 0;
    let pts: number[][] = [];

    if (Array.isArray(item)) {
      // 形状 B：[box, [text, score]]
      pts = Array.isArray(item[0]) ? item[0] : [];
      const t = item[1];
      if (Array.isArray(t)) { text = String(t[0] ?? ''); conf = Number(t[1] ?? 0) * 100; }
      else if (typeof t === 'string') { text = t; conf = 80; }
    } else if (item && typeof item === 'object') {
      text = String(item.text ?? item.transcription ?? '');
      conf = Number(item.confidence ?? item.score ?? 0) * (Number(item.confidence ?? item.score) <= 1 ? 100 : 1);
      pts = item.bbox ?? item.box ?? item.points ?? [];
    }

    if (!text.trim()) continue;
    const bbox = pointsToBbox(pts);
    if (!bbox) continue;
    out.push({ text: text.trim(), bboxPx: bbox, confidence: Math.round(conf), words: [] });
  }
  return out;
}

function pointsToBbox(pts: any[]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!Array.isArray(pts) || !pts.length) return null;
  // 支持 [[x,y],...] 或 [x0,y0,x1,y1]
  if (typeof pts[0] === 'number') {
    const [x0, y0, x1, y1] = pts as number[];
    return { x0, y0, x1, y1 };
  }
  const xs = (pts as any[]).map((p) => Number(p[0] ?? p.x ?? 0));
  const ys = (pts as any[]).map((p) => Number(p[1] ?? p.y ?? 0));
  if (!xs.length) return null;
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** 本地 tesseract.js */
async function callTesseract(buf: Buffer, lang: string): Promise<{ lines: OcrLine[]; warnings: string[] }> {
  const warnings: string[] = [];
  let worker: Worker;
  try {
    worker = await getTesseract(lang);
  } catch (e: any) {
    warnings.push(`本地 OCR 初始化失败：${e?.message ?? e}`);
    return { lines: [], warnings };
  }

  const { data } = await worker.recognize(buf, {}, { blocks: true, text: true });
  const lines: OcrLine[] = [];
  for (const block of (data as any).blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const words: OcrWord[] = (line.words ?? []).map((w: any) => ({
          text: String(w.text ?? ''),
          bboxPx: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
          confidence: Math.round(w.confidence ?? 0),
        }));
        const text = String(line.text ?? '').trim();
        if (!text) continue;
        lines.push({
          text,
          bboxPx: { x0: line.bbox.x0, y0: line.bbox.y0, x1: line.bbox.x1, y1: line.bbox.y1 },
          confidence: Math.round(line.confidence ?? 0),
          words,
        });
      }
    }
  }
  if (!lines.length) warnings.push('OCR 未识别到任何文字（图片可能过小、过糊或全为图形）');
  return { lines, warnings };
}

/** 关停（进程退出时调用） */
export async function disposeOcr() {
  if (_worker) { try { await _worker.terminate(); } catch { /* ignore */ } _worker = null; }
}
