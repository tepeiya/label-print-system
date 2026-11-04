import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User, RefreshToken, UserRole, Tenant } from '../entities/tenant.entity';
import { ModulesService } from '../saas/modules.service';
import { PermissionsService } from '../saas/permissions.service';

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
    private jwt: JwtService,
    private modulesSvc: ModulesService,
    private permsSvc: PermissionsService,
  ) {}

  /** 登录：按 tenantCode 查租户 → 租户内用户名+密码校验（密码 bcrypt 加盐哈希） */
  async login(username: string, password: string, tenantCode: string) {
    const tenant = await this.tenants.findOne({ where: { code: tenantCode } });
    if (!tenant) throw new UnauthorizedException(`租户 "${tenantCode}" 不存在`);
    if (tenant.status !== 1) throw new UnauthorizedException('该租户已停用');
    const user = await this.users.findOne({ where: { username, tenantId: tenant.id } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      throw new UnauthorizedException('用户名或密码错误');
    const roles = await this.loadRoles(user.id, user.tenantId);
    return this.issue(user, roles);
  }

  /** 按 userId+tenantId 读取有效角色列表（去重） */
  async loadRoles(userId: number, tenantId: number): Promise<string[]> {
    const rows = await this.userRoles.find({ where: { userId, tenantId } });
    return Array.from(new Set(rows.map((r) => r.role)));
  }

  /** 签发 Access + Refresh */
  private async issue(user: User, roles?: string[]) {
    const finalRoles = roles ?? await this.loadRoles(user.id, user.tenantId);
    const payload: JwtPayload = { sub: user.id, tenantId: user.tenantId, roles: finalRoles };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: '15m' });
    const refreshToken = await this.jwt.signAsync({ sub: user.id }, { expiresIn: '7d' });
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
   * 获取当前登录用户详情 —— SaaS P0 扩展：
   * 除基本字段 + roles 外，附加 modules（租户开通模块）+ permissions（角色权限展开）
   * + tenantCode（前端用于展示）
   * 供前端渲染菜单、按钮、hasPermission() 使用。
   */
  async me(userId: number) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('用户不存在');
    const roles = await this.loadRoles(user.id, user.tenantId);

    // SaaS P0 附加：租户模块 + 角色权限
    const [modules, permissions, tenant] = await Promise.all([
      this.modulesSvc.listTenantActive(user.tenantId).catch(() => []),
      this.permsSvc.listByRoles(roles).catch(() => []),
      this.tenants.findOne({ where: { id: user.tenantId } }),
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
      modules,       // SaaS P0
      permissions,    // SaaS P0
    };
  }
}
