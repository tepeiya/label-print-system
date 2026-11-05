// 租户级功能开关（D7）+ 数据范围（L3 §11.4.5）
// 两者都是「订阅之外」的灰度/范围控制：feature_flags 决定 Agent 能不能提交打印，
// data_scopes 决定同一个 operator 能看到哪些仓库/部门的数据。
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { DataScopeRecord, FeatureFlag, Role } from '../entities/saas.entity';
import { DataScope, DataScopeRow, mergeDataScopes } from '../common/data-scope';

/** 功能开关键名（新增键请在这里登记，避免字符串散落各处） */
export const FeatureKey = {
  AGENT_PRINT_SUBMIT: 'agent.print.submit',   // D7：默认 false
  AI_VISION: 'ai.vision',
} as const;

@Injectable()
export class TenantConfigService {
  constructor(
    @InjectRepository(FeatureFlag) private flags: Repository<FeatureFlag>,
    @InjectRepository(DataScopeRecord) private scopes: Repository<DataScopeRecord>,
    @InjectRepository(Role) private roles: Repository<Role>,
  ) {}

  /** 租户全部功能开关 → { key: enabled }，供 /auth/me 的 features 字段使用 */
  async featuresFor(tenantId: number): Promise<Record<string, boolean>> {
    if (!tenantId) return {};
    const rows = await this.flags.find({ where: { tenantId } });
    const map: Record<string, boolean> = {};
    for (const r of rows) map[r.key] = !!r.enabled;
    return map;
  }

  /** 单个开关（缺省视为关闭——灰度功能默认不可见） */
  async isEnabled(tenantId: number, key: string): Promise<boolean> {
    if (!tenantId) return false;
    const row = await this.flags.findOne({ where: { tenantId, key } });
    return !!row?.enabled;
  }

  /**
   * 开关的 rollout 明细（P5 限流用：feature_flags['agent.rate_limit'].rollout = {rpm: N}）。
   * 与 isEnabled 不同，这里不看 enabled —— 灰度「阈值」和「是否放行」是两件事，
   * 运营只改 rollout 就能调 RPM，不必开开关。
   */
  async rolloutFor(tenantId: number, key: string): Promise<Record<string, any> | null> {
    if (!tenantId) return null;
    const row = await this.flags.findOne({ where: { tenantId, key } });
    return row?.rollout ?? null;
  }

  /** 写入/更新开关（平台或租户管理员操作后调用，D7 的灰度入口） */
  async setFlag(tenantId: number, key: string, enabled: boolean, rollout: Record<string, any> = {}) {
    const existing = await this.flags.findOne({ where: { tenantId, key } });
    if (existing) {
      existing.enabled = enabled;
      existing.rollout = rollout;
      return this.flags.save(existing);
    }
    return this.flags.save(this.flags.create({ tenantId, key, enabled, rollout }));
  }

  /**
   * 当前用户生效的数据范围。
   * 主体优先级：user 级授权 + role 级授权合并（§11.4.5 未规定先后，实现上取并集更不易误伤）。
   * 没有任何 data_scopes 记录时视为 all —— 保持对存量租户零行为变化。
   */
  async dataScopeFor(tenantId: number, userId: number, roleCodes: string[] = []): Promise<DataScope> {
    if (!tenantId) return { type: 'all', values: [] };

    const rows: DataScopeRow[] = [];

    const userRows = await this.scopes.find({
      where: { tenantId, subjectType: 'user', subjectId: userId },
    });
    rows.push(...userRows.map((r) => ({ scopeType: r.scopeType, scopeValue: r.scopeValue })));

    if (roleCodes?.length) {
      const roleIds = await this.roles.find({
        where: { tenantId, code: In(roleCodes) },
      });
      const ids = roleIds.map((r) => r.id);
      if (ids.length) {
        const roleRows = await this.scopes.find({
          where: { tenantId, subjectType: 'role', subjectId: In(ids) },
        });
        rows.push(...roleRows.map((r) => ({ scopeType: r.scopeType, scopeValue: r.scopeValue })));
      }
    }

    return mergeDataScopes(rows, userId);
  }
}
