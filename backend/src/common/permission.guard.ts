// 权限守卫：检查当前用户是否有指定 permission（通配支持 template:*）
// @RequirePermission('print:job:write') 装饰器 + PermissionGuard；不足返回 403 + code 4032（§11.11.1）
//
// ⚠️ 注意：Nest 执行顺序是 Guards → Interceptors → Handler
//   PermissionGuard 同样不能依赖 AsyncLocalStorage（Interceptor 还没跑），
//   必须自己用 req.user.roles 查 DB 拿 permissions。
import {
  CanActivate, ExecutionContext, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsService } from '../saas/permissions.service';
import { matchAnyPermission } from './permission-match';
import { PermissionDeniedException } from './business.errors';

export const PERMISSION_KEY = 'permissions';

/** 拥有这些角色的用户跳过权限点检查（运维兜底，与 RolesGuard 的 admin 放行一致） */
const SUPER_ROLES = ['admin', 'tenant_admin'];

/** 声明路由/控制器所需权限，多项满足其一即可 */
export const RequirePermission = (...codes: string[]) => SetMetadata(PERMISSION_KEY, codes);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permsSvc: PermissionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const codes = this.reflector.getAllAndOverride<string[]>(PERMISSION_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!codes?.length) return true;   // 无声明 → 放行（对现有路由无侵入）

    const req = ctx.switchToHttp().getRequest();
    const roles: string[] = req.user?.roles ?? [];
    if (!roles.length) return true;    // 无角色 → 交给 RolesGuard 兜底

    // 超管无条件放行（tenant_admin 是 D11 迁移后的新码，行为与旧 admin 一致）
    if (roles.some((r) => SUPER_ROLES.includes(r))) return true;

    // 自己查 DB（不能依赖 AsyncLocalStorage）
    const userPerms = await this.permsSvc.listByRoles(roles);
    if (!matchAnyPermission(userPerms, codes)) {
      throw new PermissionDeniedException(Array.from(new Set(codes)));
    }
    return true;
  }
}
