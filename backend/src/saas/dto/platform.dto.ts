import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Length, Matches, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 平台运营 DTO（P2 前置）。原来 ProvisionTenantDto 只是 interface 没有任何校验，
 * 这里升级为 class（service 里的字段名/默认值语义不变，见 saas/provision.service.ts）。
 */
export class ProvisionTenantDto {
  @IsString()
  @Length(1, 60, { message: '租户名称必填' })
  name!: string;

  @IsString()
  @Length(2, 40, { message: 'code 必填（2-40 位）' })
  code!: string;

  @IsOptional()
  @IsString()
  planCode?: string;

  @IsOptional()
  @IsIn(['trial', 'active'])
  status?: 'trial' | 'active';

  @IsOptional()
  @IsNumber()
  @Min(1)
  trialDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  seats?: number;

  @IsString()
  @Length(1, 60, { message: 'adminUsername 必填' })
  adminUsername!: string;

  @IsString()
  @Length(6, 200, { message: 'adminPassword 至少 6 位' })
  adminPassword!: string;

  @IsOptional()
  @IsString()
  adminDisplayName?: string;

  @IsOptional()
  @IsString()
  adminEmail?: string;

  /**
   * P6.2 D2：独立库租户。当前只做到「路由 + 平台侧按库导出/删除」，
   * 开通编排（建库/迁移/接管业务读写）未实现 → provision 对 dedicated 明确 400。
   */
  @IsOptional()
  @IsIn(['shared', 'dedicated'])
  type?: 'shared' | 'dedicated';

  @IsOptional()
  @IsString()
  @Length(2, 64, { message: 'dataSourceKey 长度 2–64' })
  dataSourceKey?: string;
}

/** 加购单模块（D1：自动补齐前置模块） */
export class AddModuleDto {
  @IsString()
  @Length(1, 40, { message: 'moduleCode 必填' })
  moduleCode!: string;

  @IsOptional()
  @IsIn(['addon', 'manual', 'gift'])
  source?: 'addon' | 'manual' | 'gift';
}

/** 功能开关（/platform/feature-flags） */
export class FeatureFlagDto {
  @IsString()
  @Length(1, 60, { message: 'key 必填' })
  key!: string;

  @IsBoolean({ message: 'enabled 必须是布尔' })
  enabled!: boolean;

  @IsOptional()
  @IsObject()
  rollout?: Record<string, any>;
}

/** 平台运营登录（P2）：platform_users 表，独立于租户身份 */
export class PlatformLoginDto {
  @IsString()
  @Length(1, 60, { message: 'username 必填' })
  username!: string;

  @IsString()
  @Length(1, 200, { message: 'password 必填' })
  password!: string;
}

/** 套餐更新：name/description/sortOrder 可选；moduleCodes 传了就全量替换 plan_modules */
export class UpsertPlanDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  moduleCodes?: string[];

  /** P3：月费（分）。0=免费/未定价；不传保持原价 */
  @IsOptional()
  @IsInt()
  @Min(0, { message: 'priceCents 不能为负' })
  priceCents?: number;
}

/** 运营设置配额（meter 走路径参数；null 表示取消该侧限制） */
export class UpsertQuotaDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  softLimit?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  hardLimit?: number | null;

  @IsOptional()
  @IsIn(['month', 'day'])
  period?: 'month' | 'day';
}

/** 账单项行（快照存 invoices.detail；amountCents 缺省按 qty×unitPriceCents 计） */
export class InvoiceLineDto {
  @IsOptional()
  @IsString()
  @Length(1, 40)
  code?: string;

  @IsString()
  @Length(1, 200, { message: '账单项 title 必填' })
  title!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  qty?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  unitPriceCents?: number;

  @IsOptional()
  @IsInt({ message: 'amountCents 需为整数（分）' })
  @Min(0)
  amountCents?: number;
}

/** 出账（草稿）：items 与 amountCents 都不传 → 按租户当前套餐月费自动生成 */
export class CreateInvoiceDto {
  @IsInt({ message: 'tenantId 必填' })
  @Min(1)
  tenantId!: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'periodStart 需为 YYYY-MM-DD' })
  periodStart?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'periodEnd 需为 YYYY-MM-DD' })
  periodEnd?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  items?: InvoiceLineDto[];

  @IsOptional()
  @IsInt({ message: 'amountCents 需为整数（分）' })
  @Min(0)
  amountCents?: number;

  @IsOptional()
  @IsString()
  @Length(3, 8)
  currency?: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  note?: string;
}

/** 发出账单：dueDays 默认 15 */
export class IssueInvoiceDto {
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'dueDays 至少 1 天' })
  dueDays?: number;
}

/** 收款登记（D5：V1 仅 manual 有真实业务含义，其余通道字段预留） */
export class CreatePaymentDto {
  @IsInt({ message: 'amountCents 必填（分）' })
  @Min(1, { message: '收款金额需为正整数（分）' })
  amountCents!: number;

  @IsOptional()
  @IsIn(['manual', 'wechat', 'alipay', 'stripe', 'bank'])
  provider?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  providerRef?: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  note?: string;
}
