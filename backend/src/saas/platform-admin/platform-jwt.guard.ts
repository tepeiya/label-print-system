// 平台运营 JWT 守卫（P2，docs/11 §11.6.2）：只认 scope='platform' 的 token
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * 与租户侧 JwtAuthGuard 的关系：运营路由在类上标 @Public()（跳过全局租户守卫链），
 * 再挂本守卫做平台身份校验。这样租户 JWT（无 scope）进不了运营接口，
 * 平台 JWT 也进不了租户接口（租户守卫按 sub/tenantId 查 users 表，平台账号不在里面）。
 */
@Injectable()
export class PlatformJwtGuard implements CanActivate {
  constructor(private jwt: JwtService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const h = req.headers.authorization;
    const raw = h?.startsWith('Bearer ') ? h.slice(7) : req.query?.token;
    if (!raw) throw new UnauthorizedException('缺少平台 token');
    let payload: any;
    try {
      payload = this.jwt.verify(raw);
    } catch {
      throw new UnauthorizedException('平台 token 失效');
    }
    if (payload.scope !== 'platform') {
      throw new ForbiddenException('需要平台运营身份（scope=platform），租户账号不能调用运营接口');
    }
    req.platformUser = { id: payload.sub, username: payload.username, role: payload.role };
    return true;
  }
}
