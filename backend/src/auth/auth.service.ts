import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User, RefreshToken, UserRole, Tenant } from '../entities/tenant.entity';
import { Role } from '../entities/saas.entity';
import { ModulesService } from '../saas/modules.service';
import { PermissionsService } from '../saas/permissions.service';
import { TenantConfigService } from '../saas/tenant-config.service';
import { buildMenus } from '../saas/menu.catalog';

export interface JwtPayload { sub: number; tenantId: number; roles: string[]; }

/** 仅存储 refresh token 的哈希（防泄漏，且适配 token_hash varchar(100)） */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(RefreshToken) private refresh: Repository<RefreshToken>,
    @InjectRepository(UserRole) private userRoles: Repository<UserRole>,
    @InjectRepository(Tenant) private tenants: Repository<Tenant>,
    @InjectRepository(Role) private roles: Repository<Role>,
    private jwt: JwtService,
    private modulesSvc: ModulesService,
    private permsSvc: PermissionsService,
    private configSvc: TenantConfigService,
  ) {}

  /**
   * 登录：按 tenantCode 查租户 → 租户内用户名+密码校验（密码 bcrypt 加盐哈希）。
   *
   * hostTenantCode（白标 D6，来自**已校验**自定义域名的解析结果）优先级高于请求体：
   *   · 省略 tenantCode → 用域名的租户；
   *   · 显式给了同一个 code → 照常；
   *   · 显式给了别的 code → 401（登录入口归属另一个租户，不做「域名好看、登录别家」）。
   * hostTenantCode 为 null 时行为与历史完全一致（含 tenantCode 缺省走 default）。
   */
  async login(username: string, password: string, tenantCode?: string | null, hostTenantCode?: string | null) {
    const code = tenantCode ?? hostTenantCode ?? 'default';
    if (hostTenantCode && tenantCode && tenantCode !== hostTenantCode) {
      throw new UnauthorizedException('该登录入口不属于此租户，请从对应域名登录');
    }
    const tenant = await this.tenants.findOne({ where: { code } });
    if (!tenant) throw new UnauthorizedException(`租户 "${code}" 不存在`);
    if (tenant.status !== 1) throw new UnauthorizedException('该租户已停用');
    const user = await this.users.findOne({ where: { username, tenantId: tenant.id } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      throw new UnauthorizedException('用户名或密码错误');
    const roles = await this.loadRoles(user.id, user.tenantId);
    return this.issue(user, roles);
  }

  /**
   * 按 userId+tenantId 读取有效角色列表（去重）。
   * §11.12.3 兼容期双码返回：既给 user_roles.role 的旧字符串（admin/operator/sql/viewer，
   * 现有前端 RBAC 和 DDL CHECK 认它），也给 user_roles.role_id 对应的 roles.code（tenant_admin/manager/...），
   * RolesGuard 与 PermissionsService 都已支持两套码。下个版本删旧码时只留后者。
   */
  async loadRoles(userId: number, tenantId: number): Promise<string[]> {
    const rows = await this.userRoles.find({ where: { userId, tenantId } });
    const legacy = rows.map((r) => r.role).filter(Boolean);
    const roleIds = rows.map((r) => r.roleId).filter((v): v is number => !!v);

    const codes: string[] = roleIds.length
      ? (await this.roles.find({ where: { id: In(roleIds) } })).map((r) => r.code)
      : [];

    return Array.from(new Set([...legacy, ...codes]));
  }

  /** 签发 Access + Refresh */
  private async issue(user: User, roles?: string[]) {
    const finalRoles = roles ?? await this.loadRoles(user.id, user.tenantId);
    const payload: JwtPayload = { sub: user.id, tenantId: user.tenantId, roles: finalRoles };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: '15m' });
    // jti 必须有：同一用户同一秒内重复登录时 {sub} + iat 完全相同 → JWT 相同 →
    // refresh_tokens.token_hash 唯一索引冲突（实测 500）。加随机 jti 让每次签发都唯一。
    const refreshToken = await this.jwt.signAsync({ sub: user.id, jti: crypto.randomUUID() }, { expiresIn: '7d' });
    await this.refresh.save({ tenantId: user.tenantId, userId: user.id, tokenHash: hashToken(refreshToken), expiresAt: new Date(Date.now() + 7 * 864e5) });
    return { accessToken, refreshToken, expiresIn: 900 };
  }

  async refreshToken(token: string) {
    const rec = await this.refresh.findOne({ where: { tokenHash: hashToken(token), revoked: false } });
    if (!rec) throw new UnauthorizedException('刷新令牌无效');
    const user = await this.users.findOne({ where: { id: rec.userId } });
    if (!user) throw new UnauthorizedException('用户不存在');
    const roles = await this.loadRoles(user.id, user.tenantId);
    return this.issue(user, roles);
  }

  async logout(token: string) {
    await this.refresh.update({ tokenHash: hashToken(token) }, { revoked: true });
    return { ok: true };
  }

  /**
   * 获取当前登录用户详情 —— SaaS P0 完整形态（docs/11 §11.4.6）：
   * 基本字段 + roles（新旧双码）+ modules（L2 订阅）+ permissions（L1 权限点）
   * + menus（后端算好的动态菜单，前端不再硬编码）+ features（D7 灰度）
   * + dataScopes（L3 数据范围）+ tenant（类型/套餐/试用到期）。
   * 供前端渲染菜单、路由、按钮，以及订阅页展示。
   */
  async me(userId: number) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('用户不存在');
    const roles = await this.loadRoles(user.id, user.tenantId);

    const [modules, permissions, tenant, plan, features, dataScopes] = await Promise.all([
      this.modulesSvc.listTenantActive(user.tenantId).catch(() => [] as string[]),
      this.permsSvc.listByRoles(roles).catch(() => [] as string[]),
      this.tenants.findOne({ where: { id: user.tenantId } }),
      this.modulesSvc.getPlan(user.tenantId).catch(() => null),
      this.configSvc.featuresFor(user.tenantId).catch(() => ({}) as Record<string, boolean>),
      this.configSvc.dataScopeFor(user.tenantId, user.id, roles).catch(() => null),
    ]);

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      tenantId: user.tenantId,
      tenantCode: tenant?.code ?? '',   // SaaS P0 补充
      email: user.email,
      status: user.status,
      roles,
      modules,          // L2：租户订阅的模块
      permissions,      // L1：角色权限点
      menus: buildMenus(modules, permissions),   // P1 动态菜单入口
      features,         // D7：功能开关
      dataScopes,       // L3：数据范围
      tenant: tenant ? {
        id: tenant.id,
        code: tenant.code,
        name: tenant.name,
        type: tenant.type ?? 'shared',
        status: tenant.status,
        plan: plan?.code ?? null,
        planName: plan?.name ?? null,
        seatLimit: tenant.seatLimit ?? null,
        trialEndsAt: tenant.trialEndsAt ?? null,
      } : null,
    };
  }
}
