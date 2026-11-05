// 模块服务：查询租户已开通模块、模块目录、套餐，并缓存订阅结果
// 缓存策略：进程内 60s TTL + 变更时显式 invalidate（§11.13「订阅变更缓存未失效」的缓解措施）
// ⚠️ api / worker 双进程各有一份缓存，跨进程失效依赖 TTL，P2 上 Redis 后可改成广播
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ModuleRecord, Plan, PlanModule, Subscription, TenantModule } from '../entities/saas.entity';
import { ModuleDef, expandWithDependencies } from './module-deps';

const CACHE_TTL_MS = 60_000;

@Injectable()
export class ModulesService {
  private log = new Logger('ModulesService');
  private cache = new Map<number, { codes: string[]; at: number }>();

  constructor(
    @InjectRepository(ModuleRecord) private modules: Repository<ModuleRecord>,
    @InjectRepository(TenantModule) private tenantModules: Repository<TenantModule>,
    @InjectRepository(Plan) private plans: Repository<Plan>,
    @InjectRepository(PlanModule) private planModules: Repository<PlanModule>,
    @InjectRepository(Subscription) private subs: Repository<Subscription>,
  ) {}

  /** 列出租户当前 active 的模块 code 列表（含 trial），带 60s 缓存 */
  async listTenantActive(tenantId: number): Promise<string[]> {
    if (!tenantId) return [];
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.codes;

    const rows = await this.tenantModules.find({
      where: { tenantId, status: In(['active', 'trial']) },
    });
    const codes = rows.map((r) => r.moduleCode);
    this.cache.set(tenantId, { codes, at: Date.now() });
    return codes;
  }

  /** 订阅/模块变更后必须调用，否则最多要等 60s 才生效 */
  invalidate(tenantId: number) {
    this.cache.delete(tenantId);
  }

  /** 套餐内容变化影响所有租户（plan 展开结果变了），P2 套餐配置保存时用 */
  invalidateAll() {
    this.cache.clear();
  }

  /** 列出租户已开通模块的详细信息（含图标、是否 core） */
  async listTenantModules(tenantId: number) {
    const codes = await this.listTenantActive(tenantId);
    if (!codes.length) return [];
    const mods = await this.modules.find({
      where: { code: In(codes) },
      order: { sortOrder: 'ASC' },
    });
    return mods.map((m) => ({
      code: m.code,
      name: m.name,
      icon: m.icon,
      description: m.description,
      isCore: m.isCore,
      dependsOn: m.dependsOn ?? [],
      sortOrder: m.sortOrder,
    }));
  }

  /** 模块目录（含依赖关系），供依赖展开使用 */
  async listCatalog(): Promise<ModuleDef[]> {
    const mods = await this.modules.find({ order: { sortOrder: 'ASC' } });
    return mods.map((m) => ({ code: m.code, dependsOn: m.dependsOn ?? [], isCore: m.isCore }));
  }

  /** 全量模块目录（平台视角） */
  async listAll() {
    const mods = await this.modules.find({ order: { sortOrder: 'ASC' } });
    return mods.map((m) => ({
      code: m.code, name: m.name, icon: m.icon,
      description: m.description, isCore: m.isCore,
      dependsOn: m.dependsOn ?? [], trialDays: m.trialDays, sortOrder: m.sortOrder,
    }));
  }

  /** 全量套餐列表 + 套餐含哪些模块（已按依赖补齐，方便运营后台直接展示） */
  async listPlans() {
    const plans = await this.plans.find({ order: { sortOrder: 'ASC' } });
    const catalog = await this.listCatalog();
    const result = [];
    for (const p of plans) {
      const pms = await this.planModules.find({ where: { planId: p.id } });
      const raw = pms.map((pm) => pm.moduleCode);
      result.push({
        id: p.id, code: p.code, name: p.name,
        description: p.description, sortOrder: p.sortOrder,
        // P3：月费（分）。GET /platform/plans 实际命中的是本方法（PlatformController 先注册），
        // 运营端 Plans 页的价格列数据源在这里，不在 platform-admin 的同名路由上。
        priceCents: Number(p.priceCents ?? 0),
        modules: raw,
        effectiveModules: expandWithDependencies(raw, catalog),
      });
    }
    return result;
  }

  /** 租户当前套餐（无有效订阅返回 null，不抛错——守卫与 /auth/me 都要容错） */
  async getPlan(tenantId: number): Promise<{ code: string; name: string } | null> {
    if (!tenantId) return null;
    const sub = await this.subs.findOne({ where: { tenantId, status: In(['active', 'trial']) } });
    if (!sub) return null;
    const plan = await this.plans.findOne({ where: { id: sub.planId } });
    return plan ? { code: plan.code, name: plan.name } : null;
  }

  /** 订阅状态（trial / active / canceled / expired），无订阅返回 null */
  async getSubscriptionStatus(tenantId: number): Promise<Subscription | null> {
    if (!tenantId) return null;
    return this.subs.findOne({ where: { tenantId, status: In(['active', 'trial']) } });
  }
}
