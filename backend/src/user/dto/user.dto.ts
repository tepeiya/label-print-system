import { IsNumber, IsOptional, IsString, Length } from 'class-validator';

/**
 * 用户 DTO。username/password 的长度下限（2 / 6）仍由服务层裁决
 * （报错文案要拼 USERNAME_MIN / PASSWORD_MIN），DTO 只挡「没传」和「类型不对」。
 */
export class CreateUserDto {
  @IsString()
  @Length(1, 60)
  username!: string;

  @IsString()
  @Length(1, 200)
  password!: string;

  @IsOptional()
  @IsString()
  @Length(0, 60)
  displayName?: string;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  email?: string;

  @IsOptional()
  @IsNumber()
  status?: number;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(0, 60)
  displayName?: string;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  email?: string;

  @IsOptional()
  @IsNumber()
  status?: number;
}

export class ResetPasswordDto {
  @IsString()
  @Length(1, 200, { message: 'newPassword 必填' })
  newPassword!: string;
}

export class GrantRoleDto {
  @IsString()
  @Length(1, 40, { message: 'role 必填' })
  role!: string; // 取值合法性（admin/operator/sql/viewer）由服务层 ALL_ROLES 校验
}
