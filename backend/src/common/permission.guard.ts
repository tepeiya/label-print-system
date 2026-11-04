// 权限守卫：检查当前用户是否有指定 permission（通配支持 template:*）
// @RequirePermission('print:job:write') 装饰器 + PermissionGuard
//
// ⚠️ 注意：Nest 执行顺序是 Guards → Interceptors → Handler
//   PermissionGuard 同样不能依赖 AsyncLocalStorage（Interceptor 还没跑），
//   必须自己用 req.user.roles 查 DB 拿 permissions。
import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsService } from '../saas/permissions.service';

export const PERMISSION_KEY = 'permissions';

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

    // 自己查 DB （不能依赖 AsyncLocalStorage）
    const userPerms = await this.permsSvc.listByRoles(roles);

    // admin 全通
    if (userPerms.includes('admin:*') || userPerms.includes('*')) return true;

    const hit = codes.some((wanted) => this.match(userPerms, wanted));
    if (!hit) {
      const wanted = Array.from(new Set(codes)).join(' / ');
      throw new ForbiddenException(`缺少权限: ${wanted}`);
    }
    return true;
  }

  /** 精确 + 通配（template:* 匹配 template:read；* 全通） */
  private match(permissions: string[], wanted: string): boolean {
    if (permissions.includes(wanted)) return true;
    const parts = wanted.split(':');
    while (parts.length > 0) {
      parts[parts.length - 1] = '*';
      if (permissions.includes(parts.join(':'))) return true;
      parts.pop();
    }
    return false;
  }
}
