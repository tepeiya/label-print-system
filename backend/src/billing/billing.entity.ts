// P3 计费实体（docs/11 §11.7 / saas_p3_billing.sql）
// 金额一律用「分」（BIGINT），用量用 NUMERIC(14,2)（TypeORM 读出为字符串，服务层统一 Number 化）
import { Entity, PrimaryGeneratedColumn, PrimaryColumn, Column, Index, CreateDateColumn } from 'typeorm';

@Entity('usage_meters')
@Index('ix_usage_tenant_meter_time', ['tenantId', 'meter', 'occurredAt'])
export class UsageMeter {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  /** 计量项：print_labels / ai_generate / ... */
  @Column({ length: 40 }) meter: string;
  // string|null 联合类型反射为 Object，必须显式 type（同 tenant.entity.ts 的教训）
  @Column({ name: 'module_code', type: 'varchar', length: 40, nullable: true }) moduleCode: string | null;
  @Column({ type: 'numeric', precision: 14, scale: 2 }) quantity: string;
  @Column({ name: 'user_id', type: 'bigint', nullable: true }) userId: number | null;
  @Column('jsonb', { default: {} }) meta: Record<string, any>;
  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'now()' }) occurredAt: Date;
}

@Entity('usage_daily')
export class UsageDaily {
  @PrimaryColumn({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @PrimaryColumn({ length: 40 }) meter: string;
  @PrimaryColumn({ type: 'date' }) day: string;
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 }) quantity: string;
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}

@Entity('quotas')
export class Quota {
  @PrimaryColumn({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @PrimaryColumn({ length: 40 }) meter: string;
  /** 软上限：超过只告警不拦截；null = 不设限 */
  @Column({ name: 'soft_limit', type: 'numeric', precision: 14, scale: 2, nullable: true }) softLimit: string | null;
  /** 硬上限：超过拒绝（BizCode 4033 + 升级引导）；null = 不设限 */
  @Column({ name: 'hard_limit', type: 'numeric', precision: 14, scale: 2, nullable: true }) hardLimit: string | null;
  @Column({ length: 10, default: 'month' }) period: 'month' | 'day';
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}

@Entity('invoices')
@Index('ix_invoice_tenant_status', ['tenantId', 'status'])
export class Invoice {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  /** INV-<tenantId>-<yymm>-<seq>，全局唯一 */
  @Column({ length: 40, unique: true }) number: string;
  @Column({ name: 'amount_cents', type: 'bigint' }) amountCents: string;
  @Column({ length: 8, default: 'CNY' }) currency: string;
  /** draft → issued → paid / void；issued 过期由每日任务转 overdue */
  @Column({ length: 20 }) status: 'draft' | 'issued' | 'paid' | 'void' | 'overdue';
  @Column({ name: 'period_start', type: 'date', nullable: true }) periodStart: string | null;
  @Column({ name: 'period_end', type: 'date', nullable: true }) periodEnd: string | null;
  @Column({ name: 'due_at', type: 'timestamptz', nullable: true }) dueAt: Date | null;
  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true }) paidAt: Date | null;
  /** 出账快照：套餐/单价/行项，防运营改价后账单口径漂移 */
  @Column('jsonb', { default: {} }) detail: Record<string, any>;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('payments')
@Index('ix_payment_invoice', ['invoiceId'])
export class Payment {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ name: 'invoice_id', type: 'bigint' }) invoiceId: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  /** D5：V1 只有 manual（运营线下收款后登记）；其余通道预留 */
  @Column({ length: 20 }) provider: string;
  @Column({ name: 'provider_ref', type: 'varchar', length: 200, nullable: true }) providerRef: string | null;
  @Column({ name: 'amount_cents', type: 'bigint' }) amountCents: string;
  @Column({ type: 'varchar', length: 300, nullable: true }) note: string | null;
  @Column({ name: 'paid_by', type: 'bigint', nullable: true }) paidBy: number | null;
  @Column({ name: 'paid_at', type: 'timestamptz', default: () => 'now()' }) paidAt: Date;
}
