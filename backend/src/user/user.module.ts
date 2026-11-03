// 用户管理模块（admin 专属）：列出用户、分配/撤销角色
import { Module, Controller, Get, Post, Delete, Body, Param, UseGuards, BadRequestException } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../entities/tenant.entity';
import { TenantGuard } from '../common/tenant.guard';
import { Roles, RoleName, RoleLabels } from '../common/roles.guard';
import { useTenant, useTenantId } from '../common/tenant.context';

export const ALL_ROLES: RoleName[] = ['admin', 'operator', 'sql', 'viewer'];

@Roles('admin')
@Controller('users')
@UseGuards(TenantGuard)
export class UserAdminController {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(UserRole) private userRoles: Repository<UserRole>,
  ) {}

  /** 列出当前租户所有用户（含角色） */
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
      roles: rolesByUser.get(u.id) ?? [],
    }));
  }

  /** 给用户授予某个角色（幂等） */
  @Post(':id/roles')
  async grantRole(
    @Param('id') id: number,
    @Body() body: { role: RoleName },
  ) {
    const tenantId = useTenantId();
    if (!ALL_ROLES.includes(body.role)) {
      throw new BadRequestException(`非法角色，允许值: ${ALL_ROLES.join(', ')}`);
    }
    const user = await this.users.findOne({ where: { id, tenantId } });
    if (!user) throw new BadRequestException('用户不存在');
    const exists = await this.userRoles.findOne({ where: { tenantId, userId: id, role: body.role } });
    if (exists) return { ok: true, already: true };
    await this.userRoles.save({ tenantId, userId: id, role: body.role });
    return { ok: true };
  }

  /** 撤销用户某个角色（不允许撤销自己唯一的 admin 角色） */
  @Delete(':id/roles/:role')
  async revokeRole(
    @Param('id') id: number,
    @Param('role') role: RoleName,
  ) {
    const tenantId = useTenantId();
    if (!ALL_ROLES.includes(role)) throw new BadRequestException('非法角色');

    // 保护：不能撤销自己唯一的 admin 角色
    const self = useTenant();
    if (+id === +self.userId && role === 'admin') {
      const admins = await this.userRoles.find({ where: { tenantId, role: 'admin' } });
      if (admins.length <= 1) {
        throw new BadRequestException('不能撤销最后一个管理员的 admin 角色');
      }
    }

    await this.userRoles.delete({ tenantId, userId: id, role });
    return { ok: true };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([User, UserRole])],
  controllers: [UserAdminController],
})
export class UserAdminModule {}
