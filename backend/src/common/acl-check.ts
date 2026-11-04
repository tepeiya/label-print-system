// =============================================================================
// acl-check.ts —— 资源级 ACL 检查
//
// 模板 ACL 字段定义：
//   acl = {
//     public?: boolean,                 // true 则同租户所有人可读
//     users?: number[],                 // 显式授权的用户 ID
//     roles?: string[],                 // 显式授权的角色名（admin/operator/viewer/sql）
//     writeUsers?: number[],            // 写权限（覆盖读）
//     writeRoles?: string[],
//   }
//
// 判定顺序（先命中先返回）：
//   1. 全局 admin → 永远有权
//   2. createdBy === userId → 永远有权（模板作者）
//   3. writeUsers / writeRoles → 写权限命中
//   4. users / roles → 读权限命中
//   5. public === true → 同租户所有人可读
//   6. 都没命中 → 拒绝
//
// 注：tenant 隔离由 TenantGuard 保证（查询前已过滤 tenantId），
//    ACL 只负责租户内部的细粒度控制。
// =============================================================================

import { ForbiddenException } from '@nestjs/common';
import { useTenant } from './tenant.context';

export interface AclPayload {
  public?: boolean;
  users?: number[];
  roles?: string[];
  writeUsers?: number[];
  writeRoles?: string[];
}

export interface TemplateLike {
  id: number;
  tenantId: number;
  createdBy?: number | null;
  acl?: AclPayload | null;
}

/** 检查当前用户对模板的访问权限。write=true 表示写权限 */
export function assertAclAccess(tpl: TemplateLike, write = false): void {
  const ctx = useTenant();
  const userId = ctx.userId;
  const userRoles = ctx.roles ?? [];
  const acl = tpl.acl ?? {};

  // 全局 admin 永远有权
  if (userRoles.includes('admin')) return;

  // 模板作者永远有权
  if (tpl.createdBy && userId && +tpl.createdBy === +userId) return;

  // 写权限检查
  if (write) {
    const writeUsers = acl.writeUsers ?? acl.users ?? [];
    const writeRoles = acl.writeRoles ?? acl.roles ?? [];
    if (writeUsers.includes(userId)) return;
    if (writeRoles.some((r) => userRoles.includes(r))) return;
    throw new ForbiddenException(
      `模板 #${tpl.id} 是私有资源，你没有编辑权限。请联系作者或管理员`,
    );
  }

  // 读权限检查
  const users = acl.users ?? [];
  const roles = acl.roles ?? [];
  if (users.includes(userId)) return;
  if (roles.some((r) => userRoles.includes(r))) return;
  if (acl.public) return;
  throw new ForbiddenException(
    `模板 #${tpl.id} 是私有资源，你没有查看权限。请联系作者或管理员`,
  );
}
