import { IsArray, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * 数据源 DTO。save-sql 的连接串前缀（postgresql://）校验仍在服务层（有专门文案）。
 * upload-excel 是 multipart，字段到后端都是字符串，所以 fieldMap 用 @IsString。
 */
export class UploadCsvDto {
  @IsString()
  name!: string;

  @IsString({ message: 'csvText 必须是 CSV 文本' })
  csvText!: string;

  @IsOptional()
  @IsObject()
  fieldMap?: Record<string, string>;
}

export class UploadExcelMetaDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  fieldMap?: string;
}

export class SaveSqlDto {
  @IsString({ message: 'name 必填' })
  name!: string;

  @IsString({ message: 'connectionUrl 必填' })
  connectionUrl!: string;

  @IsOptional()
  @IsString()
  queryTemplate?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class SaveRowsDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsArray({ message: 'rows 必须是数组' })
  rows!: any[];

  @IsOptional()
  @IsArray()
  headers?: string[];

  @IsOptional()
  @IsObject()
  fieldMap?: Record<string, string>;

  @IsOptional()
  @IsObject()
  config?: any;
}

export class SqlExecDto {
  @IsOptional()
  @IsArray()
  params?: any[];

  @IsOptional()
  @IsNumber()
  limit?: number;
}

export class DsPreviewDto {
  @IsNumber({}, { message: 'sourceId 必须是数字' })
  sourceId!: number;

  @IsNumber({}, { message: 'templateId 必须是数字' })
  templateId!: number;

  @IsOptional()
  @IsNumber()
  limit?: number;
}
