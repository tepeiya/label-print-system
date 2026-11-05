import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from '../common/public.decorator';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { LoginDto, LogoutDto, RefreshTokenDto } from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private svc: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() b: LoginDto) {
    return this.svc.login(b.username, b.password, b.tenantCode ?? 'default');
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
