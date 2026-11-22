// 内部打印端点 DTO（方向 A：WMS 通过 PrintGateway 调用）
// 租户身份只从 service token 解析，body 中即使带 tenantId 也会被忽略并告警。
import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class InternalPrintJobDto {
  @IsString() @Length(1, 60) templateCode!: string;       // 人可读模板编码，如 RECEIPT_LABEL_V1
  @IsOptional() @IsString() @Length(1, 80) printerRoute?: string;  // 逻辑路由名，非物理打印机名
  @IsString() @Length(1, 128) idempotencyKey!: string;    // 幂等键，(tenant_id, key) 唯一
  @IsObject() variables!: Record<string, any>;            // 模板变量（由 WMS 过账服务组装）
  @IsOptional() @IsString() @Length(1, 64) source?: string;         // 审计/计费归因，如 wms.inbound.receipt
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) copies?: number;
}
