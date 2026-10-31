// 多租户守卫 + 基础仓储（所有查询强制带 tenant_id）
import { CanActivate, ExecutionContext, ForbiddenException, NotFoundException, Injectable } from '@nestjs/common';
import { tenantStorage, useTenantId } from './tenant.context';

/** JWT 解析后写入上下文（配合 AuthModule 的 JwtAuthGuard 先执行） */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const payload = req.user; // 由 JwtAuthGuard 注入 { sub, tenantId, roles }
    if (!payload?.tenantId) throw new ForbiddenException('缺少租户上下文');
    tenantStorage.enterWith({ tenantId: payload.tenantId, userId: payload.sub, roles: payload.roles ?? [] });
    return true;
  }
}

/** 通用仓储基类：所有业务 Repository 继承，强制 WHERE ... AND tenant_id=? */
@Injectable()
export class BaseRepository<T> {
  constructor(private repo: any) {}
  whereTenant(extra: Record<string, any> = {}): Record<string, any> {
    return { tenantId: useTenantId(), ...extra };   // 强制 tenant_id 在最外层
  }
  async findOwnedOr404(id: number): Promise<T> {
    // 跨租户查询必显式带 tenant_id；命中为空即 404（不暴露存在性）
    const row = await this.repo.findOne({ where: { id, tenantId: useTenantId() } });
    if (!row) throw new NotFoundException('资源不存在');
    return row;
  }
  async list(extra: Record<string, any>, page = 1, pageSize = 20) {
    return this.repo.findAndCount({
      where: this.whereTenant(extra),
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  }
  async insert(data: Partial<T>): Promise<T> {
    return this.repo.save({ ...data, tenantId: useTenantId() });
  }
}
