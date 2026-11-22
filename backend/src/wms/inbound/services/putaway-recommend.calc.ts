// 上架推荐规则（阶段一"轻策略"，替代策略引擎）——纯函数，便于单测。
// 输入：规则列表 + 候选库位 + 物料属性；输出：推荐库位 + 可解释原因。
export interface PutawayRule {
  id?: number;
  priority: number;
  conditionJson: Record<string, any>;   // 如 { abc: 'A', maxUtilization: 0.8, zone: 'FAST' }
  actionJson: Record<string, any>;      // 如 { zoneCode: 'FAST', sortBy: 'DISTANCE' }
  enabled: boolean;
}

export interface CandidateLocation {
  id: number;
  code: string;
  zone?: string | null;
  utilization?: number | null;   // 0..1，越大越满
  sortKey?: number | null;       // 距离/顺序，越小越优先
}

export interface RecommendInput {
  rules: PutawayRule[];
  locations: CandidateLocation[];
  material?: { abc?: string | null; code?: string };
}

export interface RecommendResult {
  locationId: number | null;
  locationCode: string | null;
  reason: string;
  ruleId?: number;
}

/** 规则条件匹配：支持的键 abc / zone / maxUtilization；空条件视为兜底匹配 */
function matches(cond: Record<string, any>, mat: RecommendInput['material'], loc: CandidateLocation): boolean {
  if (cond.abc && mat?.abc && String(cond.abc) !== String(mat.abc)) return false;
  if (cond.zone && String(cond.zone) !== String(loc.zone ?? '')) return false;
  if (cond.maxUtilization != null && (loc.utilization ?? 0) > Number(cond.maxUtilization)) return false;
  if (cond.zoneCode && String(cond.zoneCode) !== String(loc.zone ?? '')) return false;
  return true;
}

/**
 * 推荐算法：
 *   1) 启用的规则按 priority 升序（数字小者优先）逐条尝试；
 *   2) 第一条"有候选库位命中"的规则胜出，按 action.sortBy 排序取首位；
 *   3) 无规则命中 → 全候选按 utilization 升序再 sortKey 升序取空位；
 *   4) 无任何库位 → 返回 null（调用方需据此拒绝过账，杜绝无库位库存）。
 */
export function recommendLocation(input: RecommendInput): RecommendResult {
  const { rules, locations, material } = input;
  if (!locations.length) {
    return { locationId: null, locationCode: null, reason: '仓库无可用库位，无法过账（禁止无库位库存）' };
  }
  const sorted = [...(rules ?? [])]
    .filter((r) => r.enabled)
    .sort((a, b) => Number(a.priority) - Number(b.priority));

  for (const rule of sorted) {
    const cond = rule.conditionJson ?? {};
    const hits = locations.filter((l) => matches(cond, material, l));
    if (!hits.length) continue;
    const sortBy = String(rule.actionJson?.sortBy ?? 'UTILIZATION');
    hits.sort((a, b) => {
      if (sortBy === 'DISTANCE') return (a.sortKey ?? 0) - (b.sortKey ?? 0);
      return (a.utilization ?? 0) - (b.utilization ?? 0);
    });
    const pick = hits[0];
    return {
      locationId: pick.id,
      locationCode: pick.code,
      reason: `命中上架规则#${rule.id ?? '?'}（priority=${rule.priority}，sortBy=${sortBy}）→ 库位 ${pick.code}`,
      ruleId: rule.id,
    };
  }

  // 兜底：最空的库位
  const fallback = [...locations].sort((a, b) =>
    (a.utilization ?? 0) - (b.utilization ?? 0) || (a.sortKey ?? 0) - (b.sortKey ?? 0));
  const pick = fallback[0];
  return {
    locationId: pick.id, locationCode: pick.code,
    reason: `无规则命中，兜底选最空库位 ${pick.code}（利用率 ${((pick.utilization ?? 0) * 100).toFixed(0)}%）`,
  };
}
