import { IsArray, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * 数据源 DTO。P8.4：save-sql 不再只认 postgresql://，驱动由连接串前缀或 driver 字段判定
 * （判定逻辑在 sql-driver.calc.detectDriver，服务层接线）。
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

  /** P8.4：显式驱动（postgres/mysql/mssql）；不传按连接串前缀判定 */
  @IsOptional()
  @IsString()
  driver?: string;

  /** P8.4：自动刷新配置，由 refreshPlan() 夹取后写入 config.refresh */
  @IsOptional()
  @IsObject()
  refresh?: Record<string, any>;
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

  /** P8.4：SQL 级分页偏移（0 基） */
  @IsOptional()
  @IsNumber()
  offset?: number;
}

/** P8.4：按字段查找（CSV/Excel/SQL 结果内存过滤，值为标量） */
export class LookupDto {
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;

  @IsOptional()
  @IsNumber()
  limit?: number;
}

/** P8.4：自动刷新配置（enabled / intervalSec / cron / replaceRows） */
export class RefreshConfigDto {
  @IsOptional()
  @IsObject()
  refresh?: Record<string, any>;
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
