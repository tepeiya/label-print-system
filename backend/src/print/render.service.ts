// 渲染服务：模板 + 数据行 + 流水号 → 每行的元素数组（已替换占位/公式/流水号）
// 注：不依赖 @nestjs/common 装饰器，既可在 NestJS 中作为 provider，也可独立单测。
// 元素类型在后端本地定义，避免跨 rootDir 引用前端代码。
import { safeEval } from '../../core/formula-engine';
import { resolveComputedVars, type ComputedVariable } from '../../core/computed-vars';
import { runsToPlainText } from '../../core/rich-text';
import { stripEmptyGs1Ais } from '../../core/gs1-ai';

/** 第四层：指令通道的文本降级——富文本取 runs 拼接，DB 字段取 rendered，其余取原逻辑 */
function commandTextOf(e: any): string {
  if (e.type === 'richtext' && Array.isArray(e.runs)) return runsToPlainText(e.runs);
  return String(e.rendered ?? e.text ?? '');
}
const TEXT_TYPES = new Set(['text', 'richtext', 'formula', 'serial', 'datetime', 'sysvar', 'dbField']);

interface RenderElement {
  id: string; type: string; text?: string; font?: any;
  /** 第四层：富文本片段（renderRow 内逐 run 插值） */
  runs?: Array<{ text: string; [k: string]: any }>;
  /** 第四层：DB 字段绑定 */
  dbField?: { field?: string; datasetId?: string; format?: string; fallback?: string };
  barcode?: { content: string; [k: string]: any };
  qrcode?: { content: string; [k: string]: any };
  serial?: { sequenceRef: string };
  formula?: { expr: string };
}

export class RenderService {
  /**
   * 渲染单行：把模板元素中的 {{var}}、公式、流水号替换为最终值。
   * @param elements 模板元素
   * @param row 数据行（变量来源：手动>导入>默认）
   * @param serials 预分配流水号（按元素 id 索引的值数组）
   * @param sysVars 系统变量（页码/打印人/UUID…）
   * @param variables 模板变量定义；含 expr 的计算变量会在本行事先按依赖顺序求值并入 ctx
   */
  renderRow(elements: RenderElement[], row: Record<string, any>, serials: Record<string, string[]>, sysVars: Record<string, any>, rowIndex = 0, variables?: ComputedVariable[]): RenderElement[] {
    const computed = resolveComputedVars(variables, row);
    const ctx = { ...computed.row, ...sysVars };
    const out = elements.map((el) => {
      const e: any = { ...el };
      // 条件打印：printIf 表达式为假则跳过该元素
      if (typeof e.printIf === 'string' && e.printIf.trim()) {
        const cond = safeEval(e.printIf, ctx);
        if (cond.ok && !cond.value) e._skip = true;
      } else if (e.printIf && typeof e.printIf === 'object' && e.printIf.enabled === false) {
        e._skip = true;
      }
      if (e.type === 'text' || e.type === 'richtext') {
        e.text = this.interp(e.text ?? '', ctx, serials, rowIndex);
        if (Array.isArray(e.cells)) e.cells = e.cells.map((c: any) => this.interp(String(c ?? ''), ctx, serials, rowIndex));
        // 第四层：富文本逐 run 插值，保留样式字段；渲染器读 e.runs
        if (e.type === 'richtext' && Array.isArray(e.runs)) {
          e.runs = e.runs.map((r: any) => ({
            ...r,
            text: this.interp(String(r?.text ?? ''), ctx, serials, rowIndex),
          }));
        }
      } else if (e.type === 'dbField') {
        // 第四层：DB 字段元素——从数据行取值（字段名可能本身是 {{var}} 占位），套格式
        const rawField = String(e.dbField?.field ?? '');
        const key = /^\{\{[^}]+\}\}$/.test(rawField)
          ? rawField.replace(/^\{\{|\}\}$/g, '').trim()
          : rawField;
        let value = key && key in ctx ? ctx[key] : (key in row ? row[key] : '');
        value = this.formatDbField(value, e.dbField?.format ?? '');
        e.rendered = value === '' || value == null
          ? String(e.dbField?.fallback ?? '')
          : String(value);
      } else if (e.type === 'barcode') {
        e.barcode = { ...e.barcode, content: this.interp(e.barcode.content ?? '', ctx, serials, rowIndex) };
      } else if (e.type === 'qrcode') {
        e.qrcode = { ...e.qrcode, content: this.interp(e.qrcode.content ?? '', ctx, serials, rowIndex) };
      } else if (e.type === 'formula') {
        const r = safeEval(e.formula.expr, ctx);
        e.rendered = r.ok ? String(r.value) : '{{ERROR}}'; // 出错不阻断整单
      } else if (e.type === 'serial') {
        const arr = serials[e.id] ?? [];
        e.rendered = arr[rowIndex] ?? ''; // 第 rowIndex 行的流水号（按行切片）
      } else if (e.type === 'datetime') {
        e.rendered = this.formatDate(e.datetime?.pattern ?? 'YYYY-MM-DD', e.datetime?.source === 'data' ? ctx : new Date(), e.datetime?.source, ctx, e.datetime?.offset ?? '');
      } else if (e.type === 'sysvar') {
        const key = e.sysvar?.key ?? e.key ?? '';
        e.rendered = key && key in ctx ? String(ctx[key]) : '';
      } else if (e.type === 'image') {
        e.src = this.interp(e.src ?? '', ctx, serials, rowIndex);
      }
      return e;
    });

    // 第二遍：文本元素可绑定条码（HRI 人眼可读文本）。
    // 目的不是「省一次输入」，而是让 HRI 永远等于码里真正编进去的内容 ——
    // 手抄/手贴的明文最常见的问题就是改了码没改字，合规检查直接判不合格。
    const byId = new Map<string, string>();
    for (const e of out) {
      if (e?.type === 'barcode') byId.set(String(e.id ?? ''), String(e.barcode?.content ?? ''));
      else if (e?.type === 'qrcode') byId.set(String(e.id ?? ''), String(e.qrcode?.content ?? ''));
    }
    if (byId.size) {
      for (const e of out) {
        if (e?.type !== 'text' && e?.type !== 'richtext') continue;
        const bindId = String((e as any).bindId ?? '');
        const v = bindId ? byId.get(bindId) : undefined;
        if (v == null) continue;
        (e as any).text = v;
        (e as any)._boundTo = bindId;
        if (e.type === 'richtext' && Array.isArray((e as any).runs) && (e as any).runs.length) {
          (e as any).runs = [{ ...(e as any).runs[0], text: v }];
        }
      }
    }
    // 第三遍：剔除「值为空」的 GS1 AI 段（如没填序列号时的孤立 (21)）。
    // 不这么做，bwip 会抛 GS1valueTooShort 把整单打废，故障点还落在打印环节而不是录入环节。
    for (const e of out) {
      const bc = e?.barcode;
      if (e?.type === 'barcode' && bc?.gs1 && typeof bc.content === 'string') {
        e.barcode = { ...bc, content: stripEmptyGs1Ais(bc.content) };
        continue;
      }
      const q = e?.qrcode;
      if (e?.type === 'qrcode' && q?.gs1 && typeof q.content === 'string') {
        e.qrcode = { ...q, content: stripEmptyGs1Ais(q.content) };
        continue;
      }
      if (e?.type === 'text' || e?.type === 'richtext') {
        const t = String(e.text ?? '');
        // 仅处理 HRI 形态的文本（至少两段 (AI)），避免误伤普通标签文字
        if (((t.match(/\(\d{2,4}\)/g) || []).length) >= 2) {
          e.text = stripEmptyGs1Ais(t);
          if (Array.isArray(e.runs)) e.runs = e.runs.map((r: any) => ({ ...r, text: stripEmptyGs1Ais(String(r?.text ?? '')) }));
        }
      }
    }
    return out;
  }

  /** 替换 {{name}} 占位（变量缺失留空，不报错）。支持 @系统占位符（如 {{@serial}} {{@printDate}}） */
  private interp(s: string, ctx: Record<string, any>, serials: Record<string, string[]> = {}, rowIndex = 0): string {
    return String(s ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, raw: string) => {
      if (!raw.startsWith('@')) return raw in ctx ? String(ctx[raw]) : '';
      const body = raw.slice(1);
      const ci = body.indexOf(':');
      const key = ci < 0 ? body : body.slice(0, ci);
      const rest = ci < 0 ? '' : body.slice(ci + 1).trim();
      // 格式与偏移用 | 分隔：{{@printDate:YYYYMMDD|+3d}}
      const pi = rest.indexOf('|');
      const pattern = pi < 0 ? rest : rest.slice(0, pi).trim();
      const offset = pi < 0 ? '' : rest.slice(pi + 1).trim();
      return this.systemPlaceholder(key, ctx, serials, rowIndex, pattern, offset);
    });
  }

  /** 第四层：DB 字段格式化（与前端 engine/print#formatDbDate 同口径） */
  private formatDbField(value: unknown, format: string): string {
    if (value == null) return '';
    const fmt = String(format ?? '');
    if (fmt.startsWith('date:')) {
      const d = new Date(String(value));
      if (isNaN(d.getTime())) return String(value);
      const p = (n: number) => String(n).padStart(2, '0');
      return (fmt.slice(5) || 'YYYY-MM-DD')
        .replace(/YYYY/g, String(d.getFullYear())).replace(/MM/g, p(d.getMonth() + 1))
        .replace(/DD/g, p(d.getDate())).replace(/HH/g, p(d.getHours()))
        .replace(/mm/g, p(d.getMinutes())).replace(/ss/g, p(d.getSeconds()));
    }
    if (fmt === 'upper') return String(value).toUpperCase();
    if (fmt === 'lower') return String(value).toLowerCase();
    if (/^num:\d+$/.test(fmt)) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(Number(fmt.slice(4))) : String(value);
    }
    return String(value);
  }

  /**
   * 系统占位符 @xxx：打印期上下文，与前端 engine/context#systemPlaceholder 同口径。
   *   @serial      当前标签流水号（取模板首个 serial 元素的预分配值；无 serial 元素则回退 (rowIndex+1) 补零5位）
   *   @printDate @printTime @pageNo @pageTotal @uuid @copyIndex @printerName @tenantName @printUser → 查 sysVars
   */
  private systemPlaceholder(key: string, ctx: Record<string, any>, serials: Record<string, string[]>, rowIndex: number, pattern = '', offset = ''): string {
    switch (key) {
      case 'serial': {
        const keys = Object.keys(serials || {});
        if (keys.length) {
          const v = serials[keys[0]]?.[rowIndex];
          if (v !== undefined) return String(v);
        }
        return String((rowIndex ?? 0) + 1).padStart(5, '0');
      }
      case 'printDate':
      case 'printTime':
        // 给了格式或偏移（如 {{@printDate:YYYYMMDD|+3d}}）就按 _now 重算；否则沿用 sysVars 里已格式化的字符串，保持兼容
        if (pattern || offset) {
          const base = ctx._now instanceof Date ? ctx._now : new Date();
          const d = this.shiftDate(base, offset);
          return this.formatDate(pattern || (key === 'printDate' ? 'YYYY-MM-DD' : 'HH:mm:ss'), d, 'print', ctx);
        }
        return key in ctx ? String(ctx[key]) : '';
      case 'pageNo':
      case 'pageTotal':
      case 'uuid':
      case 'copyIndex':
      case 'printerName':
      case 'tenantName':
      case 'printUser':
        return key in ctx ? String(ctx[key]) : '';
      default:
        return '';
    }
  }

  /** 日期偏移：解析 [+-]n[unit]，unit ∈ y/M/w/d/h/m（月大写、分小写），可累加如 '+1M3d'；与前端 shiftDate 同口径 */
  private shiftDate(base: Date, spec: string): Date {
    const s = String(spec ?? '').trim();
    if (!s) return base;
    const d = new Date(base.getTime());
    const re = /([+-]?)(\d+)([yMwdhm]?)/g;
    let m: RegExpExecArray | null;
    let matched = false;
    while ((m = re.exec(s))) {
      matched = true;
      const sign = m[1] === '-' ? -1 : 1;
      const n = sign * (parseInt(m[2], 10) || 0);
      const unit = m[3] || 'd';
      switch (unit) {
        case 'y': {
          const day = d.getDate();
          d.setDate(1);
          d.setFullYear(d.getFullYear() + n);
          const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
          d.setDate(Math.min(day, last));
          break;
        }
        case 'M': {
          const day = d.getDate();
          d.setDate(1);
          d.setMonth(d.getMonth() + n);
          const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
          d.setDate(Math.min(day, last));
          break;
        }
        case 'w': d.setDate(d.getDate() + n * 7); break;
        case 'd': d.setDate(d.getDate() + n); break;
        case 'h': d.setHours(d.getHours() + n); break;
        case 'm': d.setMinutes(d.getMinutes() + n); break;
      }
    }
    return matched ? d : base;
  }

  /** 简单日期格式化：YYYY/YY/MM/DD/HH/mm/ss；source=fixed 用 e.datetime.value */
  private formatDate(pattern: string, value: any, source: string | undefined, ctx: Record<string, any>, offset = ''): string {
    let d: Date;
    if (value instanceof Date) d = value;
    else if (typeof value === 'string' || typeof value === 'number') d = new Date(value);
    else if (source === 'fixed' && typeof ctx.__fixed === 'string') d = new Date(ctx.__fixed);
    else d = new Date();
    if (isNaN(d.getTime())) d = new Date();
    d = this.shiftDate(d, offset);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return String(pattern || 'YYYY-MM-DD')
      .replace(/YYYY/g, String(d.getFullYear()))
      .replace(/YY/g, String(d.getFullYear()).slice(2))
      .replace(/MM/g, p2(d.getMonth() + 1))
      .replace(/DD/g, p2(d.getDate()))
      .replace(/HH/g, p2(d.getHours()))
      .replace(/mm/g, p2(d.getMinutes()))
      .replace(/ss/g, p2(d.getSeconds()));
  }

  /** 通用元素 → ZPL 元素描述（处理器/指令导出共用） */
  toZplElements(elements: any[]): any[] {
    return elements
      .filter((e) => e.visible !== false && !e._skip)
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
      .flatMap((e) => {
        const base = { xMm: Number(e.x ?? 0), yMm: Number(e.y ?? 0), rotation: (e.rotation ?? 0) as any };
        if (TEXT_TYPES.has(e.type)) {
          const text = commandTextOf(e);
          if (!text) return [];
          return [{
            ...base,
            type: 'text',
            text,
            fontHeightMm: e.font?.size ? (e.font.size * 25.4) / 72 : 3,
            fontWidthMm: e.font?.size ? ((e.font.size * 25.4) / 72) * 0.6 : 1.8,
            bold: !!e.font?.bold,
          }];
        }
        if (e.type === 'barcode') {
          return [{ ...base, type: 'barcode', barcode: { ...e.barcode, content: String(e.barcode?.content ?? '') } }];
        }
        if (e.type === 'qrcode') {
          return [{
            ...base, type: 'qrcode', hMm: Number(e.h ?? 0),
            qrcode: { ...e.qrcode, content: String(e.qrcode?.content ?? '') },
          }];
        }
        if (e.type === 'image' && e.src) {
          return [{ ...base, type: 'image', imageData: e.src, imgWmm: e.w, imgHmm: e.h }];
        }
        // 图形：交给打印机原生画框/线/椭圆（不再退化成空文本）
        if (e.type === 'rect') {
          return [{
            ...base, type: 'box',
            wMm: Number(e.w ?? 0), hMm: Number(e.h ?? 0),
            borderMm: Number(e.stroke?.width ?? 0.3),
          }];
        }
        if (e.type === 'ellipse') {
          return [{
            ...base, type: 'ellipse',
            wMm: Number(e.w ?? 0), hMm: Number(e.h ?? 0),
            borderMm: Number(e.stroke?.width ?? 0.3),
          }];
        }
        if (e.type === 'line') {
          return [{
            ...base, type: 'line',
            x2Mm: Number(e.x2 ?? e.x ?? 0), y2Mm: Number(e.y2 ?? e.y ?? 0),
            strokeMm: Number(e.stroke?.width ?? 0.3),
          }];
        }
        // 表格：按单元格拆成文本（网格线由客户机/图像渲染，打印指令保留文字内容）
        if (e.type === 'table') return this.tableCellsToTexts(e);
        return [];
      });
  }

  /** 通用元素 → TSPL 元素描述 */
  toTsplElements(elements: any[]): any[] {
    return elements
      .filter((e) => e.visible !== false && !e._skip)
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
      .flatMap((e) => {
        const base = { xMm: Number(e.x ?? 0), yMm: Number(e.y ?? 0), rotation: (e.rotation ?? 0) as any };
        if (TEXT_TYPES.has(e.type)) {
          const text = commandTextOf(e);
          if (!text) return [];
          return [{
            ...base,
            type: 'text',
            text,
            fontHeightMm: e.font?.size ? (e.font.size * 25.4) / 72 : 3,
            bold: !!e.font?.bold,
          }];
        }
        if (e.type === 'barcode') {
          return [{ ...base, type: 'barcode', barcode: { ...e.barcode, content: String(e.barcode?.content ?? '') } }];
        }
        if (e.type === 'qrcode') {
          return [{
            ...base, type: 'qrcode', hMm: Number(e.h ?? 0),
            qrcode: { ...e.qrcode, content: String(e.qrcode?.content ?? '') },
          }];
        }
        if (e.type === 'rect') {
          return [{
            ...base, type: 'box',
            wMm: Number(e.w ?? 0), hMm: Number(e.h ?? 0),
            borderMm: Number(e.stroke?.width ?? 0.3),
          }];
        }
        if (e.type === 'ellipse') {
          return [{
            ...base, type: 'ellipse',
            wMm: Number(e.w ?? 0), hMm: Number(e.h ?? 0),
            borderMm: Number(e.stroke?.width ?? 0.3),
          }];
        }
        if (e.type === 'line') {
          return [{
            ...base, type: 'line',
            x2Mm: Number(e.x2 ?? e.x ?? 0), y2Mm: Number(e.y2 ?? e.y ?? 0),
            strokeMm: Number(e.stroke?.width ?? 0.3),
          }];
        }
        if (e.type === 'table') return this.tableCellsToTexts(e);
        return [];
      });
  }

  /**
   * 通用元素 → EPL2 元素描述（P7.7）。
   * 与 TSPL 映射基本同形（同一套 mm 字段），差别只有两处：
   *   · image 要映射出来 —— EPL 有 GW 图形指令，点阵由 attachBitmapFallbacks 预生成；
   *   · rect/line/ellipse 也要映射出来 —— 生成器对它们有「查证不到参数就不打」的明确 warning，
   *     在映射层悄悄丢掉的话，用户看到的是「标签上少了个框」而不是「EPL 打不了框」。
   */
  toEplElements(elements: any[]): any[] {
    return elements
      .filter((e) => e.visible !== false && !e._skip)
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
      .flatMap((e) => {
        const base = { xMm: Number(e.x ?? 0), yMm: Number(e.y ?? 0), rotation: (e.rotation ?? 0) as any };
        if (TEXT_TYPES.has(e.type)) {
          const text = commandTextOf(e);
          if (!text) return [];
          return [{
            ...base,
            type: 'text',
            text,
            fontHeightMm: e.font?.size ? (e.font.size * 25.4) / 72 : 3,
            fontWidthMm: e.font?.size ? ((e.font.size * 25.4) / 72) * 0.6 : 1.8,
            bold: !!e.font?.bold,
          }];
        }
        if (e.type === 'barcode') {
          return [{ ...base, type: 'barcode', barcode: { ...e.barcode, content: String(e.barcode?.content ?? '') } }];
        }
        if (e.type === 'qrcode') {
          return [{
            ...base, type: 'qrcode', hMm: Number(e.h ?? 0),
            qrcode: { ...e.qrcode, content: String(e.qrcode?.content ?? '') },
          }];
        }
        if (e.type === 'image' && e.src) {
          return [{ ...base, type: 'image', imageData: e.src, imgWmm: e.w, imgHmm: e.h }];
        }
        if (e.type === 'rect') {
          return [{ ...base, type: 'box', wMm: Number(e.w ?? 0), hMm: Number(e.h ?? 0), borderMm: Number(e.stroke?.width ?? 0.3) }];
        }
        if (e.type === 'ellipse') {
          return [{ ...base, type: 'ellipse', wMm: Number(e.w ?? 0), hMm: Number(e.h ?? 0), borderMm: Number(e.stroke?.width ?? 0.3) }];
        }
        if (e.type === 'line') {
          return [{ ...base, type: 'line', x2Mm: Number(e.x2 ?? e.x ?? 0), y2Mm: Number(e.y2 ?? e.y ?? 0), strokeMm: Number(e.stroke?.width ?? 0.3) }];
        }
        if (e.type === 'table') return this.tableCellsToTexts(e);
        return [];
      });
  }

  /** 表格元素 → 单元格文本（ZPL / TSPL / EPL 三个映射共用；网格线不进打印机指令，只保留文字） */
  private tableCellsToTexts(e: any): any[] {
    const rows = Math.max(1, e.rows || 1);
    const cols = Math.max(1, e.cols || 1);
    const cw = Number(e.w ?? 0) / cols;
    const ch = Number(e.h ?? 0) / rows;
    const fh = e.font?.size ? (e.font.size * 25.4) / 72 : 2;
    const out: any[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const txt = String(e.cells?.[r * cols + c] ?? '');
        if (!txt) continue;
        out.push({
          xMm: Number(e.x ?? 0) + c * cw + 0.5,
          yMm: Number(e.y ?? 0) + r * ch + 0.4,
          rotation: 0,
          type: 'text',
          text: txt,
          fontHeightMm: fh,
          fontWidthMm: fh * 0.6,
        });
      }
    }
    return out;
  }
}
