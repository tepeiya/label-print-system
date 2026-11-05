// 实体统一出口（app.module 通过 import * as entities 批量注册）
export * from './tenant.entity';
export * from './template.entity';
export * from './serial.entity';
export * from './print.entity';
export * from './ai-template.entity';
export * from './saas.entity';
export { PlatformUser } from '../saas/platform-admin/platform-user.entity';
export { PlatformAuditLog } from '../saas/platform-admin/platform-audit.service';
// P3 计费实体（表在 public schema，DDL 见 scripts/saas_p3_billing.sql）
export { UsageMeter, UsageDaily, Quota, Invoice, Payment } from '../billing/billing.entity';
// P4 Agent 实体（表在 public schema，DDL 见 scripts/saas_p4_agent.sql）
export { AgentClient, AgentToken } from '../agent/agent.entity';
// P4 库存最小读模型实体
export { Warehouse, Material, StockBatch, Bom, BomItem } from '../inventory/inventory.entity';
