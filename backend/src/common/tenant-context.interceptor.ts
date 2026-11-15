import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { DataSource } from 'typeorm';
import { tenantStorage, TenantCtx } from './tenant.context';
import { ModulesService } from '../saas/modules.service';
import { PermissionsService } from '../saas/permissions.service';
import { TenantConfigService } from '../saas/tenant-config.service';

/**
 * 扩展版：在 AsyncLocalStorage 中除 tenantId/userId/roles/modules/permissions 外，
 * 再注入 plan / features / dataScopes / dataSourceKey（docs/11 §11.14），
 * 供 ModuleGuard / PermissionGuard / useModules() / usePermissions() / useFeatureEnabled() 使用。
 *
 * 注意：这里所有查询都容错降级成空值 —— SaaS 表没建（老库直接升级）时不能把所有请求打挂，
 * 顶多是模块判定为未开通，由运维补跑 scripts/saas_p0_roles.sql。
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private modulesSvc: ModulesService,
    private permsSvc: PermissionsService,
    private configSvc: TenantConfigService,
    /** 目录库连接：tenants 表永远在共享库，独立库租户的 data_source_key 从这里读 */
    private ds: DataSource,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const req = ctx.switchToHttp().getRequest();
    const u = req.user ?? {};
    const tenantId: number = u.tenantId ?? 0;
    const userId: number = u.sub ?? 0;
    const roles: string[] = u.roles ?? [];

    // 只有登录用户才查 SaaS 数据；public 路由（login 等）留空
    let store: TenantCtx = { tenantId, userId, roles, modules: [], permissions: [] };

    if (tenantId > 0) {
      const [modules, permissions, plan, features, dataScopes, dsRows] = await Promise.all([
        this.modulesSvc.listTenantActive(tenantId).catch(() => [] as string[]),
        this.permsSvc.listByRoles(roles).catch(() => [] as string[]),
        this.modulesSvc.getPlan(tenantId).catch(() => null),
        this.configSvc.featuresFor(tenantId).catch(() => ({}) as Record<string, boolean>),
        this.configSvc.dataScopeFor(tenantId, userId, roles).catch(() => null),
        // P6.2 阶段 B：从**目录库（共享库）**读真实 data_source_key。
        // 独立库租户的 Repository 代理据此把业务读写路由到 tdsm.get(ctx)；
        // 查不到/老库没这列一律回落 'default'（容错，不把请求打挂）。
        this.ds.query(
          `select data_source_key from public.tenants where id = $1`, [tenantId],
        ).catch(() => [] as any[]),
      ]);
      const dataSourceKey = String(dsRows?.[0]?.data_source_key ?? '').trim() || 'default';
      store = {
        tenantId, userId, roles, modules, permissions,
        plan: plan?.code ?? null,
        features,
        dataScopes,
        dataSourceKey,
      };
    }

    return tenantStorage.run(store, () => next.handle());
  }
}
