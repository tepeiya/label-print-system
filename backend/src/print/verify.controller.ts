// =============================================================================
// verify.controller.ts —— 打印后解码验证端点（第三层 · 码制专业性）
// 与 /print/export 同口径：不读业务库、无 DB 副作用，纯内存解码 + 判定。
// =============================================================================
import { Body, Controller, Post, BadRequestException } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { verdictOf, type CandidateDecoded } from './verify.calc';
import { decodeBarcodeImage, renderAndDecode, zxingFormatsFor } from './verify.service';

export class VerifyImageDto {
  /** base64 编码的条码图像（PNG/JPEG，可带 data: 前缀） */
  @IsString()
  imageBase64: string;

  /** 期望的条码文本内容 */
  @IsString()
  expected: string;

  /** 码制（LabelFlow sym，如 CODE128 / QRCODE） */
  @IsString()
  sym: string;

  /** 可选：覆盖解码格式列表 */
  @IsOptional()
  formats?: string[];
}

export class VerifyRoundtripDto {
  @IsString()
  expected: string;

  @IsString()
  sym: string;

  /** 渲染 DPI（48–400，默认 203） */
  @IsOptional() @IsInt() @Min(48) @Max(400)
  dpi?: number;
}

@Controller('print/verify')
export class PrintVerifyController {
  /** 解码上传的条码图像并与期望内容比对 */
  @Post('image')
  async verifyImage(@Body() b: VerifyImageDto) {
    if (!b.imageBase64 || !b.expected || !b.sym) {
      throw new BadRequestException('imageBase64 / expected / sym 均为必填');
    }
    const bytes = Buffer.from(String(b.imageBase64).replace(/^data:image\/[^;]+;base64,/i, ''), 'base64');
    if (bytes.length < 32) throw new BadRequestException('图像数据过小或非法 base64');
    let candidates: CandidateDecoded[];
    try {
      candidates = await decodeBarcodeImage(bytes, b.sym, { formats: b.formats });
    } catch (e: any) {
      throw new BadRequestException(`解码失败：${String(e?.message ?? e)}`);
    }
    const verdict = verdictOf(candidates, b.expected, b.sym);
    return { format: 'verify-image', sym: b.sym, verdict, candidates };
  }

  /** 三方一致性自检：bwip 渲染 → zxing 解码 → 判定（无需客户端准备图片） */
  @Post('roundtrip')
  async roundtrip(@Body() b: VerifyRoundtripDto) {
    if (!b.expected || !b.sym) throw new BadRequestException('expected / sym 均为必填');
    try {
      const rt = await renderAndDecode(b.expected, b.sym, b.dpi);
      const verdict = verdictOf(rt.candidates, b.expected, b.sym);
      return {
        format: 'verify-roundtrip',
        sym: b.sym,
        expected: b.expected,
        verdict,
        candidates: rt.candidates,
        pngBase64: rt.pngBase64,
        zxingFormats: zxingFormatsFor(b.sym),
        boundary: '仅验证 bwip 位图通道的渲染→解码一致性；ZPL/TSPL/EPL 指令通道与真机打印仍需硬件验收',
      };
    } catch (e: any) {
      throw new BadRequestException(`自检失败：${String(e?.message ?? e)}`);
    }
  }
}
