// =============================================================================
// DedicatedProvisionService —— P6.2 阶段 B：独立库开通编排（docs/10 §10.25.8 B1.2）
//
// 【红线 1｜DSN 永不落库】DSN 只从入参进进程内存，绝不写 tenants / 任何业务表 /
// 平台审计（审计只记 maskDsn 脱敏形式）。tenants 只存不含凭据的 data_source_key。
// 【红线 2｜校验不过不切 key】switch_key 前用 canSwitchKey() 再闸一次；
// 任何步骤失败都进回滚，租户仍留在共享库，业务不中断（新建场景天然回滚）。
// 【红线 3｜不自动删库】建库是唯一不可逆步骤，失败只保留空库交运维处置，
// 编排器与退库回收都不执行 DROP DATABASE。
//
// ⚠️ 真连库验收前置：沙盒只有一套 PostgreSQL 实例，本服务的 SQL 执行路径
// （CREATE DATABASE / 跨库搬数据 / session_replication_role）需要第二个实例 +
// superuser 的 admin DSN 才能实跑；纯逻辑（状态机、行数校验、回滚顺序）已单测覆盖。
// 文档里不得据此宣称「独立库开通已验收」。
// =============================================================================
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { TenantDataSourceManager } from '../../common/tenant-data-source.manager';
import { PlatformAuditService } from './platform-audit.service';
import { ProvisionService } from '../provision.service';
import { dsnTarget, maskDsn, validateKey } from './dedicated.calc';
import {
  STEP_ORDER, canSwitchKey, nextStep, orchestrationSummary, rollbackPlan,
  stateTransition, verifyRowCounts, type OrchestrationState, type ProvisionStep,
} from './dedicated.orchestration.calc';

/**
 * 新库要跑的 DDL（按依赖顺序）。刻意**不跑** saas_p6_rls.sql：
 * 独立库的隔离来自库边界，且该脚本的 CREATE POLICY TO labelflow_app 要求目标库
 * 已存在该角色，否则整份 DDL 失败。也不跑 seed.sql（会插默认租户 id=1，与迁移冲突）。
 */
const DEFAULT_DDL_FILES = [
  '../docs/03-database.sql',
  'scripts/saas_p0.sql',
  'scripts/saas_p0_roles.sql',
  'scripts/saas_p2_platform.sql',
  'scripts/saas_p3_billing.sql',
  'scripts/saas_p4_agent.sql',
  'scripts/saas_p5_agent_tools.sql',
  'scripts/saas_p6_tenant_data.sql',
  'scripts/saas_p6_branding.sql',
  'scripts/saas_p6_dedicated.sql',
  'scripts/saas_p6_prompts.sql',
  'scripts/saas_p7_notifications.sql',
];

/** 迁移单批行数（避免一次性把大表读进内存） */
const MIGRATE_BATCH = 500;

export interface MigrationInput {
  tenantId: number;
  dataSourceKey: string;
  /** 只在内存里活着，绝不落库 */
  dsn: string;
  /** 建库用的管理员 DSN（默认从 dsn 推导连到 postgres 库） */
  adminDsn?: string;
  /** 是否执行 CREATE DATABASE（目标库已存在时传 false） */
  createDatabase?: boolean;
  actor: { id: number; username?: string };
}

export interface StepLog {
  step: ProvisionStep;
  ok: boolean;
  detail: string;
  at: string;
}

export interface OrchestrationReport {
  tenantId: number;
  dataSourceKey: string;
  state: OrchestrationState;
  verified: boolean;
  switched: boolean;
  steps: StepLog[];
  rollback: { step: ProvisionStep; action: string; status: 'done' | 'manual' | 'failed'; detail?: string }[];
  counts?: { before: Record<string, number>; after: Record<string, number>; checkedTables: number; mismatches: string[] };
  /** 脱敏后的目标（审计/日志可安全输出） */
  maskedDsn: string;
}

function quoteIdent(s: string): string {
  return `"${String(s).replace(/"/g, '""')}"`;
}

@Injectable()
export class DedicatedProvisionService {
  private logger = new Logger('DedicatedProvisionService');

  constructor(
    @InjectDataSource() private shared: DataSource,
    private tdsm: TenantDataSourceManager,
    private audit: PlatformAuditService,
    private moduleRef: ModuleRef,
  ) {}

  /** 编排计划预览（不执行、不接触 DSN，平台后台可先给运营看步骤） */
  plan(key: string, tenantId: number) {
    const chk = validateKey(key);
    if (!chk.ok) throw new BadRequestException(chk.reason);
    return orchestrationSummary(key, tenantId);
  }

  /**
   * 「一条命令开通独立库租户」：先在共享库按标准流程建租户（复用 ProvisionService，
   * 保证管理员/订阅/模块/角色/feature_flags 全部齐备），再整体迁移到独立库。
   * 迁移失败时租户仍留在共享库且 data_source_key 未切 → 业务不受影响，天然回滚。
   */
  async provisionNew(
    dto: Parameters<ProvisionService['provision']>[0] & { dataSourceKey: string; dedicatedDsn: string; adminDsn?: string },
    actor: { id: number; username?: string },
  ) {
    const chk = validateKey(dto.dataSourceKey);
    if (!chk.ok) throw new BadRequestException(chk.reason);
    if (!dto.dedicatedDsn) throw new BadRequestException('独立库开通需要 dedicatedDsn（仅进程内存使用，不落库）');
    // 用 ModuleRef 懒取，避免 ProvisionService ↔ 本服务的构造期循环依赖
    const provision = this.moduleRef.get(ProvisionService, { strict: false });
    const created = await provision.provision({ ...dto, type: 'shared' });
    const report = await this.migrate({
      tenantId: created.tenantId,
      dataSourceKey: dto.dataSourceKey,
      dsn: dto.dedicatedDsn,
      adminDsn: dto.adminDsn,
      createDatabase: true,
      actor,
    });
    return { created, orchestration: report };
  }

  /** 主编排：按 STEP_ORDER 逐步执行，失败进回滚 */
  async migrate(input: MigrationInput): Promise<OrchestrationReport> {
    const { tenantId, dataSourceKey: key, dsn, actor } = input;
    const chk = validateKey(key);
    if (!chk.ok) throw new BadRequestException(chk.reason);
    const target = dsnTarget(dsn);
    if (!target) throw new BadRequestException('dedicatedDsn 不是有效的 postgres 连接串（须带库名）');

    const report: OrchestrationReport = {
      tenantId, dataSourceKey: key, state: 'idle', verified: false, switched: false,
      steps: [], rollback: [], maskedDsn: maskDsn(dsn),
    };
    let state: OrchestrationState = 'idle';
    const completed: ProvisionStep[] = [];
    let verified = false;
    let targetDs: DataSource | null = null;
    let countsBefore: Record<string, number> = {};

    const log = (step: ProvisionStep, ok: boolean, detail: string) => {
      report.steps.push({ step, ok, detail, at: new Date().toISOString() });
      this.logger.log(`[独立库编排 ${key}] ${step} ${ok ? 'OK' : 'FAIL'}: ${detail}`);
    };

    try {
      state = stateTransition(state, 'start');
      let step: ProvisionStep | null = STEP_ORDER[0];
      while (step) {
        let ok = false;
        let detail = '';
        try {
          switch (step) {
            case 'create_database': {
              if (input.createDatabase === false) {
                ok = true; detail = '目标库已存在，跳过 CREATE DATABASE';
              } else {
                const r = await this.createDatabase(dsn, input.adminDsn, target.database);
                ok = true; detail = r;
              }
              break;
            }
            case 'run_ddl': {
              targetDs = await this.openTarget(dsn);
              const files = this.ddlFiles();
              for (const f of files) {
                const sql = fs.readFileSync(path.resolve(process.cwd(), f), 'utf8');
                await targetDs.query(sql);
              }
              ok = true; detail = `已执行 ${files.length} 份 DDL（跳过 RLS 脚本：库边界即隔离）`;
              break;
            }
            case 'migrate_rows': {
              if (!targetDs) throw new Error('目标库连接未建立');
              countsBefore = await this.countRows(this.shared, tenantId);
              const moved = await this.migrateRows(this.shared, targetDs, tenantId, countsBefore);
              ok = true; detail = `迁移 ${moved.tables} 张表 / ${moved.rows} 行`;
              break;
            }
            case 'verify_counts': {
              if (!targetDs) throw new Error('目标库连接未建立');
              const after = await this.countRows(targetDs, tenantId);
              const v = verifyRowCounts(countsBefore, after);
              report.counts = { before: countsBefore, after, checkedTables: v.checkedTables, mismatches: v.mismatches };
              verified = v.ok;
              ok = v.ok;
              detail = v.ok ? `逐表行数一致（${v.checkedTables} 张表）` : `行数不一致：${v.mismatches.join('；')}`;
              break;
            }
            case 'register_datasource': {
              await this.tdsm.registerFromUrl(key, dsn, 'api');
              ok = true; detail = '数据源已注册并通过库结构自检';
              break;
            }
            case 'switch_key': {
              // 最后一道闸门：状态机 + 已完成步骤 + 校验结果，三者齐备才允许切
              if (!canSwitchKey(completed, verified, state)) {
                throw new Error('拒绝切换：前置步骤未完成或行数校验未通过');
              }
              await this.shared.query(
                `update public.tenants set data_source_key = $1, type = 'dedicated' where id = $2`,
                [key, tenantId],
              );
              report.switched = true;
              ok = true; detail = 'data_source_key 已切换，后续业务读写按 TenantCtx 路由到独立库';
              break;
            }
            default:
              throw new Error(`未处理的步骤 ${step}`);
          }
        } catch (e: any) {
          ok = false;
          detail = e?.message ?? String(e);
        }

        log(step, ok, detail);
        if (!ok) {
          state = stateTransition(state, step === 'verify_counts' ? 'verify_failed' : 'step_failed');
          break;
        }
        completed.push(step);
        if (step === 'verify_counts') state = stateTransition(state, 'verify_ok');
        if (step === 'register_datasource') state = stateTransition(state, 'step_ok');
        step = nextStep(step);
      }

      if (completed.length === STEP_ORDER.length && verified && report.switched) {
        state = stateTransition(state, 'switch_ok');
        report.state = state;
        await this.audit.write(actor, 'platform.dedicated.provision', {
          tenantId, key, maskedDsn: report.maskedDsn,
          tables: report.counts?.checkedTables ?? 0, state,
        }, 'data_source');
        return report;
      }

      // 失败：执行回滚（绝不切 key / 已切的切回）
      report.state = stateTransition(state, 'rollback_done');
      await this.rollback(report, completed, tenantId, key, targetDs);
      return report;
    } catch (e: any) {
      // 编排器自身异常（非单步失败）：同样保证租户留在共享库
      this.logger.error(`[独立库编排 ${key}] 编排异常: ${e?.message ?? e}`);
      report.state = 'failed';
      report.steps.push({ step: 'create_database', ok: false, detail: `编排异常：${e?.message ?? e}`, at: new Date().toISOString() });
      await this.rollback(report, completed, tenantId, key, targetDs);
      return report;
    } finally {
      // 目标库连接是编排器自建的临时连接，注册进 tdsm 的连接池由 tdsm 自己管理
      if (targetDs?.isInitialized) await targetDs.destroy().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 步骤实现

  private ddlFiles(): string[] {
    const fromEnv = String(process.env.DEDICATED_DDL_FILES ?? '').trim();
    const list = fromEnv ? fromEnv.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_DDL_FILES;
    return list.filter((f) => fs.existsSync(path.resolve(process.cwd(), f)));
  }

  /** 建库：连到 admin 库（默认 postgres）执行 CREATE DATABASE，已存在视为幂等成功 */
  private async createDatabase(dsn: string, adminDsn: string | undefined, database: string): Promise<string> {
    if (!/^[a-z0-9_][a-z0-9_]{0,62}$/.test(database)) {
      throw new Error(`目标库名 "${database}" 不合法（只允许小写字母/数字/下划线）`);
    }
    const target = dsnTarget(dsn);
    let adminUrl = adminDsn;
    if (!adminUrl && target) {
      const u = new URL(dsn);
      u.pathname = '/postgres';
      adminUrl = u.toString();
    }
    if (!adminUrl) throw new Error('无法推导建库连接（请传 adminDsn）');
    const admin = new DataSource({
      type: 'postgres', url: adminUrl, entities: [], synchronize: false,
      logging: false, connectTimeoutMS: 5000, extra: { max: 1 },
    });
    try {
      await admin.initialize();
      try {
        await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);
        return `已建库 ${database}`;
      } catch (e: any) {
        if (String(e?.code) === '42P04') return `库 ${database} 已存在（幂等跳过）`;
        throw e;
      }
    } finally {
      if (admin.isInitialized) await admin.destroy().catch(() => {});
    }
  }

  /** 编排期临时连接（不注册进 tdsm；注册步骤会另建正式连接池） */
  private async openTarget(dsn: string): Promise<DataSource> {
    const ds = new DataSource({
      type: 'postgres', url: dsn, entities: [], synchronize: false,
      logging: false, connectTimeoutMS: 5000, extra: { max: 2 },
    });
    await ds.initialize();
    return ds;
  }

  /** 所有带 tenant_id 的业务表（pg_catalog 现取，避免硬编码清单漂移） */
  private async tenantTables(ds: DataSource): Promise<string[]> {
    const rows: any[] = await ds.query(`
      select distinct c.relname::text as t
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
                            and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r','p')
      order by 1`);
    return rows.map((r) => String(r.t));
  }

  private async countRows(ds: DataSource, tenantId: number): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of await this.tenantTables(ds)) {
      const r: any[] = await ds.query(
        `select count(*)::int as n from public.${quoteIdent(t)} where tenant_id = $1`, [tenantId],
      );
      out[t] = Number(r[0]?.n ?? 0);
    }
    return out;
  }

  /** 逐表搬数据；先清空目标库该租户的旧行（幂等重跑），再按列名批量 INSERT */
  private async migrateRows(
    src: DataSource, dst: DataSource, tenantId: number, tables: Record<string, number>,
  ): Promise<{ tables: number; rows: number }> {
    let total = 0;
    let tableCount = 0;
    // 关闭 FK/触发器约束检查（跨表插入顺序不必拓扑排序）；要求 admin 连接具备相应权限
    let relaxed = false;
    try {
      await dst.query('SET session_replication_role = replica');
      relaxed = true;
    } catch (e: any) {
      this.logger.warn(`无法关闭约束检查（${e?.message}），将按表名顺序插入，若遇 FK 报错会整体回滚`);
    }
    try {
      for (const t of Object.keys(tables).sort()) {
        const cols: any[] = await src.query(
          `select column_name::text as c from information_schema.columns
           where table_schema='public' and table_name=$1 order by ordinal_position`, [t],
        );
        const names = cols.map((c) => String(c.c));
        if (!names.length) continue;
        const all: any[] = await src.query(
          `select * from public.${quoteIdent(t)} where tenant_id = $1 order by id`, [tenantId],
        );
        await dst.query(`delete from public.${quoteIdent(t)} where tenant_id = $1`, [tenantId]);
        const colSql = names.map(quoteIdent).join(', ');
        for (let i = 0; i < all.length; i += MIGRATE_BATCH) {
          const chunk = all.slice(i, i + MIGRATE_BATCH);
          const params: any[] = [];
          const tuples = chunk.map((row) => {
            const ph = names.map((c) => { params.push(row[c] ?? null); return `$${params.length}`; });
            return `(${ph.join(',')})`;
          });
          await dst.query(
            `insert into public.${quoteIdent(t)} (${colSql}) values ${tuples.join(',')}`, params,
          );
        }
        total += all.length;
        tableCount += 1;
      }
    } finally {
      if (relaxed) await dst.query('SET session_replication_role = DEFAULT').catch(() => {});
    }
    return { tables: tableCount, rows: total };
  }

  /** 逆序回滚；不可逆步骤（建库）只标 manual，交运维处置 */
  private async rollback(
    report: OrchestrationReport, completed: ProvisionStep[],
    tenantId: number, key: string, targetDs: DataSource | null,
  ): Promise<void> {
    stateTransition('rolling_back', 'rollback_done');
    for (const action of rollbackPlan(completed)) {
      if (!action.auto) {
        report.rollback.push({ step: action.step, action: action.action, status: 'manual' });
        continue;
      }
      try {
        switch (action.step) {
          case 'switch_key':
            await this.shared.query(
              `update public.tenants set data_source_key = null, type = 'shared' where id = $1`, [tenantId],
            );
            report.switched = false;
            break;
          case 'register_datasource':
            await this.tdsm.unregisterDedicated(key);
            break;
          case 'migrate_rows':
            if (targetDs?.isInitialized) {
              for (const t of await this.tenantTables(targetDs)) {
                await targetDs.query(`delete from public.${quoteIdent(t)} where tenant_id = $1`, [tenantId]);
              }
            }
            break;
          default:
            break;
        }
        report.rollback.push({ step: action.step, action: action.action, status: 'done' });
      } catch (e: any) {
        report.rollback.push({ step: action.step, action: action.action, status: 'failed', detail: e?.message ?? String(e) });
      }
    }
    this.logger.warn(`[独立库编排 ${key}] 已回滚，租户 ${tenantId} 仍留在共享库（data_source_key 未切换）`);
  }
}
