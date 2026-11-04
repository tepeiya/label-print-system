// 模块守卫：检查租户是否开通了某模块（subscription → tenant_modules）
// 使用 @RequireModule('print') 装饰器声明所需模块；ModuleGuard 先于 RolesGuard 执行
//
// ⚠️ 注意：Nest 执行顺序是 Guards → Interceptors → Handler
//   TenantContextInterceptor（填 modules/permissions）在 Guards 之后才跑，
//   所以 ModuleGuard 不能依赖 AsyncLocalStorage，必须自己查 DB。
import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModulesService } from '../saas/modules.service';

export const MODULE_KEY = 'modules';

/** 声明路由/控制器所需模块，多模块满足其一即可 */
export const RequireModule = (...codes: string[]) => SetMetadata(MODULE_KEY, codes);

@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private modulesSvc: ModulesService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const codes = this.reflector.getAllAndOverride<string[]>(MODULE_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!codes?.length) return true;   // 无声明 → 放行（对现有路由无侵入）

    const req = ctx.switchToHttp().getRequest();
    const tenantId: number = req.user?.tenantId ?? 0;
    if (!tenantId) return true;       // public 路由，放行

    // 自己查 DB（不能依赖 AsyncLocalStorage，Interceptor 还没跑）
    const enabled = await this.modulesSvc.listTenantActive(tenantId);
    const hit = codes.some((c) => enabled.includes(c));
    if (!hit) {
      const wanted = Array.from(new Set(codes)).join(' / ');
      throw new ForbiddenException(`当前订阅未开通模块: ${wanted}`);
    }
    return true;
  }
}
