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

/**
 * GET /platform/plans —— 命中的是 PlatformController 的目录版（先注册）：
 * 模块字段叫 `modules`（套餐原始配置），`effectiveModules` 已按依赖补齐，
 * 没有 `moduleCodes`（那只是 PUT 回包的字段名）。
 */
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
  /**
   * P3 月费（分）：plans.price_cents 是 BIGINT，pg 驱动可能回字符串，用之前先 Number()。
   * 旧构建的列表可能不带该字段，读侧按「未回」处理（见 views/Plans.vue 的 priceKnown）。
   */
  priceCents?: number | string;
}

/** PUT /platform/plans/:code 的请求体；moduleCodes 传了就全量替换 plan_modules */
export interface PlanUpdatePayload {
  name?: string;
  description?: string;
  sortOrder?: number;
  moduleCodes?: string[];
  /** P3：月费（分）。不传保持原价，0 = 免费/未定价 */
  priceCents?: number;
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

// ============================================================================
// P3 计费：账单 / 收款 / 配额 / 计量（docs/11 §11.7）
//   Invoice / Payment ← billing/invoice.service.ts#toDto / #payToDto
//   Quota / Meter     ← billing/usage.service.ts#listQuotas / #monthSummary / #listMeters
// 金额一律「分」（amountCents），UI 展示时 /100 转「元」保留两位。
// ============================================================================

/** 账单状态机：draft（运营出账）→ issued（发单）→ paid；issued 逾期转 overdue；未付可 void */
export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void' | 'overdue';

/** 收款通道：D5 只做运营手动登记，manual 有真实业务含义，其余为预留 */
export type PaymentProvider = 'manual' | 'wechat' | 'alipay' | 'stripe' | 'bank';

/** 账单行项快照（存 invoices.detail，qty×unitPriceCents 或直接给 amountCents） */
export interface InvoiceLine {
  code?: string;
  title: string;
  qty?: number;
  unitPriceCents?: number;
  amountCents?: number;
}

/** 出账快照：source=plan 时 detail.plan 冻结了当时的套餐与月费 */
export interface InvoiceDetailSnapshot {
  source: 'plan' | 'manual';
  plan?: { id: number; code: string; name: string; priceCents: number } | null;
  items?: InvoiceLine[];
  note?: string;
}

/** GET /platform/invoices 的行（listAll 顺带把已收/余额一起回给运营页） */
export interface Invoice {
  id: number;
  tenantId: number;
  /** 账单号 INV-{tenantId}-{yymm}-{seq} */
  number: string;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  periodStart: string | null;
  periodEnd: string | null;
  dueAt: string | null;
  paidAt: string | null;
  detail: InvoiceDetailSnapshot;
  createdBy: number | null;
  createdAt: string;
  paidCents?: number;
  balanceCents?: number;
}

/** POST /platform/invoices/:id/payments 与 GET /platform/invoices/:id 的回包：账单 + 收款汇总 */
export interface InvoiceDetail extends Invoice {
  paidCents: number;
  balanceCents: number;
  payments: Payment[];
}

/** GET /platform/invoices —— 分页信封（后端 pageSize 上限 200） */
export interface InvoicePage {
  items: Invoice[];
  total: number;
  page: number;
  pageSize: number;
}

/** POST /platform/invoices/:id/payments 的收款记录 */
export interface Payment {
  id: number;
  invoiceId: number;
  tenantId: number;
  provider: PaymentProvider | string;
  providerRef: string | null;
  amountCents: number;
  note: string | null;
  paidBy: number | null;
  paidAt: string;
}

/** POST /platform/invoices —— items 与 amountCents 都不传 = 按租户当前套餐月费自动出账 */
export interface CreateInvoicePayload {
  tenantId: number;
  periodStart?: string;
  periodEnd?: string;
  items?: InvoiceLine[];
  amountCents?: number;
  currency?: string;
  note?: string;
}

/** POST /platform/invoices/:id/payments 的请求体（amountCents 为正整数分） */
export interface CreatePaymentPayload {
  amountCents: number;
  provider?: PaymentProvider;
  providerRef?: string;
  note?: string;
}

/** 配额周期：month（自然月窗口）/ day（当天窗口） */
export type QuotaPeriod = 'month' | 'day';

/** GET /platform/tenants/:id/quotas 的行；null = 该侧不设限 */
export interface TenantQuota {
  meter: string;
  softLimit: number | null;
  hardLimit: number | null;
  period: QuotaPeriod | string;
}

/** PUT /platform/tenants/:id/quotas/:meter：字段传 null 取消该侧限制，两边都 null 等价删除 */
export interface UpsertQuotaPayload {
  softLimit?: number | null;
  hardLimit?: number | null;
  period?: QuotaPeriod;
}

/** DELETE /platform/tenants/:id/quotas/:meter */
export interface RemoveQuotaResult {
  tenantId: number;
  meter: string;
  removed: boolean;
}

/** GET /platform/tenants/:id/meters 的 month 聚合（used 来自 usage_daily，限额来自 quotas） */
export interface MeterMonthSummary {
  meter: string;
  used: number;
  softLimit: number | null;
  hardLimit: number | null;
  period: QuotaPeriod | string;
}

/** 原始计量明细行（对账颗粒度到单次动作） */
export interface MeterUsage {
  id: number;
  tenantId: number;
  meter: string;
  moduleCode: string | null;
  quantity: number;
  userId: number | null;
  meta: Record<string, unknown>;
  occurredAt: string;
}

/** GET /platform/tenants/:id/meters —— 本月聚合 + 原始明细（明细按 page/pageSize 分页） */
export interface TenantMeterDetail {
  month: MeterMonthSummary[];
  meters: MeterUsage[];
}

// ============================================================================
// P6.3 租户数据保留期 / 导出 / 硬删（docs/11 D12 + §11.2 RLS 兜底）
//   TenantRetention*    ← platform-admin/tenant-data.service.ts#retention
//   TenantExportSummary ← #exportTenant
//   TenantExportItem    ← #listBackups（读 tenant_backups）
//   TenantPurgeResult   ← #purgeTenant
// 三道闸门在 tenant-data.calc.ts#assertPurgeAllowed，UI 只做「如实反映 + 前端预校验」，不替代后端。
// ============================================================================

/**
 * GET /platform/tenants/retention 的行。
 * ⚠️ 后端 SQL 是 `where canceled_at is not null`：**只有已退订租户**会出现在这里，
 * 列表为空 ≠ 没有租户，而是没有退订中的租户（全量看 GET /platform/tenants）。
 */
export interface TenantRetentionItem {
  tenantId: number;
  code: string;
  name: string;
  /** 非空即已进入保留期（后端只回已退订的行） */
  canceledAt: string | null;
  /** canceledAt + retentionDays，过了这个时间点 due 才为 true */
  hardDeleteAt: string | null;
  /** 距可硬删还剩几天（向下取整，负数=已过期）；未退订/脏值为 null */
  daysLeft: number | null;
  /** daysLeft <= 0：保留期已满，可硬删 */
  due: boolean;
  /** 0 < daysLeft <= 7：进入删除前提醒窗口 */
  warn: boolean;
  /** 该租户 users 行数（看板用来判断「删掉会影响多少人」） */
  users: number;
  /** 该租户 templates 行数 */
  templates: number;
}

/** GET /platform/tenants/retention —— retentionDays 后端常量 D12=90 */
export interface TenantRetentionBoard {
  retentionDays: number;
  items: TenantRetentionItem[];
}

/** POST /platform/tenants/:id/export 的摘要（数据本体落在 tenant_backups，下载另走接口） */
export interface TenantExportSummary {
  tenantId: number;
  tenantCode: string;
  /** tenant_backups.id，下载用它 */
  backupId: number;
  /** `<code>-export-<yyyy-mm-dd>`，下载文件名 = name + '.json.gz' */
  name: string;
  createdAt: string;
  sizeBytes: number;
  /** 本次导出覆盖的表数（含 tenants 单行快照） */
  tableCount: number;
  rowCount: number;
  /** 超过单表 5 万行上限被截断的表名：非空即「导出件不完整」 */
  truncated: string[];
  /** 后端如实回报：false = 跑在主库连接上（只有应用层隔离），不是 RLS 角色 */
  rlsActive: boolean;
}

/** 导出件种类：平台导出 / 租户自己手工备份 / 定时备份 / 硬删前自动快照 */
export type TenantExportKind = 'export' | 'manual' | 'scheduled' | 'purge-pre';

/**
 * GET /platform/tenants/:id/exports 的行（含租户自己建的备份）。
 * ⚠️ size_bytes / created_by 是 BIGINT，pg 驱动回**字符串**（实测 "985" / "1"），展示前要 Number()。
 */
export interface TenantExportItem {
  id: number;
  name: string;
  kind: TenantExportKind | string;
  sizeBytes: number | string;
  storageKey: string | null;
  createdBy: number | string | null;
  createdAt: string;
}

/** GET /platform/tenants/:id/exports（后端 limit 100，按 id 倒序） */
export interface TenantExportList {
  tenantId: number;
  items: TenantExportItem[];
}

/** POST /platform/tenants/:id/purge 请求体 */
export interface PurgeTenantPayload {
  /** 闸门①：必须逐字等于租户 code（后端 trim 后比对） */
  confirm: string;
  /** 闸门②③：未过保留期或未退订时，必须显式 true */
  force?: boolean;
}

/** 硬删逐表明细（rows=该表本次删掉的行数，0 表示这张表本来没数据） */
export interface TenantPurgeDetailRow {
  table: string;
  rows: number;
}

/**
 * POST /platform/tenants/:id/purge 的成功返回。
 * remaining / cyclic 非空 = 删完复查仍有行 / 外键成环只能按原顺序删 → 可能有孤儿行需人工核查。
 */
export interface TenantPurgeResult {
  tenantId: number;
  tenantCode: string;
  rlsActive: boolean;
  /** 删除前自动落的 purge-pre 快照（唯一的回滚凭据） */
  snapshot: {
    backupId: number;
    name: string;
    sizeBytes: number;
    tableCount: number;
  };
  deletedRows: number;
  /** 处理过的表数（不是「删到行的表数」） */
  tables: number;
  detail: TenantPurgeDetailRow[];
  remaining: string[];
  cyclic: string[];
}
