// 渲染服务：模板 + 数据行 + 流水号 → 每行的元素数组（已替换占位/公式/流水号）
// 注：不依赖 @nestjs/common 装饰器，既可在 NestJS 中作为 provider，也可独立单测。
// 元素类型在后端本地定义，避免跨 rootDir 引用前端代码。
import { safeEval } from '../../core/formula-engine';

interface RenderElement {
  id: string; type: string; text?: string; font?: any;
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
   */
  renderRow(elements: RenderElement[], row: Record<string, any>, serials: Record<string, string[]>, sysVars: Record<string, any>, rowIndex = 0): RenderElement[] {
    const ctx = { ...row, ...sysVars };
    return elements.map((el) => {
      const e: any = { ...el };
      // 条件打印：printIf 表达式为假则跳过该元素
      if (typeof e.printIf === 'string' && e.printIf.trim()) {
        const cond = safeEval(e.printIf, ctx);
        if (cond.ok && !cond.value) e._skip = true;
      } else if (e.printIf && typeof e.printIf === 'object' && e.printIf.enabled === false) {
        e._skip = true;
      }
      if (e.type === 'text' || e.type === 'richtext') {
        e.text = this.interp(e.text ?? '', ctx);
        if (Array.isArray(e.cells)) e.cells = e.cells.map((c: any) => this.interp(String(c ?? ''), ctx));
      } else if (e.type === 'barcode') {
        e.barcode = { ...e.barcode, content: this.interp(e.barcode.content ?? '', ctx) };
      } else if (e.type === 'qrcode') {
        e.qrcode = { ...e.qrcode, content: this.interp(e.qrcode.content ?? '', ctx) };
      } else if (e.type === 'formula') {
        const r = safeEval(e.formula.expr, ctx);
        e.rendered = r.ok ? String(r.value) : '{{ERROR}}'; // 出错不阻断整单
      } else if (e.type === 'serial') {
        const arr = serials[e.id] ?? [];
        e.rendered = arr[rowIndex] ?? ''; // 第 rowIndex 行的流水号（按行切片）
      } else if (e.type === 'datetime') {
        e.rendered = this.formatDate(e.datetime?.pattern ?? 'YYYY-MM-DD', e.datetime?.source === 'data' ? ctx : new Date(), e.datetime?.source, ctx);
      } else if (e.type === 'sysvar') {
        const key = e.sysvar?.key ?? e.key ?? '';
        e.rendered = key && key in ctx ? String(ctx[key]) : '';
      } else if (e.type === 'image') {
        e.src = this.interp(e.src ?? '', ctx);
      }
      return e;
    });
  }

  /** 替换 {{name}} 占位（变量缺失留空，不报错） */
  private interp(s: string, ctx: Record<string, any>): string {
    return String(s ?? '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => (k in ctx ? String(ctx[k]) : ''));
  }

  /** 简单日期格式化：YYYY/YY/MM/DD/HH/mm/ss；source=fixed 用 e.datetime.value */
  private formatDate(pattern: string, value: any, source: string | undefined, ctx: Record<string, any>): string {
    let d: Date;
    if (value instanceof Date) d = value;
    else if (typeof value === 'string' || typeof value === 'number') d = new Date(value);
    else if (source === 'fixed' && typeof ctx.__fixed === 'string') d = new Date(ctx.__fixed);
    else d = new Date();
    if (isNaN(d.getTime())) d = new Date();
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
        if (e.type === 'text' || e.type === 'formula' || e.type === 'serial' || e.type === 'datetime' || e.type === 'sysvar') {
          const text = String(e.rendered ?? e.text ?? '');
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
        if (e.type === 'table') {
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
        if (e.type === 'text' || e.type === 'formula' || e.type === 'serial' || e.type === 'datetime' || e.type === 'sysvar') {
          const text = String(e.rendered ?? e.text ?? '');
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
        if (e.type === 'table') {
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
              });
            }
          }
          return out;
        }
        return [];
      });
  }
}
