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
// P4/P5 Agent 实体（表在 public schema，DDL 见 scripts/saas_p4_agent.sql / saas_p5_agent_tools.sql）
export { AgentClient, AgentToken, AgentApproval, ToolIdempotency, AgentPrompt } from '../agent/agent.entity';
// P6.4 白标实体（表 tenant_domains 建在 P0，补列见 scripts/saas_p6_branding.sql）
export { TenantDomain } from '../saas/branding/tenant-domain.entity';
// P4 库存最小读模型实体
export { Warehouse, Material, StockBatch, Bom, BomItem } from '../inventory/inventory.entity';
