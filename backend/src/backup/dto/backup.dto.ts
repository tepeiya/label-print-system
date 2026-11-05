import { IsOptional, IsString, Length } from 'class-validator';

/** 手动备份：name 可选，缺省时服务层按时间戳生成 */
export class CreateBackupDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;
}
