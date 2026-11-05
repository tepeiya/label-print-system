import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from '../common/public.decorator';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { LoginDto, LogoutDto, RefreshTokenDto } from './dto/auth.dto';
import { BrandingService } from '../saas/branding/branding.service';
import { hostFromHeaders } from '../saas/branding/branding.calc';

@Controller('auth')
export class AuthController {
  constructor(private svc: AuthService, private branding: BrandingService) {}

  /**
   * 登录。白标（D6）：请求的 Host 若是**已校验**的租户域名，则租户由域名决定 ——
   * 省略 tenantCode 时按域名登录；显式给了不一致的 tenantCode 直接拒（防钓鱼：
   * 客户域名下的登录框不许用来登别的租户）。没配域名 → 行为与以前完全一致。
   */
  @Public()
  @Post('login')
  async login(@Body() b: LoginDto, @Req() req: any) {
    const host = hostFromHeaders(req?.headers, process.env.BRANDING_TRUST_FORWARDED_HOST === '1');
    const hostCode = (await this.branding.publicBrandingByHost(host))?.tenantCode ?? null;
    return this.svc.login(b.username, b.password, b.tenantCode, hostCode);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() b: RefreshTokenDto) {
    return this.svc.refreshToken(b.refreshToken);
  }

  /** 当前登录用户详情（含角色） */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: any) {
    return this.svc.me(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@Body() b: LogoutDto) {
    return this.svc.logout(b.refreshToken);
  }
}
