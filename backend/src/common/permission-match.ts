// 权限点通配匹配（纯函数，无 Nest / DB 依赖）
// 之前 PermissionsService 和 PermissionGuard 各写了一份匹配逻辑，这里收敛成唯一实现。
// 权限点命名：module:resource:action，例如 print:job:read / template:write
export const PERMISSION_SEPARATOR = ':';

/**
 * 匹配规则（只认「前缀通配」，不认中间段通配，避免 * 语义含糊）：
 *   '*'          全通
 *   'print:*'    放行 print 模块下所有权限点
 *   'print:job:*' 放行 print:job:read / print:job:submit ...
 *   精确匹配
 * ⚠️ 长度不一致也按前缀比：'template:*' 能放行 'template:read'（两段式权限点）。
 */
export function matchPermission(permissions: string[], wanted: string): boolean {
  if (!wanted) return true;
  if (!permissions?.length) return false;
  if (permissions.includes(wanted)) return true;
  if (permissions.includes('*')) return true;

  const parts = wanted.split(PERMISSION_SEPARATOR);
  for (let i = parts.length - 1; i > 0; i--) {
    const pattern = [...parts.slice(0, i), '*'].join(PERMISSION_SEPARATOR);
    if (permissions.includes(pattern)) return true;
  }
  // 最后兜一层纯模块通配：wanted=a:b:c 时上面的循环已覆盖 a:*:* 与 a:b:*，
  // 但库里更常见的是两段式 'a:*'，所以再补一次裁剪到 1 段 + ':*'
  const moduleOnly = parts[0] + PERMISSION_SEPARATOR + '*';
  return permissions.includes(moduleOnly);
}

/** 任一满足（@RequirePermission 的语义） */
export function matchAnyPermission(permissions: string[], wanted: string[]): boolean {
  return (wanted ?? []).some((w) => matchPermission(permissions, w));
}
