import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * 平台端知识库文章。**没有 tenant_id** —— 内容归平台方维护，只经平台身份接口下发。
 * 表结构见 scripts/kb_p1_articles.sql。
 */
@Entity('kb_articles')
@Index('ix_kb_articles_category', ['category', 'sort'])
export class KbArticle {
  @PrimaryGeneratedColumn() id: number;
  @Column({ length: 80 }) slug: string;
  @Column({ length: 200 }) title: string;
  @Column({ length: 40 }) category: string;
  @Column({ type: 'text', default: '' }) tags: string;
  @Column({ length: 400, type: 'varchar', nullable: true }) summary: string | null;
  @Column('text') content: string;
  @Column({ default: 100 }) sort: number;
  @Column({ default: true }) published: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

/** AI 助手问答留痕。只记"问了什么、命中哪些文章、谁答的"，不存模型原始返回全文 */
@Entity('kb_assistant_logs')
@Index('ix_kb_assistant_logs_created', ['createdAt'])
export class KbAssistantLog {
  @PrimaryGeneratedColumn() id: number;
  @Column({ length: 1000 }) question: string;
  @Column({ name: 'tenant_id', type: 'bigint', nullable: true }) tenantId: number | null;
  @Column('jsonb', { default: [] }) hits: any;
  @Column({ name: 'answered_by', length: 20, default: 'kb' }) answeredBy: string;
  @Column({ length: 120, type: 'varchar', nullable: true }) model: string | null;
  @Column({ name: 'duration_ms', type: 'integer', nullable: true }) durationMs: number | null;
  @Column('jsonb', { default: {} }) detail: any;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
