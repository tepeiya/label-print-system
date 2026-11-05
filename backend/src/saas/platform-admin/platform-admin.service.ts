import { Injectable, OnModuleInit, UnauthorizedException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { PlatformUser } from './platform-user.entity';
import { Tenant } from '../../entities/tenant.entity';
import { Plan, PlanModule } from '../../entities/saas.entity';
import { ProvisionService } from '../provision.service';
import { ModulesService } from '../modules.service';
import { PlatformAuditService } from './platform-audit.service';
import { TenantDataSourceManager } from '../../common/tenant-data-source.manager';

import { EXPIRE_WARN_DAYS, filterExpiring } from './expire.util';

@Injectable()
export class PlatformAdminService implements OnModuleInit {
  constructor(
    @InjectRepository(PlatformUser) private platformUsers: Repository<PlatformUser>,
    @InjectRepository(Tenant) private tenants: Repository<Tenant>,
    @InjectRepository(Plan) private plans: Repository<Plan>,
    @InjectRepository(PlanModule) private planModules: Repository<PlanModule>,
    private jwt: JwtService,
    private provisionSvc: ProvisionService,
    private modulesSvc: ModulesService,
    private platformAudit: PlatformAuditService,
    private tdsm: TenantDataSourceManager,
  ) {}

  // -------------------------------------------------------------- 平台身份

  /** 平台运营登录：platform_users 表校验，签 scope='platform' 的独立 JWT（§11.6.2） */
  async login(username: string, password: string) {
    const u = await this.platformUsers.findOne({ where: { username } });
    if (!u || u.status !== 1 || !(await bcrypt.compare(password, u.passwordHash))) {
      throw new UnauthorizedException('平台账号或密码错误');
    }
    const accessToken = this.jwt.sign({
      sub: u.id, username: u.username, role: u.role, scope: 'platform',
    }, { expiresIn: '2h' });
    // 平台会话不落 refresh token 表（platform 没接 refresh 机制，2h 过期重登）
    await this.platformAudit.write({ id: u.id, username: u.username }, 'platform.login', { role: u.role }, 'platform_user', u.id);
    return {
      accessToken,
      user: { id: u.id, username: u.username, displayName: u.displayName, role: u.role },
    };
  }

  // -------------------------------------------------------------- 租户运营

  listTenants() { return this.provisionSvc.listTenants(); }
  provision(dto: any) { return this.provisionSvc.provision(dto); }
  addModule(tenantId: number, moduleCode: string, source: 'addon' | 'manual' | 'gift' = 'addon') {
    return this.provisionSvc.addModule(tenantId, moduleCode, source);
  }
  disableModule(tenantId: number, moduleCode: string) { return this.provisionSvc.disableModule(tenantId, moduleCode); }
  cancel(tenantId: number) { return this.provisionSvc.cancel(tenantId); }

  /** 停用 / 恢复（§11.6.2 suspend | resume）：tenants.status 翻转 + 模块缓存失效 */
  async setEnabled(actor: { id: number; username: string }, tenantId: number, enabled: boolean) {
    const tenant = await this.tenants.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException(`租户 ${tenantId} 不存在`);
    const target = enabled ? 1 : 0;
    if (tenant.status !== target) {
      await this.tenants.update({ id: tenantId }, { status: target });
      this.modulesSvc.invalidate(tenantId);
      await this.platformAudit.write(actor, enabled ? 'platform.resume' : 'platform.suspend',
        { tenantId, code: tenant.code }, 'tenant', tenantId);
    }
    return { tenantId, enabled };
  }

  // -------------------------------------------------------------- 套餐配置

  /** 套餐列表（含模块）——运营后台的「套餐配置」页数据源 */
  async listPlans() {
    const plans = await this.plans.find({ order: { sortOrder: 'ASC' } });
    const pms = await this.planModules.find();
    return plans.map((p) => ({
      ...p,
      moduleCodes: pms.filter((m) => m.planId === p.id).map((m) => m.moduleCode),
    }));
  }

  /** 更新套餐（P2 起运营可在后台改套餐内容）：基本信息 + 全量替换 plan_modules */
  async updatePlan(actor: { id: number; username: string }, code: string, dto: { name?: string; description?: string; sortOrder?: number; moduleCodes?: string[] }) {
    const plan = await this.plans.findOne({ where: { code } });
    if (!plan) throw new NotFoundException(`套餐 "${code}" 不存在`);
    const patch: any = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
    if (Object.keys(patch).length) await this.plans.update({ id: plan.id }, patch);

    if (dto.moduleCodes) {
      const catalog = await this.modulesSvc.listCatalog();
      const unknown = dto.moduleCodes.filter((c) => !catalog.some((m) => m.code === c));
      if (unknown.length) throw new BadRequestException(`未知模块: ${unknown.join(', ')}`);
      await this.planModules.delete({ planId: plan.id });
      if (dto.moduleCodes.length) {
        await this.planModules.insert(dto.moduleCodes.map((c) => ({ planId: plan.id, moduleCode: c })));
      }
      // 套餐内容变了，所有走 plan 展开的缓存都要失效
      this.modulesSvc.invalidateAll();
    }
    await this.platformAudit.write(actor, 'platform.plan_update', { code, ...dto }, 'plan', plan.id);
    return this.plans.findOne({ where: { code } }).then((p) => ({
      ...p,
      moduleCodes: dto.moduleCodes ?? null,
    }));
  }

  // -------------------------------------------------------------- 用量看板

  /** 全局用量看板（§11.6.2 GET /platform/usage）：跨租户只读聚合 */
  async usage() {
    const conn = this.tdsm.get({ dataSourceKey: 'default' });
    const totals: any = (await conn.query(`
      SELECT
        (SELECT count(*) FROM tenants) AS tenants_total,
        (SELECT count(*) FROM tenants WHERE status = 1) AS tenants_enabled,
        (SELECT count(*) FROM tenants WHERE canceled_at IS NOT NULL) AS tenants_canceled,
        (SELECT count(*) FROM users WHERE status = 1) AS users_active,
        (SELECT count(*) FROM templates) AS templates_total,
        (SELECT count(*) FROM print_jobs WHERE created_at > now() - interval '7 days') AS jobs_7d
    `))[0] ?? {};
    const tenants = await this.listTenants();
    const byPlan: Record<string, number> = {};
    for (const t of tenants) {
      const k = t.plan?.code ?? 'none';
      byPlan[k] = (byPlan[k] ?? 0) + 1;
    }
    return {
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v)])),
      byPlan,
      expiringSoon: this.filterExpiring(tenants, EXPIRE_WARN_DAYS),
    };
  }

  /** 纯函数在 expire.util.ts（单测不连实体），这里只是委托 */
  filterExpiring(tenants: any[], days = EXPIRE_WARN_DAYS) {
    return filterExpiring(tenants, days);
  }

  /** 到期提醒任务：启动时 + 每 24h 扫一次，快到期的打 WARN 日志（P3 接消息通道后改推送） */
  async scanExpiring() {
    const list = this.filterExpiring(await this.listTenants(), EXPIRE_WARN_DAYS);
    if (list.length) {
      console.warn(`[platform] ${list.length} 个租户的试用将在 ${EXPIRE_WARN_DAYS} 天内到期：`,
        list.map((t) => `${t.code}(${t.trialEndsAt})`).join(', '));
    }
    return list;
  }

  /** 最近平台审计（§11.6.2 GET /platform/audit） */
  listAudit(limit = 200) { return this.platformAudit.list(limit); }

  onModuleInit() {
    // 启动后 10s 跑第一次（避开启动风暴），之后每 24h 一次；unref 不阻塞进程退出
    const timer = setTimeout(() => { this.scanExpiring().catch(() => {}); }, 10_000);
    timer.unref();
    const daily = setInterval(() => { this.scanExpiring().catch(() => {}); }, 24 * 3600_000);
    daily.unref();
  }
}
