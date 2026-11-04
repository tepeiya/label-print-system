// 多租户上下文：AsyncLocalStorage 保存租户/用户/订阅/权限（请求级，避免逐层透传）
// SaaS P0 扩展（docs/11 §11.14）：plan / features / dataScopes / dataSourceKey
import { AsyncLocalStorage } from 'async_hooks';
import { DataScope } from './data-scope';

export interface TenantCtx {
  tenantId: number;
  userId: number;
  roles: string[];
  modules: string[];               // tenant_modules 中 active/trial 的 module_code 列表
  permissions: string[];           // role_permissions 展开的 permission code 列表
  plan?: string | null;            // 当前套餐 code（BASIC/PRO/ENTERPRISE），无订阅为 null
  features?: Record<string, boolean>;   // feature_flags（D7）
  dataScopes?: DataScope | null;   // L3 数据范围
  dataSourceKey?: string | null;   // D2：独立库路由钩子，P0 恒为 'default'
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
export function usePlan(): string | null { return useTenant().plan ?? null; }
export function useFeatures(): Record<string, boolean> { return useTenant().features ?? {}; }
/** 功能开关：没配置一律视为关闭（灰度功能默认不可见） */
export function useFeatureEnabled(key: string): boolean { return !!useFeatures()[key]; }
