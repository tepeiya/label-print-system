import { IsArray, IsIn, IsNumber, IsObject, IsOptional } from 'class-validator';

/**
 * 打印 DTO。copies 的 1..500 夹取、printerId 存在性等业务规则仍在服务层。
 */
export class CreatePrintJobDto {
  // service 语义：传 templateContent 时 templateId 可省略（??: 0）；不传时按 id 查库。
  // 校验层跟随这个语义，不能强制必填（历史「必填」会挡住直传模板内容的调用方）。
  @IsOptional()
  @IsNumber({}, { message: 'templateId 必须是数字' })
  templateId?: number;

  @IsOptional()
  @IsNumber()
  printerId?: number;

  @IsOptional()
  @IsArray()
  rows?: any[];

  @IsOptional()
  @IsNumber()
  copies?: number;

  @IsOptional()
  @IsObject()
  params?: any;

  /** 直接带模板内容打印（不查库），此时 templateId 可为 0 */
  @IsOptional()
  @IsObject()
  templateContent?: any;

  @IsOptional()
  @IsObject()
  serialMap?: Record<string, string[]>;
}

export class RetryPrintDto {
  @IsOptional()
  @IsArray()
  seqNos?: number[];
}

/** /print/preview 实时预览：前端把当前模板 JSON + 数据行 POST 过来 */
export class PreviewRenderDto {
  @IsObject({ message: '缺少 templateContent' })
  templateContent!: any;

  @IsOptional()
  @IsArray()
  rows?: any[];

  @IsOptional()
  @IsNumber()
  copies?: number;
}

/** /print/commands 指令导出（ZPL / TSPL） */
export class PrintCommandsDto {
  @IsObject({ message: '缺少 templateContent' })
  templateContent!: any;

  @IsOptional()
  @IsArray()
  rows?: any[];

  @IsOptional()
  @IsNumber()
  copies?: number;

  @IsOptional()
  @IsIn(['zpl', 'tspl'])
  protocol?: 'zpl' | 'tspl';

  @IsOptional()
  @IsNumber()
  dpi?: number;

  @IsOptional()
  @IsNumber()
  gapMm?: number;

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
  @IsObject()
  serialMap?: Record<string, string[]>;

  @IsOptional()
  @IsNumber()
  widthMm?: number;

  @IsOptional()
  @IsNumber()
  heightMm?: number;
}
