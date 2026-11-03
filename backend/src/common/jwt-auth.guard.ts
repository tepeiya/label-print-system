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
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    // 优先 Bearer header；缺省时回退到 query.token（供浏览器 EventSource / Webhook 使用）
    let raw: string | undefined;
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) raw = h.slice(7);
    if (!raw && req.query?.token) raw = String(req.query.token);
    if (!raw) throw new UnauthorizedException('未认证');
    try {
      const payload: any = this.jwt.verify(raw);
      req.user = { sub: payload.sub, tenantId: payload.tenantId, roles: payload.roles ?? [] };
      return true;
    } catch {
      throw new UnauthorizedException('Token 失效');
    }
  }
}
