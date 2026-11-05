// Agent 层实体（docs/11 §11.5.3；DDL 见 backend/scripts/saas_p4_agent.sql）
// agent_approvals / external_mcp_servers 建表但 P4 不接实体：审批流在 P5（§11.7.6），
// 反向 MCP 预留不实现（D10）。
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
