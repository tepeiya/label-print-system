import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/** 公共渲染入参：barcode/qrcode/svg 三个端点共用（b.barcode / b.qrcode / 平铺三种形态） */
export class BarcodeRenderDto {
  @IsOptional()
  @IsString()
  sym?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsObject()
  barcode?: any;

  @IsOptional()
  @IsObject()
  qrcode?: any;

  @IsOptional()
  @IsNumber()
  @Min(72)
  @Max(1200)
  dpi?: number;
}

export class BarcodeValidateDto {
  @IsString()
  @IsNotEmpty({ message: 'sym 必填' })
  sym!: string;

  @IsString()
  @IsNotEmpty({ message: 'content 必填' })
  content!: string;
}

/** 公式引擎入参：expr 长度上限是防 DoS（safeEval 本身有超时/步数护栏，见 core/formula-engine） */
export class FormulaEvalDto {
  @IsString()
  @Length(1, 4000, { message: 'expr 必填且不超过 4000 字' })
  expr!: string;

  @IsOptional()
  @IsObject()
  vars?: Record<string, any>;
}

export class FormulaValidateDto {
  @IsString()
  @Length(1, 4000, { message: 'expr 必填且不超过 4000 字' })
  expr!: string;
}

/** AI 纯文本生成模板 */
export class TextToTemplateDto {
  @IsString()
  @Length(1, 2000, { message: 'description 必填且不超过 2000 字' })
  description!: string;

  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(500)
  widthMm?: number;

  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(500)
  heightMm?: number;
}

/** AI 生成结果保存为正式模板 */
export class SaveAiTemplateDto {
  @IsObject({ message: 'template 不合法' })
  template!: any;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  category?: string;
}

/** AI 模型配置：必填三件套 name / modelId / apiEndpoint（服务层也有兜底报错） */
export class CreateAiModelDto {
  @IsString()
  @Length(1, 80, { message: 'name 必填' })
  name!: string;

  @IsString()
  @Length(1, 120, { message: 'modelId 必填' })
  modelId!: string;

  @IsString()
  @Length(1, 400, { message: 'apiEndpoint 必填' })
  apiEndpoint!: string;

  @IsOptional()
  @IsString()
  provider?: string;

  /** 明文传入，服务层 encryptKey 后落库 */
  @IsOptional()
  @IsString()
  @Length(1, 400)
  apiKey?: string;

  @IsOptional()
  @IsObject()
  settings?: any;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** 给字段 → 自动排版（A1）：字段清单 + 纸型 + 风格，后端先出规则版式，再可选让模型美化 */
export class FieldsToTemplateDto {
  @IsArray({ message: 'fields 必须是数组' })
  @ArrayMaxSize(40, { message: '一次最多 40 个字段' })
  fields!: Array<{
    name: string;
    label?: string;
    type?: 'text' | 'number' | 'date' | 'barcode' | 'qrcode';
    sample?: string;
    required?: boolean;
    emphasis?: boolean;
    barcodeSym?: string;
  }>;

  @IsNumber()
  @Min(10)
  @Max(500)
  widthMm!: number;

  @IsNumber()
  @Min(10)
  @Max(500)
  heightMm!: number;

  @IsOptional()
  @IsNumber()
  @Min(72)
  @Max(1200)
  dpi?: number;

  @IsOptional()
  @IsIn(['medical', 'industrial', 'retail', 'clean'])
  style?: 'medical' | 'industrial' | 'retail' | 'clean';

  @IsOptional()
  @IsString()
  @Length(0, 60)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  footer?: string;

  @IsOptional()
  @IsString()
  accent?: string;

  /** 是否让大模型做视觉美化（默认 true；没配模型时自动退回规则版式） */
  @IsOptional()
  useLlm?: boolean;
}
