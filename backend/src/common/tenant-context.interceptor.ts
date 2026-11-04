import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tenantStorage, TenantCtx } from './tenant.context';
import { ModulesService } from '../saas/modules.service';
import { PermissionsService } from '../saas/permissions.service';

/**
 * 扩展版：在 AsyncLocalStorage 中除 tenantId/userId/roles 外，
 * 还注入 modules（tenant_modules active 列表）+ permissions（role_permissions 展开）
 * 供 ModuleGuard / PermissionGuard / useModules() / usePermissions() 使用。
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private modulesSvc: ModulesService,
    private permsSvc: PermissionsService,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const req = ctx.switchToHttp().getRequest();
    const u = req.user ?? {};
    const tenantId: number = u.tenantId ?? 0;
    const userId: number = u.sub ?? 0;
    const roles: string[] = u.roles ?? [];

    // 只有登录用户才查 SaaS 数据；public 路由（login 等）留空
    const [modules, permissions] = tenantId > 0
      ? await Promise.all([
          this.modulesSvc.listTenantActive(tenantId).catch(() => [] as string[]),
          this.permsSvc.listByRoles(roles).catch(() => [] as string[]),
        ])
      : [[], []];

    const store: TenantCtx = { tenantId, userId, roles, modules, permissions };
    return tenantStorage.run(store, () => next.handle());
  }
}
