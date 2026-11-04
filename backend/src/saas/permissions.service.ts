// 权限服务：从 role_permissions + permissions 表读取角色权限
// 同一组角色在 60s 内复用缓存；改角色权限后最多等 60s，或用 invalidateRoles() 主动失效
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { RolePermission, Permission } from '../entities/saas.entity';
import { matchPermission } from '../common/permission-match';

const CACHE_TTL_MS = 60_000;

@Injectable()
export class PermissionsService {
  private cache = new Map<string, { codes: string[]; at: number }>();

  constructor(
    @InjectRepository(RolePermission) private rpRepo: Repository<RolePermission>,
    @InjectRepository(Permission) private permRepo: Repository<Permission>,
  ) {}

  /** 按角色列表返回所有 permission code（去重） */
  async listByRoles(roles: string[]): Promise<string[]> {
    if (!roles?.length) return [];
    const key = [...roles].sort().join(',');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.codes;

    const rows = await this.rpRepo.find({ where: { role: In(roles) } });
    const codes = Array.from(new Set(rows.map((r) => r.permissionCode)));
    this.cache.set(key, { codes, at: Date.now() });
    return codes;
  }

  invalidateRoles(roles: string[] = []) {
    if (!roles.length) this.cache.clear();
    else this.cache.delete([...roles].sort().join(','));
  }

  /** 通配匹配（实现见 common/permission-match，这里保留方法名供老调用方使用） */
  hasPermission(permissions: string[], wanted: string): boolean {
    return matchPermission(permissions, wanted);
  }

  /** 全量权限字典（平台视角） */
  async listAll() {
    const rows = await this.permRepo.find({
      order: { moduleCode: 'ASC', resource: 'ASC', action: 'ASC' },
    });
    return rows.map((p) => ({
      code: p.code,
      moduleCode: p.moduleCode,
      resource: p.resource,
      action: p.action,
      name: p.name || p.description || p.code,
      isHighRisk: !!p.isHighRisk,
    }));
  }
}
