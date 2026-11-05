import { IsArray, IsBoolean, IsNumber, IsObject, IsOptional, IsString, Length } from 'class-validator';

/**
 * 模板 DTO（docs/10 §10.17）。注意：
 * - 全局 ValidationPipe 用 whitelist:false——不丢字段。因为 web 设计器 / AI 保存
 *   会在 body 里带额外键，历史上是靠「整包透传」工作的，收紧白名单会静默丢数据。
 * - content 是设计器自由 JSON（page/elements），只验「是个对象」，深度校验交给 schemaVersion 迁移层。
 */
export class CreateTemplateDto {
  @IsString()
  @Length(1, 120, { message: 'name 必填且不超过 120 字' })
  name!: string;

  @IsObject({ message: 'content 必须是对象（缺少 content 会直接 500，这是历史根因）' })
  content!: any;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  tags?: string[];

  @IsOptional()
  @IsObject()
  acl?: any;

  @IsOptional()
  @IsNumber()
  createdBy?: number;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsObject()
  content?: any;

  @IsOptional()
  @IsNumber()
  updatedBy?: number;
}

export class CopyTemplateDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;
}

export class FavoriteTemplateDto {
  @IsOptional()
  @IsBoolean()
  value?: boolean;
}

/** 导入包：schemaVersion 0/1 由服务层 migrator 迁移 */
export class ImportTemplateDto {
  @IsString()
  @Length(1, 120, { message: '导入包缺少 name' })
  name!: string;

  @IsObject({ message: '导入包缺少有效 content' })
  content!: any;

  @IsOptional()
  @IsNumber()
  schemaVersion?: number;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  tags?: string[];
}
