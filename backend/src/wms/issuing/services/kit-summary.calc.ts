// =============================================================================
// kit-summary.calc.ts —— 工单齐套的"行 + 整体"汇总（纯函数，docs/16 §5 / D3+D4）
//
// 单一公式来源：行级一律来自 inventory 的 computeKit（经 Gateway 取数），
// 本文件只做"整体可配套数 / 齐套率 / 缺料行 / 摘要文本"的汇总，不复制供需公式。
// =============================================================================
import { KitOutcome, KitLineResult, shortageSummaryText, round3 } from '../../../inventory/kit.calc';

export interface WoKitSummary {
  demand: number;
  /** 整体可配套数 = min(各行 maxSets)，并按需求封顶 */
  overallMaxSets: number;
  /** 整体齐套率 0–100（向下取整到 2 位） */
  overallKitRate: number;
  /** 缺料行（shortage > 0） */
  shortageLines: KitLineResult[];
  /** 友好摘要；无缺料时为 null */
  summaryText: string | null;
  lines: KitLineResult[];
}

/**
 * 汇总工单齐套。
 * @param kit   InventoryService.checkKit 的行级结果
 * @param demand 计划产出数（必须 ≥1）
 * @param productName 产品名（摘要文本用）
 */
export function summarizeWoKit(kit: KitOutcome, demand: number, productName: string): WoKitSummary {
  const d = Number(demand);
  if (!Number.isFinite(d) || d <= 0) throw new Error('demand 必须是正数');
  const lines = kit.lines ?? [];

  // 无行：0 套、0%，摘要给明确提示（文档 §5：不报错，返回友好提示）
  if (!lines.length) {
    return {
      demand: d, overallMaxSets: 0, overallKitRate: 0, shortageLines: [],
      summaryText: `${productName} 未找到可用的 BOM 明细行，齐套按 0 套计`,
      lines: [],
    };
  }

  // 不耗料的行（qtyPer × (1+loss) = 0）maxSets 为 Infinity，不参与取小
  const finite = lines.filter((l) => Number.isFinite(l.maxSets));
  const minSets = finite.length ? Math.min(...finite.map((l) => l.maxSets)) : d;
  const overallMaxSets = Math.min(minSets, d);
  const overallKitRate = Math.floor((overallMaxSets / d) * 10000) / 100;

  const shortageLines = lines.filter((l) => Number(l.shortage) > 0);
  const summaryText = shortageSummaryText(productName, {
    ...kit, demand: d, maxSets: overallMaxSets, kitRate: overallKitRate,
    lines, shortages: shortageLines,
  });

  return { demand: d, overallMaxSets, overallKitRate, shortageLines, summaryText, lines };
}

/** 缺料清单文本：每行一句（PDA / 打印用），按行号顺序由调用方拼 */
export function lineShortageText(line: {
  lineNo: number; name: string; unit: string; required: number; available: number; shortage: number;
}): string {
  return `第${line.lineNo}行 ${line.name}：可用 ${line.available}${line.unit} < 需求 ${line.required}${line.unit}，缺 ${round3(line.shortage)}${line.unit}`;
}
