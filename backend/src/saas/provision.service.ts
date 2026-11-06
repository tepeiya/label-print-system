// 平台侧开通/加购/停用/取消（docs/11 §11.15.1 硬性约束 3、4、6）
// 开通租户必须一次性完成：建租户 + 建租户管理员 + 建订阅 + 按套餐展开模块（含依赖），且在同一事务内。
// 不做自助注册（D4）——只能由平台运营调用本服务。
import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Tenant, User, UserRole } from '../entities/tenant.entity';
import {
  FeatureFlag, Plan, PlanModule, Role, Subscription, TenantModule,
} from '../entities/saas.entity';
import { ModulesService } from './modules.service';
import { FeatureKey } from './tenant-config.service';
import { blockedByOnDisable, expandWithDependencies } from './module-deps';
import { TenantDataSourceManager } from '../common/tenant-data-source.manager';

/** 租户 code 会进备份文件名和 SQL，这里先卡死字符集 */
const TENANT_CODE_RE = /^[a-z][a-z0-9-]{1,59}$/;

export interface ProvisionTenantDto {
  name: string;
  code: string;
  planCode?: string;              // 默认 BASIC
  status?: 'trial' | 'active';    // 默认 trial（D4：试用由运营开通）
  trialDays?: number;
  seats?: number;
  adminUsername: string;
  adminPassword: string;
  adminDisplayName?: string;
  adminEmail?: string;
  type?: 'shared' | 'dedicated';
  dataSourceKey?: string;
}

@Injectable()
export class ProvisionService {
  private log = new Logger('ProvisionService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly modules: ModulesService,
    private readonly tdsm: TenantDataSourceManager,
  ) {}

  /** 开通租户（单事务，失败全回滚——§11.13「多 schema 事务：开通租户部分成功」的防线） */
  async provision(dto: ProvisionTenantDto) {
    const code = (dto.code ?? '').trim();
    const planCode = (dto.planCode ?? 'BASIC').trim().toUpperCase();
    const subStatus = dto.status === 'active' ? 'active' : 'trial';

    if (!dto.name?.trim()) throw new BadRequestException('租户名称不能为空');
    if (!TENANT_CODE_RE.test(code)) throw new BadRequestException('租户 code 需为小写字母开头的 a-z0-9-，长度 2–60');
    if (!dto.adminUsername?.trim()) throw new BadRequestException('管理员用户名不能为空');
    if (!dto.adminPassword || dto.adminPassword.length < 8) throw new BadRequestException('管理员密码至少 8 位');

    // P6.2 D2：独立库的「开通编排」没做（建库 / 跑 DDL / 搬运数据 / 业务读写接管），
    // 这里必须硬拒，不能先建一个 type='dedicated' 的租户让所有业务查询落到共享库——
    // 那就是「以为隔离了其实没隔离」，比不做更糟。
    if (dto.type === 'dedicated') {
      throw new BadRequestException(
        '独立库租户暂不支持在开通接口创建：请先用 POST /platform/datasources 注册 dataSourceKey，' +
        '再按 docs/11 §11.11 P6.2 的二阶段（建库 → 跑 DDL → 迁移租户行 → 切换 routing）人工编排',
      );
    }
    if (dto.dataSourceKey) {
      throw new BadRequestException('共享库租户不能指定 dataSourceKey（独立库编排未实现）');
    }

    const tenants = this.dataSource.getRepository(Tenant);
    if (await tenants.findOne({ where: { code } })) {
      throw new ConflictException(`租户 code "${code}" 已存在`);
    }
    const plan = await this.dataSource.getRepository(Plan).findOne({ where: { code: planCode } });
    if (!plan) throw new NotFoundException(`套餐 "${planCode}" 不存在`);

    const pms = await this.dataSource.getRepository(PlanModule).find({ where: { planId: plan.id } });
    const catalog = await this.modules.listCatalog();
    // §11.3.4：开通时自动补齐前置模块（订 bom 会连带开 inventory + masterdata）
    const moduleCodes = expandWithDependencies(pms.map((p) => p.moduleCode), catalog);

    const trialDays = Math.max(0, dto.trialDays ?? (subStatus === 'trial' ? 14 : 0));
    const endsAt = subStatus === 'trial'
      ? new Date(Date.now() + trialDays * 86_400_000)
      : null;

    const result = await this.dataSource.transaction(async (m) => {
      const tenant = await m.getRepository(Tenant).save(m.getRepository(Tenant).create({
        name: dto.name.trim(),
        code,
        status: 1,
        type: 'shared',
        dataSourceKey: null,
        planId: plan.id,
        seatLimit: dto.seats ?? 5,
        trialEndsAt: endsAt,
        branding: {},
        settings: {},
      }));

      // D3：事务内打上 app.tenant_id，P6 的 RLS 策略直接复用（P0 只写不消费）
      await this.tdsm.applyTenantScope(m, tenant.id);

      await m.getRepository(Subscription).insert({
        tenantId: tenant.id,
        planId: plan.id,
        status: subStatus,
        endsAt,
      });

      if (moduleCodes.length) {
        await m.getRepository(TenantModule).insert(
          moduleCodes.map((c) => ({
            tenantId: tenant.id,
            moduleCode: c,
            status: subStatus,                    // trial 订阅 → 模块也是 trial
            source: subStatus === 'trial' ? 'trial' : 'plan',
          })),
        );
      }

      // §11.12.2 第 2 步：给新租户复制一份内置角色，便于后续自定义
      const templates = await m.getRepository(Role).find({ where: { tenantId: IsNull() } });
      if (templates.length) {
        await m.getRepository(Role).insert(
          templates.map((t) => ({ tenantId: tenant.id, code: t.code, name: t.name, isSystem: true })),
        );
      }

      const userRepo = m.getRepository(User);
      const admin = await userRepo.save(userRepo.create({
        tenantId: tenant.id,
        username: dto.adminUsername.trim(),
        passwordHash: await bcrypt.hash(dto.adminPassword, 10),
        displayName: dto.adminDisplayName ?? '租户管理员',
        email: dto.adminEmail ?? undefined,
        status: 1,
      }));

      // 兼容期双写：role 用旧字符串（现有 RolesGuard / DDL CHECK 都认它），role_id 指向新角色
      const tenantAdminRole = await m.getRepository(Role).findOne({
        where: { tenantId: tenant.id, code: 'tenant_admin' },
      });
      await m.getRepository(UserRole).insert({
        tenantId: tenant.id,
        userId: admin.id,
        role: 'admin',
        roleId: tenantAdminRole?.id ?? null,
      });

      // D7：Agent 提交打印默认关闭
      await m.getRepository(FeatureFlag).insert([
        { tenantId: tenant.id, key: FeatureKey.AGENT_PRINT_SUBMIT, enabled: false, rollout: {} },
        { tenantId: tenant.id, key: FeatureKey.AI_VISION, enabled: true, rollout: {} },
      ]);

      return { tenant, admin, moduleCodes };
    });

    this.modules.invalidate(result.tenant.id);
    this.log.log(`租户已开通: ${code} / ${planCode} / ${subStatus}（模块 ${result.moduleCodes.length} 个）`);

    return {
      tenantId: result.tenant.id,
      code: result.tenant.code,
      name: result.tenant.name,
      plan: plan.code,
      subscriptionStatus: subStatus,
      trialEndsAt: endsAt,
      modules: result.moduleCodes,
      adminUserId: result.admin.id,
      adminUsername: result.admin.username,
    };
  }

  /** 平台视角租户列表（含订阅与模块数，§11.6.2 GET /platform/tenants） */
  async listTenants() {
    // 平台侧跨租户查询：走 TenantDataSourceManager，P6 会在这里换成 BYPASSRLS 的独立账号
    const rows: any[] = await this.tdsm.get({ dataSourceKey: 'default' }).query(`
      SELECT t.id, t.code, t.name, t.type, t.data_source_key, t.status, t.seat_limit, t.trial_ends_at, t.canceled_at,
             s.status AS subscription_status, p.code AS plan_code, p.name AS plan_name,
             (SELECT count(*) FROM tenant_modules tm WHERE tm.tenant_id = t.id
                AND tm.status IN ('active','trial')) AS module_count,
             (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 1) AS user_count
      FROM tenants t
      LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status IN ('active','trial')
      LEFT JOIN plans p ON p.id = s.plan_id
      ORDER BY t.id ASC
    `);
    return rows.map((r) => ({
      id: Number(r.id),
      code: r.code,
      name: r.name,
      type: r.type,
      dataSourceKey: r.data_source_key ?? null,
      enabled: r.status === 1,
      plan: r.plan_code ? { code: r.plan_code, name: r.plan_name } : null,
      subscriptionStatus: r.subscription_status ?? null,
      seatLimit: Number(r.seat_limit),
      userCount: Number(r.user_count),
      moduleCount: Number(r.module_count),
      trialEndsAt: r.trial_ends_at,
      canceledAt: r.canceled_at,
    }));
  }

  /** 加购单模块（D1：套餐外单独开通 source='addon'），同样自动补依赖 */
  async addModule(tenantId: number, moduleCode: string, source: 'addon' | 'manual' | 'gift' = 'addon') {
    await this.mustGetTenant(tenantId);
    const catalog = await this.modules.listCatalog();
    if (!catalog.some((c) => c.code === moduleCode)) {
      throw new NotFoundException(`模块 "${moduleCode}" 不在模块目录里`);
    }
    const codes = expandWithDependencies([moduleCode], catalog);
    const repo = this.dataSource.getRepository(TenantModule);
    const existing = await repo.find({ where: { tenantId, moduleCode: In(codes) } });
    const existingCodes = new Set(existing.map((e) => e.moduleCode));

    for (const c of codes) {
      if (existingCodes.has(c)) continue;
      await repo.insert({ tenantId, moduleCode: c, status: 'active', source });
    }
    this.modules.invalidate(tenantId);
    return { tenantId, added: codes.filter((c) => !existingCodes.has(c)), requested: moduleCode };
  }

  /** 停用模块：被依赖则拒绝（§11.3.4「请先停用 BOM」） */
  async disableModule(tenantId: number, moduleCode: string) {
    await this.mustGetTenant(tenantId);
    const active = await this.modules.listTenantActive(tenantId);
    if (!active.includes(moduleCode)) throw new NotFoundException(`租户未开通模块 "${moduleCode}"`);

    const catalog = await this.modules.listCatalog();
    const blockers = blockedByOnDisable(moduleCode, active, catalog);
    if (blockers.length) {
      throw new BadRequestException(`该模块被 ${blockers.join(' / ')} 依赖，请先停用它们`);
    }
    await this.dataSource.getRepository(TenantModule).update(
      { tenantId, moduleCode }, { status: 'disabled' },
    );
    this.modules.invalidate(tenantId);
    return { tenantId, moduleCode, status: 'disabled' };
  }

  /** 退订：写 canceled_at（D12 的 90 天硬删由 P6 删除任务消费） */
  async cancel(tenantId: number) {
    const tenant = await this.mustGetTenant(tenantId);
    const now = new Date();
    await this.dataSource.getRepository(Subscription).update(
      { tenantId, status: In(['active', 'trial']) }, { status: 'canceled', endsAt: now },
    );
    await this.dataSource.getRepository(Tenant).update({ id: tenant.id }, { canceledAt: now });
    this.modules.invalidate(tenantId);
    return {
      tenantId,
      canceledAt: now,
      hardDeleteAfter: new Date(now.getTime() + 90 * 86_400_000),   // D12
    };
  }

  private async mustGetTenant(tenantId: number) {
    const tenant = await this.dataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException(`租户 ${tenantId} 不存在`);
    return tenant;
  }
}
