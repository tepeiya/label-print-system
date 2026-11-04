// L3 数据范围（docs/11 §11.4.5）——纯函数，查询构造器统一入口
// 真实表结构：data_scopes(tenant_id, subject_type, subject_id, scope_type, scope_value)
export type ScopeType = 'all' | 'dept' | 'warehouse' | 'self';

export interface DataScope {
  type: ScopeType;
  values: string[];
}

export interface DataScopeRow {
  scopeType: ScopeType;
  scopeValue?: string | null;
}

/** 宽窄排序：命中越靠前的类型越宽，混合授权时取最宽的那个（P0 简化，见下方说明） */
const RANK: ScopeType[] = ['all', 'warehouse', 'dept', 'self'];

export const SCOPE_ALL: DataScope = { type: 'all', values: [] };

/**
 * 把某个主体（user / role / agent）的多行 data_scopes 合并成一个生效范围。
 * - 任意一行是 all → 直接 all（不再累加 values）
 * - 混合类型 → 取最宽的类型，并把同类型的所有 scope_value 并起来
 *   P0 只有 warehouse/dept 维度会用到，跨维度取交集留到有实际需求再做，避免过度设计。
 * - self 且没配具体值 → 用 selfId 作为唯一值（只能看自己的数据）
 */
export function mergeDataScopes(rows: DataScopeRow[], selfId?: number | string): DataScope {
  if (!rows?.length) {
    return selfId != null ? { type: 'self', values: [String(selfId)] } : SCOPE_ALL;
  }
  if (rows.some((r) => r.scopeType === 'all')) return SCOPE_ALL;

  const types = rows.map((r) => r.scopeType);
  const widest = RANK.find((t) => types.includes(t)) ?? 'self';
  const values = Array.from(
    new Set(
      rows
        .filter((r) => r.scopeType === widest)
        .map((r) => String(r.scopeValue ?? ''))
        .filter(Boolean),
    ),
  );

  if (widest === 'self' && !values.length && selfId != null) values.push(String(selfId));
  return { type: widest, values };
}

/**
 * 生成 TypeORM 查询片段：qb.andWhere(...clause.sql, clause.params)
 * scope.type === 'all' 时不加任何条件。
 */
export function scopeClause(
  column: string,
  scope: DataScope,
): { sql: string; params: Record<string, any> } {
  if (!scope || scope.type === 'all') return { sql: '1 = 1', params: {} };
  if (!scope.values.length) return { sql: '1 = 0', params: {} };   // 限定范围但没值 → 不放行
  return {
    sql: `${column} IN (:...dataScopeValues)`,
    params: { dataScopeValues: scope.values },
  };
}

/** 从租户上下文取数据范围（docs/11 的 dataScopeOf(ctx)） */
export function dataScopeOf(ctx: { dataScopes?: DataScope | null }): DataScope {
  return ctx?.dataScopes ?? SCOPE_ALL;
}
