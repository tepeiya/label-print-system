// RBAC：角色装饰器 + 守卫（检查 JwtAuthGuard 注入的 req.user.roles）
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export type RoleName = 'admin' | 'operator' | 'sql' | 'viewer';

export const ROLES_KEY = 'roles';

/**
 * 声明路由 / 控制器所需角色。
 * 支持多角色数组；命中其一即可。
 * 不写 @Roles() 时：RolesGuard 直接放行（对所有未标记的路由无侵入）。
 * admin 角色对所有声明直接放行。
 */
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);

export const RoleLabels: Record<RoleName, string> = {
  admin: '系统管理员',
  operator: '操作员',
  sql: 'SQL 数据源访问',
  viewer: '只读查看者',
};

/**
 * 全局角色守卫：先读 Reflector 拿到 @Roles 元数据。
 * - 无元数据 → 放行
 * - 有元数据 → 检查 req.user.roles 是否交集非空
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<RoleName[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles?.length) return true;

    const req = ctx.switchToHttp().getRequest();
    const userRoles: string[] = req.user?.roles ?? [];

    // 超级管理员 admin 对所有 @Roles 检查直接放行
    if (userRoles.includes('admin')) return true;

    const hit = roles.some((r) => userRoles.includes(r));
    if (!hit) {
      const wanted = Array.from(new Set(roles)).join(' / ');
      throw new ForbiddenException(`需要角色: ${wanted}`);
    }
    return true;
  }
}
