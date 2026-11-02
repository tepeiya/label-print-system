import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User, RefreshToken } from '../entities/tenant.entity';

export interface JwtPayload { sub: number; tenantId: number; roles: string[]; }

/** 仅存储 refresh token 的哈希（防泄漏，且适配 token_hash varchar(100)） */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(RefreshToken) private refresh: Repository<RefreshToken>,
    private jwt: JwtService,
  ) {}

  /** 登录：租户内用户名+密码校验（密码 bcrypt 加盐哈希） */
  async login(username: string, password: string, tenantCode: string) {
    const user = await this.users.findOne({ where: { username, tenantId: 1 } }); // 演示：默认租户 1
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      throw new UnauthorizedException('用户名或密码错误');
    return this.issue(user);
  }

  /** 签发 Access + Refresh */
  private async issue(user: User) {
    const payload: JwtPayload = { sub: user.id, tenantId: user.tenantId, roles: [] };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: '15m' });
    const refreshToken = await this.jwt.signAsync({ sub: user.id }, { expiresIn: '7d' });
    await this.refresh.save({ tenantId: user.tenantId, userId: user.id, tokenHash: hashToken(refreshToken), expiresAt: new Date(Date.now() + 7 * 864e5) });
    return { accessToken, refreshToken, expiresIn: 900 };
  }

  async refreshToken(token: string) {
    const rec = await this.refresh.findOne({ where: { tokenHash: hashToken(token), revoked: false } });
    if (!rec) throw new UnauthorizedException('刷新令牌无效');
    const user = await this.users.findOne({ where: { id: rec.userId } });
    return this.issue(user!);
  }

  async logout(token: string) {
    await this.refresh.update({ tokenHash: hashToken(token) }, { revoked: true });
    return { ok: true };
  }
}
