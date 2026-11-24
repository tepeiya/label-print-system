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
export { AgentClient, AgentToken, AgentApproval, ToolIdempotency, AgentPrompt, AgentPromptVersion } from '../agent/agent.entity';
// P6.4 白标实体（表 tenant_domains 建在 P0，补列见 scripts/saas_p6_branding.sql）
export { TenantDomain } from '../saas/branding/tenant-domain.entity';
// P4 库存最小读模型实体
export { Warehouse, WarehouseLocation, ProductGroup, Material, MaterialGtin, StockBatch, StockMove, Bom, BomItem } from '../inventory/inventory.entity';
// P7 / B2.5 站内信（DDL: scripts/saas_p7_notifications.sql）
export { Notification } from '../notify/notification.entity';
// P8.1 自动化触发器（DDL: scripts/saas_p8_triggers.sql）
export { PrintTrigger, TriggerDelivery } from '../jobs/trigger.entity';
// P8.3 企业治理（DDL: scripts/saas_p8_governance.sql）
export { GovernanceSetting, TemplateGovernance, TemplateReview, PrintDedupe } from '../governance/governance.entity';
// P8.5 硬件层（DDL: scripts/saas_p8_hardware.sql）
export { HardwareAgent, HardwareAgentJob, RfidWriteLog } from '../hardware/hardware.entity';
// WMS 阶段一（DDL: scripts/wms_p1_inbound.sql）
export { WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule } from '../wms/inbound/entities/wms.entity';
// UDI 医疗追溯（DDL: scripts/udi_p1_trace.sql）
export { UdiUnit, UdiPackage, UdiEvent, UdiDiMaster, UdiSubmission } from '../udi/entities/udi.entity';
// WMS 阶段二（DDL: scripts/wms_p2_issuing.sql）
export { WmsWorkOrder, WmsWoLine, WmsIssueRecord, WmsWoReturn } from '../wms/issuing/entities/wo.entity';
// 平台端知识库 + AI 助手（DDL: scripts/kb_p1_articles.sql；无 tenant_id，平台身份守卫）
export { KbArticle, KbAssistantLog } from '../kb/kb.entity';
