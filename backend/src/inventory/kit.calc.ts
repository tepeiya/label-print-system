// =============================================================================
// kit.calc —— 齐套率纯计算（docs/11 §11.7.2 bom.check_kit_rate / explain_shortage）
// 无 TypeORM / Nest 依赖：单测与 tsx 测试链路都不能 import 实体类（装饰器元数据缺失）。
//
// 口径：
//   单件净需求 unitNeed = qty_per × (1 + loss_rate)
//   可配套数 maxSets    = min over 行 ( floor(available / unitNeed) )，无行时按 0
//   齐套率   kitRate    = floor(maxSets / demand × 10000) / 100（%，向下取整防虚报）
//   行缺口   shortage  = max(0, round3(demand × unitNeed − available))
// =============================================================================

/** 四舍五入到 3 位小数（金额/数量展示口径，规避浮点长尾） */
export function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

export interface BomLineInput {
  materialId: number;
  code: string;
  name: string;
  unit: string;
  /** BOM 单件用量 */
  qtyPer: number;
  /** 损耗率（0.05 = 5%） */
  lossRate: number;
  /** 当前可用库存（按仓过滤后的合计） */
  available: number;
}

export interface KitLineResult {
  materialId: number;
  code: string;
  name: string;
  unit: string;
  qtyPer: number;
  lossRate: number;
  /** 本次需求下应耗量 */
  needed: number;
  available: number;
  /** 缺料数量（>=0） */
  shortage: number;
  /** 单看这一行最多能配几套 */
  maxSets: number;
  ok: boolean;
}

export interface KitOutcome {
  demand: number;
  /** 可配套数 */
  maxSets: number;
  /** 齐套率 0–100 */
  kitRate: number;
  lines: KitLineResult[];
  /** 缺料行（shortage > 0） */
  shortages: KitLineResult[];
}

/** LIKE 转义：% _ 与反斜杠按 PG LIKE 规则前置反斜杠（配合 ESCAPE '\' 默认行为） */
export function escapeLike(input: string): string {
  return String(input ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function computeKit(rawLines: BomLineInput[], demand: number): KitOutcome {
  const d = Number(demand);
  if (!Number.isFinite(d) || d <= 0) throw new Error('demand 必须是正数');
  const lines: KitLineResult[] = rawLines.map((l) => {
    const unitNeed = Math.max(0, Number(l.qtyPer) * (1 + Number(l.lossRate || 0)));
    const avail = Math.max(0, Number(l.available));
    const needed = round3(unitNeed * d);
    // 行数太多/浮点临界：floor 前留 1e-9 容差（如 5.25×60=314.9999… 应算 60 套）
    const max = unitNeed <= 0 ? Infinity : Math.floor(avail / unitNeed + 1e-9);
    const shortage = Math.max(0, round3(needed - avail));
    return {
      materialId: l.materialId, code: l.code, name: l.name, unit: l.unit,
      qtyPer: Number(l.qtyPer), lossRate: Number(l.lossRate || 0),
      needed, available: avail, shortage, maxSets: max, ok: shortage <= 0,
    };
  });
  const finite = lines.filter((l) => Number.isFinite(l.maxSets));
  // 所有行都不耗料（qtyPer×(1+loss)=0）时视为可全配
  const maxSets = lines.length === 0 ? 0 : (finite.length === 0 ? d : Math.min(...finite.map((l) => l.maxSets)));
  const bounded = Math.min(maxSets, d); // 齐套率分母是需求，配超出没有意义
  const kitRate = Math.floor((bounded / d) * 10000) / 100;
  return {
    demand: d,
    maxSets: bounded,
    kitRate,
    lines,
    shortages: lines.filter((l) => l.shortage > 0),
  };
}

/** 缺料友好摘要（§11.7.4「返回带摘要」）；无缺料返回 null */
export function shortageSummaryText(productName: string, kit: KitOutcome): string | null {
  if (!kit.shortages.length) return null;
  const parts = kit.shortages.slice(0, 3)
    .map((l) => `${l.name} 缺 ${l.shortage}${l.unit}`);
  const more = kit.shortages.length > 3 ? `等 ${kit.shortages.length} 项` : '';
  return `${productName} 按需求 ${kit.demand} 计算：${parts.join('、')}${more}；可配套 ${kit.maxSets}，齐套率 ${kit.kitRate}%`;
}
