// 平台目录守卫（P2）：一条路径两种身份都放行
// - scope=platform 的运营 JWT（apps/platform 用）
// - 租户 admin / tenant_admin 的 JWT（console 订阅页拿目录做套餐对比，P1 行为不能回归）
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const TENANT_ADMIN_ROLES = ['admin', 'tenant_admin'];

@Injectable()
export class PlatformOrAdminGuard implements CanActivate {
  constructor(private jwt: JwtService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const h = req.headers.authorization;
    const raw = h?.startsWith('Bearer ') ? h.slice(7) : req.query?.token;
    if (!raw) throw new UnauthorizedException('未认证');
    let payload: any;
    try {
      payload = this.jwt.verify(raw);
    } catch {
      throw new UnauthorizedException('Token 失效');
    }
    if (payload.scope === 'platform') {
      req.platformUser = { id: payload.sub, username: payload.username, role: payload.role };
      return true;
    }
    const roles: string[] = payload.roles ?? [];
    if (!roles.some((r) => TENANT_ADMIN_ROLES.includes(r))) {
      throw new ForbiddenException('需要平台运营或租户 admin 身份');
    }
    req.user = { sub: payload.sub, tenantId: payload.tenantId, roles };
    return true;
  }
}
