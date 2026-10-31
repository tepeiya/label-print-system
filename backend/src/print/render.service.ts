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
      if (e.type === 'text' || e.type === 'richtext') {
        e.text = this.interp(e.text ?? '', ctx);
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
      }
      return e;
    });
  }

  /** 替换 {{name}} 占位（变量缺失留空，不报错） */
  private interp(s: string, ctx: Record<string, any>): string {
    return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => (k in ctx ? String(ctx[k]) : ''));
  }
}
