// WMS 收货上架 DTO
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsInt, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Length, Max, Min, ValidateNested,
} from 'class-validator';

export class CreateReceiptLineDto {
  @IsString() @Length(1, 40) sku!: string;              // SKU 编码（建单时按编码录入）
  @IsOptional() @IsString() @Length(1, 64) batchNo?: string;
  @Type(() => Number) @IsNumber() @Min(0) qtyExpected!: number;
  @IsOptional() @IsString() @Length(0, 200) remark?: string;
}

export class CreateReceiptDto {
  @IsString() @Length(1, 64) receiptNo!: string;
  @IsIn(['MANUAL', 'EXCEL_IMPORT']) sourceType!: 'MANUAL' | 'EXCEL_IMPORT';
  @IsOptional() @IsString() @Length(1, 64) sourceNo?: string;
  @IsOptional() @Type(() => Number) @IsInt() supplierId?: number;
  @Type(() => Number) @IsInt() @Min(1) warehouseId!: number;
  @IsOptional() @IsString() @Length(0, 500) remark?: string;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CreateReceiptLineDto)
  lines!: CreateReceiptLineDto[];
}

export class AppendLineDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CreateReceiptLineDto)
  lines!: CreateReceiptLineDto[];
}

/** PDA 扫码收货：单次扫码提交；blind=true 时盲收（不指定行） */
export class ReceiveScanDto {
  @IsOptional() @IsString() @Length(1, 40) sku?: string;      // 扫到的 SKU 编码（盲收必填）
  @IsOptional() @IsString() @Length(1, 64) batchNo?: string;
  @Type(() => Number) @IsNumber() @Min(0.001) qty!: number;
  @IsOptional() @Type(() => Number) @IsInt() lineNo?: number;  // 按单收时指定行号；盲收留空
  @IsOptional() lineId?: number;
  @IsOptional() @IsString() @Length(0, 200) remark?: string;
  /** UDI 码（HRI 或元素串）：扫到时自动建档并记 RECEIVE 事件（U5） */
  @IsOptional() @IsString() @Length(1, 300) udiCode?: string;
  /** UDI 联动失败是否阻塞收货（默认 false：记警告不阻塞） */
  @IsOptional() strictUdi?: boolean;
}

export class ConfirmPutawayDto {
  @IsOptional() @Type(() => Number) @IsInt() actualLocationId?: number;  // 操作员改库位
  @IsOptional() @IsString() @Length(0, 200) remark?: string;
}

export class ImportReceiptDto {
  @IsString() @Length(1, 64) receiptNo!: string;
  @IsOptional() @Type(() => Number) @IsInt() supplierId?: number;
  @Type(() => Number) @IsInt() @Min(1) warehouseId!: number;
  /** Excel 行：header 含 sku / batchNo / qtyExpected */
  @IsArray() @ArrayMaxSize(1000) rows!: Array<Record<string, any>>;
}
