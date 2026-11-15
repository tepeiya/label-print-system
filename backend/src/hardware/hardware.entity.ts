// =============================================================================
// hardware.entity.ts —— P8.5 本地代理 / RFID 相关实体
// 所有业务表显式带 tenant_id（多租户红线），DDL 见 scripts/saas_p8_hardware.sql。
// =============================================================================
import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn,
} from 'typeorm';

/** 注册在本租户下的本地打印代理（一台机器一个 agentId） */
@Entity('hardware_agents')
@Index('ix_hardware_agents_tenant', ['tenantId'])
export class HardwareAgent {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'agent_id', length: 64 }) agentId: string;
  @Column({ length: 120 }) name: string;
  @Column('jsonb', { default: [] }) capabilities: string[];
  @Column('jsonb', { name: 'driver_names', default: [] }) driverNames: string[];
  /** HMAC 签名密钥的 AES-256-GCM 密文：签名校验需要明文，故不能只存 hash */
  @Column({ name: 'secret_enc', type: 'text' }) secretEnc: string;
  /** 密钥指纹（SHA-256），仅用于运维核对/轮换，不参与签名 */
  @Column({ name: 'secret_hash', length: 64 }) secretHash: string;
  @Column({ length: 20, default: 'active' }) status: string;
  @Column({ name: 'last_heartbeat_at', type: 'timestamptz', nullable: true }) lastHeartbeatAt: Date | null;
  @Column({ type: 'int', default: 0 }) load: number;
  @Column({ default: false }) draining: boolean;
  @Column('jsonb', { default: {} }) metadata: Record<string, any>;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

/** 待代理拉取的打印/写码任务；job_key 唯一保证重复入队幂等 */
@Entity('hardware_agent_jobs')
@Index('ix_hardware_jobs_tenant_status', ['tenantId', 'status'])
@Index('uq_hardware_jobs_tenant_key', ['tenantId', 'jobKey'], { unique: true })
export class HardwareAgentJob {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'job_key', length: 64 }) jobKey: string;
  @Column({ name: 'agent_id', type: 'varchar', length: 64, nullable: true }) agentId: string | null;
  @Column({ name: 'job_id' }) jobId: number;
  @Column({ name: 'printer_id', type: 'bigint', nullable: true }) printerId: number | null;
  @Column({ name: 'template_id', type: 'bigint', nullable: true }) templateId: number | null;
  @Column({ length: 20, default: 'pending' }) status: string;
  @Column({ length: 32, default: 'windows_spooler' }) capability: string;
  @Column('jsonb') envelope: Record<string, any>;
  @Column({ type: 'int', default: 0 }) attempts: number;
  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true }) claimedAt: Date | null;
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true }) finishedAt: Date | null;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

/** RFID 写后读回留痕：verified=false 的写操作必须可追溯 */
@Entity('hardware_rfid_logs')
@Index('ix_hardware_rfid_tenant', ['tenantId'])
export class RfidWriteLog {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ length: 24 }) epc: string;
  @Column({ name: 'read_back', type: 'varchar', length: 24, nullable: true }) readBack: string | null;
  @Column({ default: false }) verified: boolean;
  @Column({ name: 'job_id', type: 'bigint', nullable: true }) jobId: number | null;
  @Column({ name: 'detail', type: 'text', nullable: true }) detail: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
