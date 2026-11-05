// 订阅服务：查询租户当前订阅、用量
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription, Plan, PlanModule, TenantModule } from '../entities/saas.entity';
import { UsageService } from '../billing/usage.service';

@Injectable()
export class SubscriptionService {
  constructor(
    @InjectRepository(Subscription) private subs: Repository<Subscription>,
    @InjectRepository(Plan) private plans: Repository<Plan>,
    @InjectRepository(PlanModule) private planModules: Repository<PlanModule>,
    @InjectRepository(TenantModule) private tenantModules: Repository<TenantModule>,
    private usageSvc: UsageService,
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
        // P3：月费（分），租户端 / 运营端展示用
        priceCents: Number(plan.priceCents ?? 0),
      } : null,
      modules: tmods.map((m) => m.moduleCode),
    };
  }

  /** 用量概览（P3 起读 usage_daily 真实聚合；limit=-1 表示未配硬配额，同旧契约） */
  async usage(tenantId: number) {
    const items = await this.usageSvc.monthSummary(tenantId);
    const pick = (meter: string) => items.find((i) => i.meter === meter);
    const print = pick('print_labels');
    const ai = pick('ai_generate');
    return {
      tenantId,
      period: 'month',
      printJobs: { used: print?.used ?? 0, limit: print?.hardLimit ?? -1 },
      aiGenerations: { used: ai?.used ?? 0, limit: ai?.hardLimit ?? -1 },
      items,
    };
  }
}
