// =============================================================================
// serial-number.service.ts —— 流水号并发安全服务
// 设计目标：批量打印时「不重号、可配跳号/回滚」，高并发下吞吐高。
//
// 并发安全三要素：
//   1) 行级锁：分配号段时 SELECT ... FOR UPDATE 锁住序列行，串行化分配。
//   2) 号段预分配：一次批量打印只锁一次，预占 [old, old+N*step) 共 N 个号，
//      在应用内存中切片分配，避免逐条加锁。对比「逐条 FOR UPDATE」吞吐提升明显。
//   3) 周期重置：分配前按 reset_cycle（不重置/日/月/年/自定义）判定是否归位。
//
// 跳号/回滚策略：rollback_policy = 'consume' 表示打印失败也消费号段（允许跳号，
// 保证审计连续）；'rollback' 表示失败时回退号段（不跳号，但可能与其他批次竞争）。
// =============================================================================

// 说明：本文件为纯逻辑实现，不依赖 @nestjs/common，便于单测/独立运行。
// 在 NestJS 项目中通过模块 providers 注册即可（无需装饰器）。

// —— 以下为与 ORM 解耦的“数据访问抽象”，实际接入 TypeORM/Prisma 时替换实现 ——
export interface DbManager {
  // 在事务内执行；tx 为事务句柄
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  // 加行锁查询序列（PostgreSQL：SELECT ... FOR UPDATE）
  queryOneForUpdate(tx: any, sql: string, params: any[]): Promise<SerialRow | undefined>;
  // 原子自增当前值并写回重置时间
  updateCurrent(tx: any, sql: string, params: any[]): Promise<void>;
  insertUsage(tx: any, sql: string, params: any[]): Promise<void>;
}

interface SerialRow {
  id: number;
  tenant_id: number;
  name: string;
  scope: string;
  group_key: string | null;
  start_value: number;
  step: number;
  current_value: number;
  digits: number;
  prefix: string;
  suffix: string;
  radix: number;
  reset_cycle: string;
  reset_at: Date | null;
  custom_cycle_days: number | null;
  allow_manual_reset: boolean;
  consume_mode: string;
  rollback_policy: string;
  version: number;
}

export interface AllocatedSegment {
  sequenceId: number;
  startValue: number;             // 含
  endValue: number;               // 不含（下一个待分配）
  values: string[];               // 格式化后的 N 个号
}

export class SerialNumberService {
  constructor(private db: DbManager) {}

  /**
   * 分配 count 个连续流水号（批量打印核心入口）。
   * @param tenantId 租户 id（强制隔离，禁止前端指定）
   * @param ref 序列标识：name 或 `${scope}:${groupKey}`
   * @param count 需要的数量（= 数据行数 或 1，视 consume_mode）
   */
  async allocate(
    tenantId: number,
    ref: string,
    count: number,
  ): Promise<AllocatedSegment> {
    if (count <= 0) throw new Error('count 必须 > 0');
    return this.db.transaction(async (tx) => {
      // 1) 行级锁查询（PostgreSQL FOR UPDATE；MySQL 用 SELECT ... FOR UPDATE 同样语法）
      const row = await this.db.queryOneForUpdate(
        tx,
        `SELECT * FROM serial_sequences
         WHERE tenant_id = $1 AND (name = $2 OR (scope || ':' || COALESCE(group_key,'')) = $2)
         FOR UPDATE`,                       // 行锁：分配期间其他事务阻塞
        [tenantId, ref],                    // 仅按 tenant_id + ref，杜绝跨租户
      );
      if (!row) throw new Error(`序列不存在: ${ref} (tenant=${tenantId})`);

      // 2) 周期重置判定
      const resetBase = this.shouldReset(row);
      const base = resetBase ? row.start_value : row.current_value;
      if (resetBase) row.reset_at = new Date();

      // 3) 号段预分配：原子推进游标
      const old = base;
      const next = old + count * row.step;   // N 个号，步长 step
      await this.db.updateCurrent(
        tx,
        `UPDATE serial_sequences
         SET current_value = $1, reset_at = $2, version = version + 1, updated_at = now()
         WHERE id = $3 AND tenant_id = $4`,   // 仍带 tenant_id，双保险
        [next, row.reset_at, row.id, tenantId],
      );

      // 4) 切片生成 N 个号并写使用记录
      const values: string[] = [];
      for (let k = 0; k < count; k++) {
        const v = old + row.step * k;
        const formatted = this.format(v, row);
        values.push(formatted);
        await this.db.insertUsage(
          tx,
          `INSERT INTO serial_usage_log
             (tenant_id, sequence_id, value, formatted, status, created_at)
           VALUES ($1,$2,$3,$4,'issued',now())`,
          [tenantId, row.id, v, formatted],
        );
      }
      return { sequenceId: row.id, startValue: old, endValue: next, values };
    });
  }

  /** 按位数前导补零 + 进制 + 前后缀 格式化 */
  private format(value: number, row: SerialRow): string {
    let body = value.toString(row.radix);          // 10/16/36 进制
    if (row.digits > 0) body = body.padStart(row.digits, '0');
    return `${row.prefix}${body}${row.suffix}`;
  }

  /** 是否到达重置周期（基于 reset_at 与当前时间比较） */
  private shouldReset(row: SerialRow): boolean {
    if (row.reset_cycle === 'never') return false;
    if (!row.reset_at) return true;               // 从未重置 → 首次重置到起点
    const now = Date.now();
    const last = row.reset_at.getTime();
    const day = 86_400_000;
    switch (row.reset_cycle) {
      case 'daily':   return now - last >= day;
      case 'monthly': return new Date(now).getMonth() !== new Date(last).getMonth()
                             || new Date(now).getFullYear() !== new Date(last).getFullYear();
      case 'yearly':  return new Date(now).getFullYear() !== new Date(last).getFullYear();
      case 'custom':  return row.custom_cycle_days != null
                             && now - last >= row.custom_cycle_days * day;
      default:        return false;
    }
  }

  /**
   * 打印失败回滚号段（rollback_policy='rollback' 时调用）。
   * 将最后一个批次的 'issued' 标记为 'rolled_back' 并把游标回退。
   */
  async rollbackSegment(tenantId: number, sequenceId: number, startValue: number, endValue: number) {
    return this.db.transaction(async (tx) => {
      await this.db.updateCurrent(
        tx,
        `UPDATE serial_sequences SET current_value = $1, version = version + 1
         WHERE id = $2 AND tenant_id = $3 AND current_value = $4`,
        [startValue, sequenceId, tenantId, endValue],   // 仅当游标未被他人推进才回退（CAS）
      );
      await this.db.insertUsage(
        tx,
        `UPDATE serial_usage_log SET status='rolled_back'
         WHERE tenant_id=$1 AND sequence_id=$2 AND value >= $3 AND value < $4 AND status='issued'`,
        [tenantId, sequenceId, startValue, endValue],
      );
    });
  }
}
