// Agent 层实体（docs/11 §11.5.3；DDL 见 backend/scripts/saas_p4_agent.sql）
// agent_clients / agent_tokens / agent_approvals（P5 审批流接线，§11.7.6）
// ToolIdempotency 在 P5 新增（§11.7.4 写操作幂等），DDL 见 scripts/saas_p5_agent_tools.sql。
// external_mcp_servers 仍不接实体（D10 预留不实现）。
import {
  Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, JoinColumn, CreateDateColumn,
} from 'typeorm';

@Entity('agent_clients')
@Index('ix_agent_tenant', ['tenantId'])
export class AgentClient {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ length: 80 }) name: string;
  @Column({ length: 300, type: 'varchar', nullable: true }) description: string | null;
  // 联合字面量同样要显式 type（DataTypeNotSupportedError 教训，见 tenant.entity.ts 注释）
  @Column({ type: 'varchar', length: 20, default: 'mcp_stdio' }) kind: 'mcp_stdio' | 'mcp_http' | 'internal';
  @Column({ type: 'varchar', length: 20, default: 'active' }) status: 'active' | 'disabled';
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('agent_tokens')
@Index('ix_agenttok_client', ['clientId'])
export class AgentToken {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'agent_client_id', type: 'bigint' }) clientId: number;
  @ManyToOne(() => AgentClient, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_client_id' }) client: AgentClient;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'token_hash', length: 100, unique: true }) tokenHash: string;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) scopes: string[];
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true }) expiresAt: Date | null;
  @Column({ default: false }) revoked: boolean;
  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true }) lastUsedAt: Date | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

/** 高危操作审批单（§11.7.6：pending → approved(5 分钟一次性) → consumed / rejected / expired） */@Entity('agent_approvals')
@Index('ix_agentappr_tenant_status', ['tenantId', 'status'])
export class AgentApproval {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'agent_client_id', type: 'bigint' }) agentClientId: number;
  @ManyToOne(() => AgentClient, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_client_id' }) client: AgentClient;
  @Column({ length: 60 }) tool: string;
  /** 参数指纹（去掉 approval_id 的稳定 JSON sha256）——批准的就是这份参数 */
  @Column({ name: 'args_hash', length: 64 }) argsHash: string;
  /** 折叠后的参数预览（给员工看的「谁要做什么」，长文本已截断） */
  @Column({ name: 'args_preview', type: 'jsonb', default: () => "'{}'" }) argsPreview: Record<string, any>;
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt: Date;
  @Column({ name: 'approved_by', type: 'bigint', nullable: true }) approvedBy: number | null;
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true }) approvedAt: Date | null;
  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true }) consumedAt: Date | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

/**
 * 写工具幂等表（§11.7.4「写操作幂等」/ §11.7.7 护栏 4）。
 * 唯一键 (tenantId, tool, idemKey)：命中即重放首次结果，不再执行执行器。
 */
@Entity('tool_idempotency')
@Index('ix_tool_idem_tenant_created', ['tenantId', 'createdAt'])
export class ToolIdempotency {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'agent_client_id', type: 'bigint' }) agentClientId: number;
  @Column({ length: 60 }) tool: string;
  @Column({ name: 'idem_key', length: 80 }) idemKey: string;
  @Column({ name: 'args_hash', length: 64 }) argsHash: string;
  @Column({ type: 'jsonb', nullable: true }) result: Record<string, any> | null;
  @Column({ name: 'approval_id', type: 'bigint', nullable: true }) approvalId: number | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

/**
 * 租户级提示词覆盖 / 自定义（P6.5，docs/11 §11.7.5）。
 * 系统默认在代码里（prompt.defaults.ts），本表只存「租户改过的或自己加的」：
 * 同名行覆盖系统提示词，删除即回落默认；enabled=false 表示从 Agent 的 prompts/list 隐藏。
 */
@Entity('agent_prompts')
@Index('ix_agentprompt_tenant', ['tenantId'])
@Index('ux_agentprompt_tenant_name', ['tenantId', 'name'], { unique: true })
export class AgentPrompt {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ length: 64 }) name: string;
  @Column({ length: 120 }) title: string;
  @Column({ length: 500, default: '' }) description: string;
  @Column('text') content: string;
  @Column('jsonb', { default: () => "'[]'" }) arguments: any[];
  @Column({ default: true }) enabled: boolean;
  @Column({ name: 'sort_order', default: 100 }) sortOrder: number;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @Column({ name: 'updated_by', type: 'bigint', nullable: true }) updatedBy: number | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}
