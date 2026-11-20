import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/** 预警规则创建/更新（字段全可选，create 时 name 必填由服务层兜底校验） */
export class AlertRuleDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsIn(['dead_stock', 'expiring']) type?: 'dead_stock' | 'expiring';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) idleDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) criticalDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) expiryDays?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minQty?: number;
  @IsOptional() @IsString() @Length(0, 120) category?: string;
  @IsOptional() active?: boolean;
}

/** 预警事件列表查询 */
export class QueryAlertsDto {
  @IsOptional() @IsString() keyword?: string;
  @IsOptional() @IsIn(['dead_stock', 'expiring']) type?: 'dead_stock' | 'expiring';
  @IsOptional() @IsIn(['warning', 'critical']) severity?: 'warning' | 'critical';
  @IsOptional() @IsIn(['open', 'ack', 'ignored']) status?: 'open' | 'ack' | 'ignored';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/** 处理预警：ack=确认处理，ignored=忽略 */
export class AckAlertDto {
  @IsIn(['ack', 'ignored']) status!: 'ack' | 'ignored';
  @IsOptional() @IsString() @Length(0, 300) note?: string;
}
