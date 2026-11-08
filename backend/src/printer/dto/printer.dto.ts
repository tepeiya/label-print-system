import { IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, Length } from 'class-validator';

/**
 * 打印机 DTO。创建必填 name；type/connection 的合法性由服务层 normalize / 通道适配器裁决。
 * web 设计器的临时打印机会 spread 整个 draft（多出的键历史上就是靠透传工作的），
 * 全局 pipe 是 whitelist:false，所以 DTO 不需要穷举。
 */
export class CreatePrinterDto {
  @IsString()
  @Length(1, 120, { message: 'name 必填且不超过 120 字' })
  name!: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsObject()
  connection?: Record<string, any>;

  @IsOptional()
  @IsNumber()
  dpi?: number;

  @IsOptional()
  @IsNumber()
  labelWidthMm?: number;

  @IsOptional()
  @IsNumber()
  labelHeightMm?: number;

  @IsOptional()
  @IsNumber()
  orientation?: number;

  @IsOptional()
  @IsNumber()
  offsetXMm?: number;

  @IsOptional()
  @IsNumber()
  offsetYMm?: number;

  @IsOptional()
  @IsNumber()
  density?: number;

  @IsOptional()
  @IsNumber()
  speed?: number;

  @IsOptional()
  @IsNumber()
  defaultTemplateId?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** 更新全字段可选（不继承 Create：class-validator 的装饰器会沿原型链累加，继承会把 name 重新变必填） */
export class UpdatePrinterDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsObject()
  connection?: Record<string, any>;

  @IsOptional()
  @IsNumber()
  dpi?: number;

  @IsOptional()
  @IsNumber()
  labelWidthMm?: number;

  @IsOptional()
  @IsNumber()
  labelHeightMm?: number;

  @IsOptional()
  @IsNumber()
  orientation?: number;

  @IsOptional()
  @IsNumber()
  offsetXMm?: number;

  @IsOptional()
  @IsNumber()
  offsetYMm?: number;

  @IsOptional()
  @IsNumber()
  density?: number;

  @IsOptional()
  @IsNumber()
  speed?: number;

  @IsOptional()
  @IsNumber()
  defaultTemplateId?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class CalibratePrinterDto {
  @IsOptional()
  @IsNumber()
  offsetXMm?: number;

  @IsOptional()
  @IsNumber()
  offsetYMm?: number;

  @IsOptional()
  @IsNumber()
  density?: number;

  @IsOptional()
  @IsNumber()
  speed?: number;
}

export class TestCommandsDto {
  @IsOptional()
  @IsIn(['zpl', 'tspl', 'epl'])
  protocol?: 'zpl' | 'tspl' | 'epl';
}
