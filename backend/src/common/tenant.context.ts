// 多租户上下文：AsyncLocalStorage 保存 tenantId/userId/modules/permissions（请求级，避免逐层透传）
import { AsyncLocalStorage } from 'async_hooks';

export interface TenantCtx {
  tenantId: number;
  userId: number;
  roles: string[];
  modules: string[];      // tenant_modules 中 active 的 module_code 列表
  permissions: string[];   // role_permissions JOIN permissions 的 code 列表
}

export const tenantStorage = new AsyncLocalStorage<TenantCtx>();

export function useTenant(): TenantCtx {
  const ctx = tenantStorage.getStore();
  if (!ctx) throw new Error('未初始化租户上下文');
  return ctx;
}
export function useTenantId(): number { return useTenant().tenantId; }
export function useModules(): string[] { return useTenant().modules ?? []; }
export function usePermissions(): string[] { return useTenant().permissions ?? []; }
