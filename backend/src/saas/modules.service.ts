// 模块服务：查询租户已开通模块、套餐模块目录
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ModuleRecord, Plan, PlanModule, TenantModule } from '../entities/saas.entity';

@Injectable()
export class ModulesService {
  private log = new Logger('ModulesService');

  constructor(
    @InjectRepository(ModuleRecord) private modules: Repository<ModuleRecord>,
    @InjectRepository(TenantModule) private tenantModules: Repository<TenantModule>,
    @InjectRepository(Plan) private plans: Repository<Plan>,
    @InjectRepository(PlanModule) private planModules: Repository<PlanModule>,
  ) {}

  /** 列出租户当前 active 的模块 code 列表（供 TenantContextInterceptor 用） */
  async listTenantActive(tenantId: number): Promise<string[]> {
    const rows = await this.tenantModules.find({
      where: { tenantId, status: In(['active', 'trial']) },
    });
    return rows.map((r) => r.moduleCode);
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
      sortOrder: m.sortOrder,
    }));
  }

  /** 全量模块目录（平台视角） */
  async listAll() {
    const mods = await this.modules.find({ order: { sortOrder: 'ASC' } });
    return mods.map((m) => ({
      code: m.code, name: m.name, icon: m.icon,
      description: m.description, isCore: m.isCore, sortOrder: m.sortOrder,
    }));
  }

  /** 全量套餐列表 + 套餐含哪些模块 */
  async listPlans() {
    const plans = await this.plans.find({ order: { sortOrder: 'ASC' } });
    const result = [];
    for (const p of plans) {
      const pms = await this.planModules.find({ where: { planId: p.id } });
      result.push({
        id: p.id, code: p.code, name: p.name,
        description: p.description, sortOrder: p.sortOrder,
        modules: pms.map((pm) => pm.moduleCode),
      });
    }
    return result;
  }
}
