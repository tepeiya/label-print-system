// AI 模板生成：任务表 + Vision LLM 配置表
import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('ai_template_jobs')
@Index('ix_aitpljobs_tenant_created', ['tenantId', 'createdAt'])
export class AiTemplateJob {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ length: 20, default: 'queued' }) status: string;   // queued/running/done/failed
  @Column({ name: 'image_path', type: 'text', nullable: true }) imagePath: string;
  @Column({ name: 'image_bytes', type: 'bigint', nullable: true }) imageBytes: number;
  @Column('jsonb', { default: {} }) params: Record<string, any>;
  @Column('jsonb', { nullable: true }) result: Record<string, any>;
  @Column({ name: 'error_msg', type: 'text', nullable: true }) errorMsg: string;
  @Column({ name: 'elapsed_ms', nullable: true }) elapsedMs: number;
  @Column({ length: 120, nullable: true }) model: string;
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @CreateDateColumn() createdAt: Date;
  @Column({ name: 'finished_at', nullable: true }) finishedAt: Date;
}

@Entity('ai_model_configs')
@Index('ix_aimodels_tenant', ['tenantId'])
export class AiModelConfig {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ length: 60 }) name: string;
  @Column({ length: 40 }) provider: string;   // openai / qwen / zhipu / ollama / custom
  @Column({ name: 'api_endpoint', type: 'text', nullable: true }) apiEndpoint: string;
  @Column({ name: 'api_key_enc', type: 'text', nullable: true }) apiKeyEnc: string;
  @Column({ name: 'model_id', length: 120 }) modelId: string;
  @Column({ name: 'is_default', default: false }) isDefault: boolean;
  @Column('jsonb', { default: {} }) settings: Record<string, any>;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
