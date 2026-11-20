import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString,
  Length, Max, Min, ValidateNested,
} from 'class-validator';

/** 齐套率查询（与 Agent bom.check_kit_rate 同口径） */
export class CheckKitDto {
  /** 产品编码或名称（业务标识优先，§11.7.4） */
  @IsString() @Length(1, 40) product!: string;
  @Type(() => Number) @IsInt() @Min(1) demand!: number;
  @IsOptional() @IsString() @Length(1, 40) warehouse?: string;
}

/** BOM 明细行输入：物料用编码/名称，服务端解析为内部 id */
export class BomItemInputDto {
  @IsString() @Length(1, 60) material!: string;
  /** 单件用量 */
  @Type(() => Number) @IsNumber() @Min(0) qtyPer!: number;
  /** 损耗率（0.05 = 5%），缺省 0 */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1) lossRate?: number;
}

/** 保存 BOM：带 id 为更新，否则新建；items 全量替换 */
export class SaveBomDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) id?: number;
  @IsString() @Length(1, 40) product!: string;
  @IsOptional() @IsString() @Length(1, 20) version?: string;
  @IsOptional() @IsIn(['draft', 'active', 'inactive']) status?: 'draft' | 'active' | 'inactive';
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => BomItemInputDto)
  items!: BomItemInputDto[];
}

/** BOM 列表过滤 */
export class QueryBomsDto {
  @IsOptional() @IsString() @Length(1, 40) product?: string;
}
