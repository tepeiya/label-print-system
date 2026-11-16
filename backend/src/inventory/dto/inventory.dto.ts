import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/** 库存查询（与 Agent inventory.query_stock 同口径） */
export class QueryStockDto {
  @IsOptional() @IsString() keyword?: string;
  @IsOptional() @IsString() warehouse?: string;
  @IsOptional() @IsIn(['sku', 'batch', 'warehouse']) groupBy?: 'sku' | 'batch' | 'warehouse';
  @IsOptional() @IsString() belowSafety?: string;
  @IsOptional() @Type(() => Number) @IsInt() expiringDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/** 入库 / 出库：delta 正数入库、负数出库 */
export class StockAdjustDto {
  @IsString() @Length(1, 40) sku!: string;
  /** 留空时用产品/分组默认仓库（联动） */
  @IsOptional() @IsString() @Length(1, 40) warehouse?: string;
  @IsOptional() @IsString() @Length(1, 60) batchNo?: string;
  @IsOptional() @Type(() => Number) @IsInt() locationId?: number;
  @Type(() => Number) @IsNumber() delta!: number;
  @IsString() @Length(2, 200) reason!: string;
  @IsOptional() @IsString() dryRun?: string;
}

/** 跨仓调拨 */
export class StockTransferDto {
  @IsString() @Length(1, 40) sku!: string;
  @IsString() @Length(1, 40) fromWarehouse!: string;
  @IsString() @Length(1, 40) toWarehouse!: string;
  @Type(() => Number) @IsNumber() @Min(0.001) qty!: number;
  @IsOptional() @IsString() @Length(1, 60) batchNo?: string;
  @IsOptional() @Type(() => Number) @IsInt() fromLocationId?: number;
  @IsOptional() @Type(() => Number) @IsInt() toLocationId?: number;
  @IsOptional() @IsString() @Length(0, 200) reason?: string;
  @IsOptional() @IsString() dryRun?: string;
}

/** 台账流水查询 */
export class QueryMovesDto {
  @IsOptional() @IsIn(['in', 'out', 'transfer']) kind?: 'in' | 'out' | 'transfer';
  @IsOptional() @IsString() keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() materialId?: number;
  @IsOptional() @Type(() => Number) @IsInt() warehouseId?: number;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
