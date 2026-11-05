import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

/**
 * 入参校验底座（docs/10 §10.17）：以前 45 个 @Body 全是裸类型/any，
 * 手滑少传字段会一路穿透到 SQL 层吃 500。DTO 层负责「形状」，服务层负责「业务」。
 */
export class LoginDto {
  @IsString()
  @Length(1, 60)
  username!: string;

  @IsString()
  @Length(1, 200)
  password!: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  tenantCode?: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty({ message: 'refreshToken 不能为空' })
  @Length(1, 2000)
  refreshToken!: string;
}

export class LogoutDto extends RefreshTokenDto {}
