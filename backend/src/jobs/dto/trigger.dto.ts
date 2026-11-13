// P8.1 触发器 HTTP 入参校验（全局 ValidationPipe 是 whitelist:false，靠 DTO 显式声明字段）
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { MAX_CONDITION_LEN, TRIGGER_ACTIONS, TRIGGER_SOURCES } from '../trigger.calc';

export class TriggerUpsertDto {
  @IsString() @Length(1, 80)
  name: string;

  @IsIn(TRIGGER_SOURCES as unknown as any[])
  source: string;

  @IsIn(TRIGGER_ACTIONS as unknown as any[])
  action: string;

  @IsOptional() @IsString() @MaxLength(MAX_CONDITION_LEN)
  conditionExpr?: string | null;

  @IsOptional() @IsObject()
  config?: Record<string, any>;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

export class TriggerTestDto {
  @IsOptional() @IsObject()
  payload?: Record<string, any>;
}
