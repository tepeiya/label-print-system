// 多租户上下文：AsyncLocalStorage 保存 tenantId/userId（请求级，避免逐层透传）
import { AsyncLocalStorage } from 'async_hooks';

export interface TenantCtx { tenantId: number; userId: number; roles: string[]; }

export const tenantStorage = new AsyncLocalStorage<TenantCtx>();

export function useTenant(): TenantCtx {
  const ctx = tenantStorage.getStore();
  if (!ctx) throw new Error('未初始化租户上下文');
  return ctx;
}
export function useTenantId(): number { return useTenant().tenantId; }
