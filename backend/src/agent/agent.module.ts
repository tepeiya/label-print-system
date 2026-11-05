// Agent/MCP 模块（P4）：agent 表 + /agent/v1 + 租户管理面
// 依赖方向：Agent → Inventory（只读工具数据面）、Saas（模块/scope 字典）、Billing（agent_calls 计量）、Audit。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentClient, AgentToken } from './agent.entity';
import { Tenant } from '../entities/tenant.entity';
import { Template } from '../entities/template.entity';
import { AgentService } from './agent.service';
import { AgentTokenGuard } from './agent-token.guard';
import { ToolsService } from './tools.service';
import { AgentsController } from './agents.controller';
import { AgentV1Controller } from './agent-v1.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { SaasModule } from '../saas/saas.module';
import { BillingModule } from '../billing/billing.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AgentClient, AgentToken, Tenant, Template]),
    InventoryModule, SaasModule, BillingModule, AuditModule,
  ],
  providers: [AgentService, AgentTokenGuard, ToolsService],
  controllers: [AgentsController, AgentV1Controller],
  exports: [AgentService],
})
export class AgentModule {}
