// 订阅服务：查询租户当前订阅、用量
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription, Plan, PlanModule, TenantModule } from '../entities/saas.entity';

@Injectable()
export class SubscriptionService {
  constructor(
    @InjectRepository(Subscription) private subs: Repository<Subscription>,
    @InjectRepository(Plan) private plans: Repository<Plan>,
    @InjectRepository(PlanModule) private planModules: Repository<PlanModule>,
    @InjectRepository(TenantModule) private tenantModules: Repository<TenantModule>,
  ) {}

  /** 获取租户当前激活的订阅 + 套餐详情 + 开通模块 */
  async getByTenant(tenantId: number) {
    const sub = await this.subs.findOne({
      where: { tenantId, status: 'active' },
    });
    if (!sub) {
      // 回退查 trial
      const trial = await this.subs.findOne({
        where: { tenantId, status: 'trial' },
      });
      if (!trial) throw new NotFoundException('该租户暂无有效订阅');
      return this.format(trial);
    }
    return this.format(sub);
  }

  private async format(sub: Subscription) {
    const plan = await this.plans.findOne({ where: { id: sub.planId } });
    const tmods = await this.tenantModules.find({
      where: { tenantId: sub.tenantId, status: 'active' },
    });
    return {
      subscription: {
        id: sub.id,
        status: sub.status,
        startedAt: sub.startedAt,
        endsAt: sub.endsAt,
      },
      plan: plan ? {
        id: plan.id, code: plan.code, name: plan.name,
        description: plan.description,
      } : null,
      modules: tmods.map((m) => m.moduleCode),
    };
  }

  /** 用量概览（先聚合 print_jobs，后续扩展 AI 次数等） */
  async usage(tenantId: number) {
    // 用原始查询跨表聚合——后续可按实际业务表扩展
    return {
      tenantId,
      period: 'month',
      printJobs: { used: 0, limit: -1 },   // -1 表示无限制
      aiGenerations: { used: 0, limit: 50 },
    };
  }
}
