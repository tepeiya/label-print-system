// 模板 / 版本 / 资源 / 共享 实体
import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('templates')
@Index('ix_templates_tenant', ['tenantId'])
@Index('ix_templates_tenant_name', ['tenantId', 'name'])
export class Template {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;          // 租户隔离字段
  @Column('uuid', { unique: false }) uuid: string;
  @Column({ length: 160 }) name: string;
  @Column({ length: 60, nullable: true }) category: string;
  @Column('text', { array: true, default: '{}' }) tags: string[];   // 对齐 DDL 的 TEXT[] 数组列
  @Column({ length: 500, nullable: true }) description: string;
  @Column({ name: 'schema_version', default: 1 }) schemaVersion: number;
  @Column('jsonb') content: Record<string, any>;            // 设计器完整产物
  @Column({ type: 'bytea', nullable: true }) thumbnail: Buffer;
  @Column({ name: 'current_version', default: 1 }) currentVersion: number;
  @Column('jsonb', { default: {} }) acl: Record<string, string[]>;
  @Column({ name: 'is_favorite', default: false }) isFavorite: boolean;
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @Column({ name: 'updated_by', nullable: true }) updatedBy: number;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('template_versions')
@Index('ix_tplver_tenant_template', ['tenantId', 'templateId'])
export class TemplateVersion {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'template_id' }) templateId: number;
  @Column() version: number;
  @Column('jsonb') content: Record<string, any>;
  @Column({ length: 300, nullable: true }) comment: string;
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @CreateDateColumn() createdAt: Date;
}

@Entity('template_assets')
@Index('ix_assets_tenant_template', ['tenantId', 'templateId'])
export class TemplateAsset {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'template_id' }) templateId: number;
  @Column({ name: 'asset_key', length: 120 }) assetKey: string;
  @Column({ length: 60, nullable: true }) mime: string;
  @Column({ type: 'bytea', nullable: true }) data: Buffer;
  @CreateDateColumn() createdAt: Date;
}

@Entity('template_shares')
@Index('ix_shares_tenant_sharedwith', ['tenantId', 'sharedWith'])
export class TemplateShare {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'template_id' }) templateId: number;
  @Column({ name: 'shared_with' }) sharedWith: number;
  @Column('text', { array: true, default: () => "'{view}'" }) perms: string[];
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @CreateDateColumn() createdAt: Date;
}
