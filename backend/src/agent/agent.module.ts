// Agent/MCP 模块（P4 只读 + P5 写/审批/限流/幂等）
// 依赖方向：Agent → Inventory（库存读写）、Template/Print（写执行器复用领域服务）、
// Saas（模块/scope 字典、feature_flags 含 D7 与限流阈值）、Billing（agent_calls 计量）、Audit。
// ⚠️ 写执行器通过 tenantStorage.run 补齐 ALS 上下文（Agent 只有 token、没有租户 JWT）。
import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import {
  AgentApproval, AgentClient, AgentPrompt, AgentToken, ToolIdempotency,
} from './agent.entity';
import { Tenant } from '../entities/tenant.entity';
import { Template } from '../entities/template.entity';
import { AgentService } from './agent.service';
import { AgentTokenGuard } from './agent-token.guard';
import { ToolsService } from './tools.service';
import { ApprovalService } from './approval.service';
import { IdempotencyService } from './idempotency.service';
import { AgentRateService } from './agent-rate.service';
import { PromptsService } from './prompts.service';
import { PromptsController } from './prompts.controller';
import { AgentsController } from './agents.controller';
import { AgentV1Controller } from './agent-v1.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { SaasModule } from '../saas/saas.module';
import { BillingModule } from '../billing/billing.module';
import { AuditModule } from '../audit/audit.module';
import { TemplateModule } from '../template/template.module';
import { PrintModule } from '../print/print.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgentClient, AgentToken, AgentApproval, ToolIdempotency, AgentPrompt, Tenant, Template,
    ]),
    InventoryModule, SaasModule, BillingModule, AuditModule, TemplateModule, PrintModule,
  ],
  providers: [
    AgentService, AgentTokenGuard, ToolsService,
    ApprovalService, IdempotencyService, AgentRateService, PromptsService,
  ],
  controllers: [AgentsController, AgentV1Controller, PromptsController],
  exports: [AgentService, PromptsService],
})
export class AgentModule {}
