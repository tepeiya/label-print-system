// 鉴权模块：登录/刷新/登出（JWT + Refresh Token，bcrypt 加盐）
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { User, RefreshToken, Tenant, UserRole } from '../entities/tenant.entity';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JWT_SECRET } from '../common/config';
import { SaasModule } from '../saas/saas.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, RefreshToken, Tenant, UserRole]),
    JwtModule.register({ secret: JWT_SECRET }),
    SaasModule,
  ],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
