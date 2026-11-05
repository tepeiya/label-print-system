// 用户管理模块（admin 专属）：CRUD + 角色分配 + 启停 + 重置密码
import {
  Module, Controller, Get, Post, Put, Patch, Delete, Body, Param, UseGuards,
  BadRequestException, NotFoundException, ConflictException, ForbiddenException,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User, UserRole, RefreshToken } from '../entities/tenant.entity';
import { TenantGuard } from '../common/tenant.guard';
import { Roles, RoleName } from '../common/roles.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenant, useTenantId } from '../common/tenant.context';
import { AuditModule, AuditService } from '../audit/audit.module';

export const ALL_ROLES: RoleName[] = ['admin', 'operator', 'sql', 'viewer'];

import { CreateUserDto, GrantRoleDto, ResetPasswordDto, UpdateUserDto } from './dto/user.dto';
const BCRYPT_ROUNDS = 10;
const PASSWORD_MIN = 6;
const USERNAME_MIN = 2;

@Roles('admin')
@Controller('users')
@UseGuards(TenantGuard)
// 模块门 + 权限钥匙（admin 走 PermissionGuard 超管放行，所以旧行为不变）
@RequireModule('users')
export class UserAdminController {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(UserRole) private userRoles: Repository<UserRole>,
    @InjectRepository(RefreshToken) private refresh: Repository<RefreshToken>,
    private audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // 列表
  // -------------------------------------------------------------------------

  /** 列出当前租户所有用户（含角色） */
  @RequirePermission('sys:user:read')
  @Get()
  async list() {
    const tenantId = useTenantId();
    const users = await this.users.find({ where: { tenantId }, order: { id: 'ASC' } });
    const allRoles = await this.userRoles.find({ where: { tenantId } });
    const rolesByUser = new Map<number, string[]>();
    for (const r of allRoles) {
      const arr = rolesByUser.get(r.userId) ?? [];
      arr.push(r.role);
      rolesByUser.set(r.userId, arr);
    }
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      status: u.status,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      roles: rolesByUser.get(u.id) ?? [],
    }));
  }

  // -------------------------------------------------------------------------
  // 新建用户
  // -------------------------------------------------------------------------

  @RequirePermission('sys:user:manage')
  @Post()
  async create(
    @Body() body: CreateUserDto,
  ) {
    const tenantId = useTenantId();
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');

    if (!username) throw new BadRequestException('用户名不能为空');
    if (username.length < USERNAME_MIN) throw new BadRequestException(`用户名至少 ${USERNAME_MIN} 位`);
    if (!password || password.length < PASSWORD_MIN) throw new BadRequestException(`密码至少 ${PASSWORD_MIN} 位`);

    const exists = await this.users.findOne({ where: { tenantId, username } });
    if (exists) throw new ConflictException(`用户名「${username}」已存在`);

    const user = await this.users.save({
      tenantId,
      username,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      displayName: body.displayName?.trim() || username,
      email: body.email?.trim() || '',
      status: body.status === 0 ? 0 : 1,
    });

    await this.audit.write(tenantId, 'user.create', { id: user.id, username: user.username, status: user.status }, undefined, 'user', user.id);

    // 同时设置初始角色（可选）
    return { id: user.id, username: user.username, status: user.status };
  }

  // -------------------------------------------------------------------------
  // 编辑 / 启停
  // -------------------------------------------------------------------------

  @RequirePermission('sys:user:manage')
  @Patch(':id')
  async update(
    @Param('id') id: number,
    @Body() body: UpdateUserDto,
  ) {
    const tenantId = useTenantId();
    const u = await this.findOneTenant(id, tenantId);

    const patch: any = {};
    if ('displayName' in body) patch.displayName = body.displayName?.trim() || u.username;
    if ('email' in body) patch.email = body.email?.trim() || '';
    if (body.status === 0 || body.status === 1) {
      if (+u.id === +useTenant().userId && body.status === 0) {
        throw new ForbiddenException('不能停用自己的账号');
      }
      patch.status = body.status;
    }
    if (!Object.keys(patch).length) return { ok: true };

    await this.users.update({ id, tenantId }, patch);
    await this.audit.write(tenantId, 'user.update', { id, patch }, undefined, 'user', id);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 重置密码
  // -------------------------------------------------------------------------

  @RequirePermission('sys:user:manage')
  @Post(':id/reset-password')
  async resetPassword(
    @Param('id') id: number,
    @Body() body: ResetPasswordDto,
  ) {
    const tenantId = useTenantId();
    const u = await this.findOneTenant(id, tenantId);
    const password = String(body.newPassword ?? '');
    if (!password || password.length < PASSWORD_MIN) {
      throw new BadRequestException(`新密码至少 ${PASSWORD_MIN} 位`);
    }

    await this.users.update({ id, tenantId }, { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) });
    // 踢掉该用户所有 refresh token（强制重新登录）
    await this.refresh.update({ tenantId, userId: id }, { revoked: true });
    await this.audit.write(tenantId, 'user.reset_password', { id: u.id }, undefined, 'user', u.id);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 删除用户
  // -------------------------------------------------------------------------

  @RequirePermission('sys:user:manage')
  @Delete(':id')
  async remove(@Param('id') id: number) {
    const tenantId = useTenantId();
    const self = useTenant();
    if (+id === +self.userId) throw new ForbiddenException('不能删除自己的账号');
    const u = await this.findOneTenant(id, tenantId);

    // 清理关联数据
    await this.userRoles.delete({ tenantId, userId: id });
    await this.refresh.delete({ tenantId, userId: id });
    await this.users.delete({ id, tenantId });

    await this.audit.write(tenantId, 'user.delete', { id: u.id, username: u.username }, undefined, 'user', u.id);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 角色管理（grant/revoke 保持不变，补充审计）
  // -------------------------------------------------------------------------

  @RequirePermission('sys:user:manage')
  @Post(':id/roles')
  async grantRole(
    @Param('id') id: number,
    @Body() body: GrantRoleDto,
  ): Promise<any> {
    const tenantId = useTenantId();
    if (!ALL_ROLES.includes(body.role as RoleName)) {
      throw new BadRequestException(`非法角色，允许值: ${ALL_ROLES.join(', ')}`);
    }
    const exists = await this.userRoles.findOne({ where: { tenantId, userId: id, role: body.role } });
    if (exists) return { ok: true, already: true };
    const user = await this.findOneTenant(id, tenantId);
    await this.userRoles.save({ tenantId, userId: id, role: body.role as RoleName });
    await this.audit.write(tenantId, 'user.grant_role', { id, role: body.role }, undefined, 'user', id);
    return { ok: true };
  }

  @RequirePermission('sys:user:manage')
  @Delete(':id/roles/:role')
  async revokeRole(
    @Param('id') id: number,
    @Param('role') role: RoleName,
  ) {
    const tenantId = useTenantId();
    if (!ALL_ROLES.includes(role)) throw new BadRequestException('非法角色');

    const self = useTenant();
    if (+id === +self.userId && role === 'admin') {
      const admins = await this.userRoles.find({ where: { tenantId, role: 'admin' } });
      if (admins.length <= 1) {
        throw new BadRequestException('不能撤销最后一个管理员的 admin 角色');
      }
    }

    await this.userRoles.delete({ tenantId, userId: id, role });
    await this.audit.write(tenantId, 'user.revoke_role', { id, role }, undefined, 'user', id);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  private async findOneTenant(id: number, tenantId: number): Promise<User> {
    const u = await this.users.findOne({ where: { id, tenantId } });
    if (!u) throw new NotFoundException('用户不存在');
    return u;
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([User, UserRole, RefreshToken]), AuditModule],
  controllers: [UserAdminController],
})
export class UserAdminModule {}
