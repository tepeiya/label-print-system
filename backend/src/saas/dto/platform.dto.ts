import { IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, Length, Min } from 'class-validator';

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
}
