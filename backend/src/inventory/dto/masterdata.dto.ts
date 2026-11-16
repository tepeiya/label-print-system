import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Min } from 'class-validator';

export class CreateMaterialDto {
  @IsString() @Length(1, 40) code!: string;
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 120) spec?: string;
  @IsOptional() @IsString() @Length(1, 20) unit?: string;
  @IsOptional() @IsString() @Length(0, 60) category?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) safetyStock?: number;
  @IsOptional() @Type(() => Number) @IsInt() templateId?: number;
  @IsOptional() @Type(() => Number) @IsInt() groupId?: number;
  @IsOptional() @IsBoolean() autoPrint?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() printerId?: number;
  @IsOptional() @Type(() => Number) @IsInt() defaultWarehouseId?: number;
  @IsOptional() @Type(() => Number) @IsInt() defaultLocationId?: number;
}

// 不继承 CreateMaterialDto：class-validator 装饰器沿原型链累加会把 code 重新变必填
export class UpdateMaterialDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(0, 120) spec?: string;
  @IsOptional() @IsString() @Length(1, 20) unit?: string;
  @IsOptional() @IsString() @Length(0, 60) category?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) safetyStock?: number;
  @IsOptional() @Type(() => Number) @IsInt() templateId?: number;
  @IsOptional() @Type(() => Number) @IsInt() groupId?: number;
  @IsOptional() @IsBoolean() autoPrint?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() printerId?: number;
  @IsOptional() @Type(() => Number) @IsInt() defaultWarehouseId?: number;
  @IsOptional() @Type(() => Number) @IsInt() defaultLocationId?: number;
}

/** 批量设置产品默认仓库/库位 */
export class SetDefaultLocationDto {
  @IsOptional() @IsArray() @IsInt({ each: true }) materialIds?: number[];
  @IsOptional() @Type(() => Number) @IsInt() groupId?: number;
  @IsOptional() @Type(() => Number) @IsInt() warehouseId?: number;
  @IsOptional() @Type(() => Number) @IsInt() locationId?: number;
}

/** 批量绑定模板：三种范围可组合，至少给一种 */
export class BindTemplateDto {
  @IsOptional() @IsArray() @IsInt({ each: true }) materialIds?: number[];
  @IsOptional() @IsString() @Length(0, 60) category?: string;
  @IsOptional() @Type(() => Number) @IsInt() groupId?: number;
  @IsOptional() @IsBoolean() onlyUnbound?: boolean;
  /** 不传或 null = 解除绑定 */
  @IsOptional() @Type(() => Number) @IsInt() templateId?: number;
}

/** 产品一键打印：不传 batchNos 就打一张产品签；传了则每个批次一张 */
export class PrintMaterialDto {
  @IsOptional() @Type(() => Number) @IsInt() printerId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) copies?: number;
  @IsOptional() @IsString({ each: true }) batchNos?: string[];
}

export class CreateWarehouseDto {
  @IsString() @Length(1, 40) code!: string;
  @IsString() @Length(1, 80) name!: string;
}

export class UpdateWarehouseDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
}

export class CreateLocationDto {
  @Type(() => Number) @IsInt() @Min(1) warehouseId!: number;
  @IsString() @Length(1, 40) code!: string;
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @IsString() @Length(0, 40) zone?: string;
}

export class UpdateLocationDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @Length(0, 40) zone?: string;
}

export class ActiveDto {
  @IsBoolean() active!: boolean;
}

export class CreateGroupDto {
  @IsString() @Length(1, 40) code!: string;
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsIn(['brand', 'supplier', 'custom']) type?: 'brand' | 'supplier' | 'custom';
  @IsOptional() @Type(() => Number) @IsInt() defaultWarehouseId?: number;
  @IsOptional() @Type(() => Number) @IsInt() defaultLocationId?: number;
}

// 不继承 CreateGroupDto：避免 code 被重新变必填
export class UpdateGroupDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsIn(['brand', 'supplier', 'custom']) type?: 'brand' | 'supplier' | 'custom';
  @IsOptional() @Type(() => Number) @IsInt() defaultWarehouseId?: number;
  @IsOptional() @Type(() => Number) @IsInt() defaultLocationId?: number;
}
