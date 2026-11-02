// JWT 鉴权守卫（全局）：解析 Bearer Token，写入 req.user，供 TenantGuard 使用
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    // 标记为 @Public() 的路由直接放行
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new UnauthorizedException('未认证');
    try {
      const payload = this.jwt.verify(h.slice(7)); // 验签
      req.user = { sub: payload.sub, tenantId: payload.tenantId, roles: payload.roles ?? [] };
      return true;
    } catch {
      throw new UnauthorizedException('Token 失效');
    }
  }
}
