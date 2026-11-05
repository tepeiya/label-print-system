// ============================================================================
// 平台运营后台的接口类型
//
// 字段名以后端实际返回为准，对应关系：
//   PlatformTenant        ← provision.service.ts#listTenants
//   ModuleCatalogItem     ← modules.service.ts#listAll（GET /platform/modules）
//   PlanInfo              ← modules.service.ts#listPlans（GET /platform/plans）
//   UsageOverview         ← platform-admin.service.ts#usage
//   PlatformAuditLog      ← platform-audit.service.ts#list
// ============================================================================

/** 平台运营账号（platform_users）。role: super / operator，前端只展示不做权限判定 */
export interface PlatformUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
}

/** POST /platform/auth/login —— 平台身份只有 2h access token，没有 refresh（过期即回登录页） */
export interface PlatformLoginResult {
  accessToken: string;
  user: PlatformUser;
}

/** 订阅状态。后端只回 active / trial / canceled，过期由 trialEndsAt / canceledAt 体现 */
export type SubscriptionStatus = 'active' | 'trial' | 'canceled';

/** 模块来源：套餐自带 / 单独加购 / 人工赠送 / 试用 / 手工开 */
export type ModuleSource = 'addon' | 'manual' | 'gift';

/** 租户列表行（GET /platform/tenants） */
export interface PlatformTenant {
  id: number;
  code: string;
  name: string;
  /** shared（同库 RLS）/ dedicated（P6 才做物理隔离） */
  type: string;
  /** tenants.status === 1，停用后该租户用户登录被拒 */
  enabled: boolean;
  /** 生效中的订阅所属套餐；无有效订阅为 null */
  plan: { code: string; name: string } | null;
  subscriptionStatus: SubscriptionStatus | null;
  seatLimit: number;
  /** status=1 的用户数 */
  userCount: number;
  /** status in (active, trial) 的模块数 */
  moduleCount: number;
  trialEndsAt: string | null;
  /** 退订时间，非空即进入 D12 的 90 天保留期 */
  canceledAt: string | null;
}

/** 模块基础信息（依赖展开用得到 code 集合，这里保持与后端一致的排序） */
export interface ModuleInfo {
  code: string;
  name: string;
  icon: string | null;
  description: string | null;
  isCore: boolean;
  dependsOn: string[];
  sortOrder: number;
}

/** GET /platform/modules —— 全量模块目录（多一个 trialDays） */
export interface ModuleCatalogItem extends ModuleInfo {
  trialDays: number;
}

/**
 * GET /platform/tenants/:id/modules 的行形状（同 ModulesService#listTenantModules）。
 * 注：该接口与 GET /platform/tenants/:id/subscription 当前后端尚未提供（实测 404），
 * 抽屉拿不到时会降级成「按套餐推导」的模块清单，见 views/Tenants.vue。
 */
export interface TenantModuleRow extends ModuleInfo {
  source?: string;
  status?: string;
}

/**
 * GET /platform/tenants/:id/subscription 的形状（同 SubscriptionService#format）。
 * 与上面的模块详情一样，后端当前尚未提供该 GET，抽屉按 404 降级。
 */
export interface TenantSubscriptionDetail {
  subscription: {
    id: number;
    status: SubscriptionStatus;
    startedAt: string;
    endsAt: string | null;
  };
  plan: { id: number; code: string; name: string; description: string | null } | null;
  modules: string[];
}

/** GET /platform/plans —— modules 是套餐原始配置，effectiveModules 已按依赖补齐 */
export interface PlanInfo {
  id: number;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
  modules: string[];
  effectiveModules: string[];
  /** 只有 PUT /platform/plans/:code 的回包带这个字段（GET 列表用 modules）；未改模块时为 null */
  moduleCodes?: string[] | null;
}

/** PUT /platform/plans/:code 的请求体；moduleCodes 传了就全量替换 plan_modules */
export interface PlanUpdatePayload {
  name?: string;
  description?: string;
  sortOrder?: number;
  moduleCodes?: string[];
}

/** PUT /platform/plans/:code 的返回体（回 plan 行 + 本次写入的 moduleCodes，未改模块时为 null） */
export interface PlanUpdateResult extends PlanInfo {
  moduleCodes: string[] | null;
}

/** POST /platform/tenants —— 必填 name/code/adminUsername/adminPassword */
export interface ProvisionTenantPayload {
  name: string;
  code: string;
  planCode?: string;
  status?: 'trial' | 'active';
  trialDays?: number;
  seats?: number;
  adminUsername: string;
  adminPassword: string;
  adminDisplayName?: string;
  adminEmail?: string;
}

/** 开通结果：单事务里建租户 + 管理员 + 订阅 + 展开模块 */
export interface ProvisionTenantResult {
  tenantId: number;
  code: string;
  name: string;
  plan: string;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
  /** 依赖补齐后实际写入的模块 */
  modules: string[];
  adminUserId: number;
  adminUsername: string;
}

/** POST /platform/tenants/:id/suspend | resume */
export interface SetEnabledResult {
  tenantId: number;
  enabled: boolean;
}

/** POST /platform/tenants/:id/modules —— added 里可能含被自动补齐的前置模块 */
export interface AddModuleResult {
  tenantId: number;
  added: string[];
  requested: string;
}

/** DELETE /platform/tenants/:id/modules/:code */
export interface DisableModuleResult {
  tenantId: number;
  moduleCode: string;
  status: 'disabled';
}

/** POST /platform/tenants/:id/cancel —— hardDeleteAfter 是 D12 的 90 天硬删时间 */
export interface CancelTenantResult {
  tenantId: number;
  canceledAt: string;
  hardDeleteAfter: string;
}

/** GET /platform/usage 的 totals（后端一条聚合 SQL，字段名保持 snake_case） */
export interface UsageTotals {
  tenants_total: number;
  tenants_enabled: number;
  tenants_canceled: number;
  users_active: number;
  templates_total: number;
  jobs_7d: number;
}

/** 到期提醒项（EXPIRE_WARN_DAYS=3 天内到期的 trial 租户） */
export interface ExpiringTenant {
  id: number;
  code: string;
  name: string;
  trialEndsAt: string;
}

export interface UsageOverview {
  totals: UsageTotals;
  /** 套餐 code → 租户数；无有效订阅的租户归到 none */
  byPlan: Record<string, number>;
  expiringSoon: ExpiringTenant[];
}

/** GET /platform/audit —— 最近 200 条平台侧动作（与租户 audit_logs 分表） */
export interface PlatformAuditLog {
  id: number;
  actorId: number;
  actorName: string;
  action: string;
  detail: Record<string, unknown>;
  targetType: string | null;
  targetId: number | null;
  createdAt: string;
}
