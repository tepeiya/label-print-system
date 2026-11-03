import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from '../common/public.decorator';
import { JwtAuthGuard } from '../common/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private svc: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() b: { username: string; password: string; tenantCode?: string }) {
    return this.svc.login(b.username, b.password, b.tenantCode ?? 'default');
  }

  @Public()
  @Post('refresh')
  refresh(@Body() b: { refreshToken: string }) {
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
  logout(@Body() b: { refreshToken: string }) {
    return this.svc.logout(b.refreshToken);
  }
}
