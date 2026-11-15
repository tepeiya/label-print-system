// =============================================================================
// dedicated.orchestration.calc.ts —— P6.2 阶段 B：独立库开通编排状态机（纯函数）
//
// 【红线】`tenants.data_source_key` 是「业务读写到底落哪个库」的唯一切换开关。
// 一旦在 DDL / 数据迁移 / 行数校验没全部通过之前就切了 key，租户的写请求会打到
// 一个空库 —— 数据丢失比「没开通」严重得多。所以状态机把 switch_key 设成
// **只有 verify_counts 通过后才可达**，任何失败都进 rolling_back，绝不切 key。
//
// 【DSN 永不落库】编排器只在进程内存里持有 DSN；本文件不接触任何凭据。
// 审计/日志只用 maskDsn() 的脱敏形式（见 dedicated.calc.ts）。
// =============================================================================

export type ProvisionStep =
  | 'create_database'
  | 'run_ddl'
  | 'migrate_rows'
  | 'verify_counts'
  | 'register_datasource'
  | 'switch_key';

export type OrchestrationState =
  | 'idle'
  | 'running'
  | 'verifying'
  | 'switching'
  | 'rolling_back'
  | 'succeeded'
  | 'failed';

export type OrchestrationEvent =
  | 'start'
  | 'step_ok'
  | 'step_failed'
  | 'verify_ok'
  | 'verify_failed'
  | 'switch_ok'
  | 'rollback_done';

/** 固定执行顺序：注册放在 DDL 之后，因为 registerFromUrl 会做「库结构自检」 */
export const STEP_ORDER: ProvisionStep[] = [
  'create_database', 'run_ddl', 'migrate_rows', 'verify_counts', 'register_datasource', 'switch_key',
];

export const STEP_LABELS: Record<ProvisionStep, string> = {
  create_database: '建库',
  run_ddl: '跑全量 DDL',
  migrate_rows: '迁移租户行与业务数据',
  verify_counts: '行数校验',
  register_datasource: '注册数据源',
  switch_key: '切换 data_source_key',
};

export function nextStep(current: ProvisionStep | null): ProvisionStep | null {
  if (!current) return STEP_ORDER[0];
  const i = STEP_ORDER.indexOf(current);
  return i < 0 || i + 1 >= STEP_ORDER.length ? null : STEP_ORDER[i + 1];
}

/** 状态迁移表（非法事件保持原状态，不抛异常——编排器靠日志发现异常序列） */
export function stateTransition(
  state: OrchestrationState, event: OrchestrationEvent,
): OrchestrationState {
  switch (state) {
    case 'idle': return event === 'start' ? 'running' : 'idle';
    case 'running':
      if (event === 'step_failed') return 'rolling_back';
      if (event === 'verify_ok') return 'verifying';
      return 'running';
    case 'verifying':
      if (event === 'verify_failed') return 'rolling_back';
      if (event === 'step_ok' || event === 'switch_ok') return 'switching';
      return 'verifying';
    case 'switching':
      if (event === 'switch_ok' || event === 'step_ok') return 'succeeded';
      if (event === 'step_failed') return 'rolling_back';
      return 'switching';
    case 'rolling_back': return event === 'rollback_done' ? 'failed' : 'rolling_back';
    case 'succeeded':
    case 'failed': return state;   // 终态
    default: return state;
  }
}

/**
 * 是否允许切 key：**必须已完成 verify_counts 且校验通过**。
 * 编排器在真正 update tenants 之前再调一次，作为最后一道闸门（纵深防御）。
 */
export function canSwitchKey(
  completed: ProvisionStep[], verified: boolean, state: OrchestrationState,
): boolean {
  const required: ProvisionStep[] = STEP_ORDER.slice(0, STEP_ORDER.indexOf('switch_key'));
  return verified
    && required.every((s) => completed.includes(s))
    && (state === 'verifying' || state === 'switching');
}

/** 已完成的步骤 → 逆序回滚动作；不可逆的步骤明确标 auto=false，留给人工处置 */
export interface RollbackAction {
  step: ProvisionStep;
  action: string;
  /** 是否由编排器自动执行（drop database 这类高危动作默认不自动） */
  auto: boolean;
}

export function rollbackPlan(completed: ProvisionStep[]): RollbackAction[] {
  const actions: Record<ProvisionStep, RollbackAction> = {
    create_database: { step: 'create_database', action: '保留已建空库，由运维决定 DROP DATABASE（不自动删除）', auto: false },
    run_ddl: { step: 'run_ddl', action: 'DDL 幂等，无需回滚；空库留待人工处置', auto: false },
    migrate_rows: { step: 'migrate_rows', action: '按 tenant_id 删除目标库里已迁移的业务行', auto: true },
    verify_counts: { step: 'verify_counts', action: '只读步骤，无需回滚', auto: true },
    register_datasource: { step: 'register_datasource', action: '注销进程内数据源连接池', auto: true },
    switch_key: { step: 'switch_key', action: '把 tenants.data_source_key 切回 default（共享库）', auto: true },
  };
  return [...completed].reverse().map((s) => actions[s]).filter(Boolean);
}

/**
 * 行数校验：迁移前后每表行数必须一致。
 * 空表（0 行）也要求两边都是 0 —— 否则说明目标库多/少了一张表。
 */
export interface CountVerdict {
  ok: boolean;
  mismatches: string[];
  checkedTables: number;
}

export function verifyRowCounts(
  before: Record<string, number>, after: Record<string, number>,
): CountVerdict {
  const tables = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])).sort();
  const mismatches: string[] = [];
  for (const t of tables) {
    const b = Number(before?.[t] ?? 0);
    const a = Number(after?.[t] ?? 0);
    if (!Number.isFinite(b) || !Number.isFinite(a) || b !== a) {
      mismatches.push(`${t}: 源 ${b} / 目标 ${a}`);
    }
  }
  return { ok: mismatches.length === 0 && tables.length > 0, mismatches, checkedTables: tables.length };
}

/** 编排计划的**可打印**摘要（不含任何 DSN / 凭据） */
export function orchestrationSummary(key: string, tenantId: number, steps: ProvisionStep[] = STEP_ORDER) {
  return {
    tenantId,
    dataSourceKey: key,
    steps: steps.map((s, i) => ({ order: i + 1, step: s, label: STEP_LABELS[s] })),
    gate: 'switch_key 仅在 verify_counts 通过后执行；失败切回 default',
  };
}
