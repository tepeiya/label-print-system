// 库存调整单 DTO（class-validator 三层校验：类型/长度/嵌套行）
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min, ValidateNested,
} from 'class-validator';

const TYPES = ['GAIN', 'LOSS', 'DAMAGE', 'RETURN', 'OTHER'];

export class AdjustLineDto {
  @IsString() @Length(1, 40) sku!: string;
  @IsOptional() @IsString() @Length(1, 60) batchNo?: string;
  @IsOptional() @Type(() => Number) @IsInt() locationId?: number;
  /** 带符号：盘盈为正、盘亏为负 */
  @Type(() => Number) @IsNumber() qtyDelta!: number;
  @IsOptional() @IsString() @Length(0, 100) note?: string;
}

export class CreateAdjustDto {
  @IsIn(TYPES) adjustType!: 'GAIN' | 'LOSS' | 'DAMAGE' | 'RETURN' | 'OTHER';
  @IsOptional() @Type(() => Number) @IsInt() warehouseId?: number;
  @IsOptional() @IsString() @Length(1, 40) warehouseCode?: string;
  @IsString() @Length(2, 200) reason!: string;
  @IsOptional() @IsString() @Length(0, 300) remark?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AdjustLineDto)
  lines!: AdjustLineDto[];
}

export class CancelAdjustDto {
  @IsOptional() @IsString() @Length(0, 200) reason?: string;
}

export class ListAdjustDto {
  @IsOptional() @IsIn(['DRAFT', 'PARTIAL', 'POSTED', 'CANCELLED']) status?: string;
  @IsOptional() @IsIn(TYPES) adjustType?: string;
  @IsOptional() @IsString() @Length(0, 60) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
