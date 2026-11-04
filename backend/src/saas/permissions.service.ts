// 权限服务：从 role_permissions + permissions 表读取角色权限
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { RolePermission, Permission } from '../entities/saas.entity';

@Injectable()
export class PermissionsService {
  private log = new Logger('PermissionsService');

  constructor(
    @InjectRepository(RolePermission) private rpRepo: Repository<RolePermission>,
    @InjectRepository(Permission) private permRepo: Repository<Permission>,
  ) {}

  /** 按角色列表返回所有 permission code（去重） */
  async listByRoles(roles: string[]): Promise<string[]> {
    if (!roles?.length) return [];
    const rows = await this.rpRepo.find({
      where: { role: In(roles) },
    });
    const codes = Array.from(new Set(rows.map((r) => r.permissionCode)));
    return codes;
  }

  /** 通配匹配：admin 全通，template:* 匹配 template:read */
  hasPermission(permissions: string[], wanted: string): boolean {
    if (!wanted) return true;
    if (!permissions?.length) return false;

    // 超管全通
    if (permissions.includes('*')) return true;

    // 精确匹配
    if (permissions.includes(wanted)) return true;

    // 通配匹配：把 wanted 最后一段换成 * 试
    // 例：wanted=template:read → template:* 或 *:*:*
    const parts = wanted.split(':');
    while (parts.length > 0) {
      parts[parts.length - 1] = '*';
      const pattern = parts.join(':');
      if (permissions.includes(pattern)) return true;
      parts.pop();
    }
    // 全局通配
    if (permissions.includes('*')) return true;

    return false;
  }

  /** 全量权限字典（平台视角） */
  async listAll() {
    return this.permRepo.find({ order: { moduleCode: 'ASC', resource: 'ASC', action: 'ASC' } });
  }
}
