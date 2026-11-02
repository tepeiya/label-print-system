import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tenantStorage, TenantCtx } from './tenant.context';

/**
 * 在 AsyncLocalStorage 中包裹请求处理，确保整条调用链（controller→service→repository）
 * 都能通过 useTenantId() 取到租户上下文。比 enterWith 更可靠（不会被异步边界截断）。
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const u = req.user ?? {};
    const store: TenantCtx = {
      tenantId: u.tenantId ?? 0,
      userId: u.sub ?? 0,
      roles: u.roles ?? [],
    };
    return tenantStorage.run(store, () => next.handle());
  }
}
