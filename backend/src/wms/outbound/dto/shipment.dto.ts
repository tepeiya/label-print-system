// WMS 成品发运 DTO
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Min, ValidateNested,
} from 'class-validator';

export class CreateShipmentLineDto {
  @IsString() @Length(1, 40) sku!: string;
  @Type(() => Number) @IsNumber() @Min(0.001) qtyPlan!: number;
  @IsOptional() @IsString() @Length(1, 60) batchNo?: string;
  @IsOptional() @Type(() => Number) @IsInt() locationId?: number;
  @IsOptional() @IsString() @Length(1, 20) packSscc?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) udiCodes?: string[];
}

export class CreateShipmentDto {
  @IsOptional() @IsIn(['SALES', 'TRANSFER', 'SAMPLE', 'OTHER']) shipType?: 'SALES' | 'TRANSFER' | 'SAMPLE' | 'OTHER';
  @IsOptional() @Type(() => Number) @IsInt() warehouseId?: number;
  @IsOptional() @IsString() @Length(1, 40) warehouseCode?: string;
  @IsOptional() @IsString() @Length(0, 60) customerCode?: string;
  @IsOptional() @IsString() @Length(0, 120) customerName?: string;
  @IsOptional() @IsString() @Length(0, 300) shipTo?: string;
  @IsOptional() @IsString() @Length(0, 80) carrier?: string;
  @IsOptional() @IsString() @Length(0, 120) trackingNo?: string;
  @IsOptional() @IsString() @Length(0, 10) expectedDate?: string;
  @IsOptional() @IsString() @Length(0, 300) remark?: string;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CreateShipmentLineDto)
  lines!: CreateShipmentLineDto[];
}

export class PickLineDto {
  @Type(() => Number) @IsNumber() @Min(0.001) qty!: number;
  @IsOptional() @IsString() @Length(0, 60) batchNo?: string;
  @IsOptional() @Type(() => Number) @IsInt() locationId?: number;
  @IsOptional() @IsString() @Length(0, 20) packSscc?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) udiCodes?: string[];
}

export class SignShipmentDto {
  @IsOptional() @IsString() @Length(0, 80) receiver?: string;
}

export class CancelShipmentDto {
  @IsOptional() @IsString() @Length(0, 200) reason?: string;
}
