// =============================================================================
// maxicode.controller.ts —— UPS MaxiCode 原生 ^BD 构造端点（第三层 · 码制专业性）
// 显式 opt-in 工具：默认打印通道仍走位图 + warning；本端点供专业用户显式生成 ^BD。
// =============================================================================
import { Body, Controller, Post, BadRequestException } from '@nestjs/common';
import { IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { buildMaxicodeZpl, type StructuredMaxicode } from '../../core/maxicode';

export class MaxicodeDto {
  /** 自由数据文本（Mode 4/5/6）或结构化对象（Mode 2/3） */
  @IsOptional()
  text?: string;

  /** 结构化 UPS 载体消息（与 text 二选一） */
  @IsOptional() @IsObject()
  structured?: StructuredMaxicode;

  @IsOptional() @IsInt() @Min(2) @Max(6)
  mode?: 2 | 3 | 4 | 5 | 6;

  @IsOptional() @IsInt() @Min(1) @Max(8)
  n?: number;

  @IsOptional() @IsInt() @Min(1) @Max(8)
  t?: number;
}

@Controller('print/maxicode')
export class MaxicodeController {
  /** 构造 MaxiCode 原生 ZPL ^BD 指令片段（位置 ^FO 由调用方拼接） */
  @Post('zpl')
  zpl(@Body() b: MaxicodeDto) {
    const input = b.structured ?? b.text;
    if (input === undefined || input === null) {
      throw new BadRequestException('text 或 structured 必须提供其一');
    }
    const r = buildMaxicodeZpl(input as any, { mode: b.mode, n: b.n, t: b.t });
    if (!r.ok) throw new BadRequestException(r.warnings.join('；') || 'MaxiCode 参数非法');
    return {
      format: 'maxicode-zpl',
      mode: r.mode,
      zpl: r.zpl,
      escapedData: r.escapedData,
      warnings: r.warnings,
      boundary: '^BY 对 MaxiCode 无效、无旋转、固定约 1 英寸见方；Mode 2/3 结构化数据格式错误会被 UPS 拒收；真机与承运商受理需验收',
    };
  }
}
