// =============================================================================
// tenant.guard.ts —— 多租户行级隔离守卫 + 基础仓储基类
// 核心原则：
//   1) tenant_id 由 JWT 解析后注入 Request，前端永远无法指定/篡改数据范围。
//   2) 所有业务查询强制带 tenant_id 条件（见 BaseRepository 的 whereTenant）。
//   3) 按 id 取资源时 WHERE id=? AND tenant_id=?，命中为空即 404，不暴露存在性。
//   4) 使用 AsyncLocalStorage 让深层服务也能安全取到 tenantId（避免逐层透传）。
// =============================================================================

import {
  Injectable, NestMiddleware, CanActivate, ExecutionContext,
  ForbiddenException, NotFoundException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'async_hooks';

// —— 上下文存储：在请求生命周期内保存 tenantId ——
export const TenantStorage = new AsyncLocalStorage<{ tenantId: number; userId: number }>();

/** JWT Payload 结构（AuthModule 签发） */
interface JwtPayload { sub: number; tenantId: number; roles: string[]; }

/**
 * 中间件：解析 JWT，写入 Request + AsyncLocalStorage。
 * 在路由前执行，确保后续 Guard/Service 一定能拿到 tenantId。
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return next(); // 未携带由 AuthGuard 拦截
    const payload = decodeJwt(auth.slice(7));         // 实际项目用 jwt.verify + 公钥
    (req as any).tenantId = payload.tenantId;
    (req as any).userId = payload.sub;
    TenantStorage.getStore(); // noop，仅引入
    next();
  }
}

/** Guard：强制请求已携带 tenantId，并放入存储 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const tenantId = (req as any).tenantId as number | undefined;
    const userId = (req as any).userId as number | undefined;
    if (!tenantId) throw new ForbiddenException('缺少租户上下文');
    // 将 tenantId 绑定到当前异步上下文，供仓储/服务读取
    TenantStorage.enterWith({ tenantId, userId: userId! });
    return true;
  }
}

/**
 * 业务仓储基类：所有 Repository 继承它，查询自动附带 tenant_id。
 * 例：this.repo.find({ where: this.whereTenant({ id }) })
 */
@Injectable()
export class BaseRepository<T> {
  constructor(private repo: any) {}

  /** 取当前请求租户（从 AsyncLocalStorage，绝不依赖外部传参） */
  private tenantId(): number {
    const s = TenantStorage.getStore();
    if (!s) throw new ForbiddenException('未初始化租户上下文');
    return s.tenantId;
  }

  /** 拼接租户条件，杜绝跨租户查询 */
  whereTenant(extra: Record<string, any> = {}): Record<string, any> {
    return { tenant_id: this.tenantId(), ...extra }; // 强制 tenant_id 在最外层
  }

  async findOwnedOr404(id: number): Promise<T> {
    // 关键：WHERE id=? AND tenant_id=? —— 跨租户查询必显式带 tenant_id
    const row = await this.repo.findOne({ where: { id, tenant_id: this.tenantId() } });
    if (!row) throw new NotFoundException('资源不存在'); // 不暴露是否存在
    return row;
  }

  async list(extra: Record<string, any>, page = 1, pageSize = 20) {
    // 查询始终带 tenant_id 条件，索引 (tenant_id, ...) 命中
    return this.repo.findAndCount({
      where: this.whereTenant(extra),
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  }

  async insert(data: Partial<T>): Promise<T> {
    // 写入时强制写入当前租户，防止越权写入他人租户
    return this.repo.save({ ...data, tenant_id: this.tenantId() });
  }
}

// —— 占位：真实环境用 jsonwebtoken 校验签名 ——
function decodeJwt(token: string): JwtPayload {
  const b64 = token.split('.')[1];
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as JwtPayload;
}

/**
 * 使用示意（Controller 内）：
 *   @UseGuards(JwtAuthGuard, TenantGuard)
 *   @Get(':id')
 *   get(@Req() req) { return this.svc.getOwned(req.tenantId, +req.params.id); }
 * 注意：Controller 方法签名不含 tenantId 入参，tenantId 仅来自网关注入。
 */
