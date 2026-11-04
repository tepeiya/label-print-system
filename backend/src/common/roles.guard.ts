// RBAC：角色装饰器 + 守卫（检查 JwtAuthGuard 注入的 req.user.roles）
// §11.12.3 兼容期：旧 4 角色字符串与 D11 之后的新角色码并存，@Roles('admin') 对 tenant_admin 同样放行。
// 下个版本移除旧码时，只需删掉 RoleAlias 并把 @Roles 调用改成新码。
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/** 旧角色（DDL CHECK 目前仍只认这四个，user_roles.role 兼容期继续写它们） */
export type LegacyRoleName = 'admin' | 'operator' | 'sql' | 'viewer';
/** D11 内置角色（roles.code） */
export type SystemRoleName =
  | 'tenant_admin' | 'manager' | 'operator' | 'warehouse_keeper' | 'purchaser' | 'viewer';
export type RoleName = LegacyRoleName | SystemRoleName;

export const ROLES_KEY = 'roles';

/**
 * 声明路由 / 控制器所需角色。
 * 支持多角色数组；命中其一即可。
 * 不写 @Roles() 时：RolesGuard 直接放行（对所有未标记的路由无侵入）。
 * admin / tenant_admin 对所有 @Roles 声明直接放行。
 */
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);

/** 旧码 → 新码（D11：sql 废弃并入 manager） */
export const RoleAlias: Record<string, string> = {
  admin: 'tenant_admin',
  sql: 'manager',
};

/** 超级角色：对任何 @Roles 声明无条件放行（便于运维） */
export const SUPER_ROLES = ['admin', 'tenant_admin'];

export const RoleLabels: Record<string, string> = {
  admin: '系统管理员（旧码，等同 tenant_admin）',
  tenant_admin: '租户管理员',
  manager: '主管',
  operator: '操作员',
  sql: 'SQL 数据源访问（D11 已废弃，并入 manager）',
  warehouse_keeper: '仓管',
  purchaser: '采购',
  viewer: '只读查看者',
};

/** 把用户角色展开成「旧码 + 新码」集合，供新旧并行判断 */
export function effectiveRoles(userRoles: string[]): Set<string> {
  const out = new Set<string>();
  for (const r of userRoles ?? []) {
    out.add(r);
    const alias = RoleAlias[r];
    if (alias) out.add(alias);
  }
  // 反向：新码也认可对应旧码，保证 @Roles('admin') 之类旧声明不被迁移打断
  for (const [legacy, next] of Object.entries(RoleAlias)) {
    if (out.has(next)) out.add(legacy);
  }
  return out;
}

/**
 * 全局角色守卫：先读 Reflector 拿到 @Roles 元数据。
 * - 无元数据 → 放行
 * - 有元数据 → 检查 req.user.roles 是否交集非空（按 effectiveRoles 判定）
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
    const effective = effectiveRoles(userRoles);

    if (SUPER_ROLES.some((r) => effective.has(r))) return true;

    const hit = roles.some((r) => effective.has(r));
    if (!hit) {
      const wanted = Array.from(new Set(roles)).join(' / ');
      throw new ForbiddenException(`需要角色: ${wanted}`);
    }
    return true;
  }
}
