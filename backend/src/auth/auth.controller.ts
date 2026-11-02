import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard } from '@nestjs/passport';
import { Public } from '../common/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private svc: AuthService) {}
  @Public()
  @Post('login') login(@Body() b: { username: string; password: string; tenantCode?: string }) {
    return this.svc.login(b.username, b.password, b.tenantCode ?? 'default');
  }
  @Public()
  @Post('refresh') refresh(@Body() b: { refreshToken: string }) { return this.svc.refreshToken(b.refreshToken); }
  @UseGuards(AuthGuard('jwt')) @Post('logout') logout(@Body() b: { refreshToken: string }) { return this.svc.logout(b.refreshToken); }
}
