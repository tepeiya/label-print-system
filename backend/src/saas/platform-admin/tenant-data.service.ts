// =============================================================================
// TenantDataService —— 平台侧「租户数据导出 / 硬删」（docs/11 D12 保留期 + §11.2 RLS 兜底）
//
// 与租户侧 BackupService 的区别：
//   · BackupService 是「租户自己备份自己」，表清单是 P0 时代手写的 16 张，SaaS/P3/P4/P5 的表不在里面；
//   · 这里是平台运营视角的合规动作：**表清单从 information_schema 现取**，
//     新增业务表自动进导出/删除范围，不会因为「忘了维护清单」而漏掉客户数据。
//
// 两条安全底线：
//   1. 所有跨表批操作跑在 TenantDataSourceManager.withTenantScope() 上（事务级 app.tenant_id），
//      RLS 生效时（配了 DB_RLS_USER）即便 where 漏写也只碰得到一个租户；没配则明确降级，
//      返回值里 rlsActive=false 如实写出来，不假装已隔离。
//   2. 硬删要过 assertPurgeAllowed：确认串逐字等于租户 code + 要么到 D12 保留期、要么显式 force。
//      删之前自动落一份 purge-pre 快照（tenant_backups），删完逐表复查剩余行数。
// =============================================================================
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { gzipSync } from 'zlib';
import { EntityManager } from 'typeorm';
import { TenantDataSourceManager } from '../../common/tenant-data-source.manager';
import { PlatformAuditService } from './platform-audit.service';
import {
  EXPORT_ROW_CAP, RETENTION_DAYS, assertPurgeAllowed, backupName, deleteOrder, filterTables, retentionOf,
} from './tenant-data.calc';

/** 平台元数据表：没有 tenant_id，也不属于「客户业务数据」，永远不进导出/删除范围 */
const NEVER_TOUCHED = ['tenants', 'modules', 'plans', 'plan_modules', 'permissions', 'role_permissions',
  'platform_users', 'platform_audit_logs'];

/** tenant_backups 里存的是快照本体，硬删时保留（否则删证据等于删保险） */
const KEEP_ON_PURGE = ['tenant_backups'];

interface TenantRow { id: number; code: string; name: string; canceledAt: Date | null }
interface TablePlan {
  /** 带 tenant_id 的业务表 */
  tenantTables: string[];
  /** 没有 tenant_id、靠父表归属的家生子（如 bom_items） */
  childTables: { table: string; parent: string; column: string }[];
  /** 外键边（child→parent），用于算删除顺序 */
  edges: { child: string; parent: string }[];
}

@Injectable()
export class TenantDataService {
  private readonly logger = new Logger(TenantDataService.name);
  /** 表结构基本不变；**按库**缓存（独立库可能是另一套迁移进度，不能混用清单） */
  private readonly planCache = new Map<string, TablePlan>();

  constructor(private readonly tdsm: TenantDataSourceManager, private readonly audit: PlatformAuditService) {}

  private poolFor(key: string) { return this.tdsm.get({ dataSourceKey: key }); }

  /** 租户的库归属：只看目录库（共享库）的 tenants.data_source_key，空=default */
  private async routingKey(tenantId: number): Promise<string> {
    const rows: any[] = await this.poolFor('default').query(
      'select data_source_key from public.tenants where id = $1', [tenantId]);
    if (!rows.length) throw new NotFoundException('租户不存在');
    return (rows[0].data_source_key as string) || 'default';
  }

  /** 独立库租户只钉库，不切 RLS 连接（隔离来自库边界）；共享租户照旧走 RLS 角色 */
  private scopeOpts(key: string) {
    return key === 'default' ? {} : { dataSource: this.poolFor(key) };
  }

  /**
   * 表清单从 **pg_catalog** 现取（进程内缓存一次），并且用**主连接**取。两个都是踩出来的：
   * ① `information_schema.columns` / `table_constraints` / `key_column_usage` / `constraint_column_usage`
   *    这些视图按**当前角色的权限**过滤。用 `labelflow_app` 连库时它查不到 `bom_items` 的外键（实测返回 0 行），
   *    于是「家生子」被**静默漏掉**——导出少一张表、硬删留下孤儿行还不报错。
   *    `pg_constraint` / `pg_class` / `pg_attribute` 只要对该表有任意权限就完整可见，不受这个坑影响。
   * ② 结构元数据不是租户数据，本来就该走平台侧连接，不该带 `app.tenant_id` GUC。
   * 副作用是「表没授权给运行角色」时数据读取会**直接 permission denied 炸出来**，而不是被静默跳过——这正是想要的行为。
   */
  private async plan(key = 'default'): Promise<TablePlan> {
    const cached = this.planCache.get(key);
    if (cached) return cached;
    const pool = this.poolFor(key);
    const tidRows: any[] = await pool.query(`
      select c.relname as t
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p')`);
    const tenantTables = filterTables(tidRows.map((r) => r.t), NEVER_TOUCHED).sort();

    const fkRows: any[] = await pool.query(`
      select child.relname as child, parent.relname as parent,
             (select att.attname from pg_attribute att
               where att.attrelid = c.conrelid and att.attnum = (c.conkey)[1]) as col,
             coalesce(array_length(c.conkey, 1), 0) as ncol
      from pg_constraint c
      join pg_class child on child.oid = c.conrelid
      join pg_class parent on parent.oid = c.confrelid
      join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'public'`);

    const known = new Set(tenantTables);
    // 家生子：自己没有 tenant_id，但有外键指向带 tenant_id 的表 → 按父表归属删/导
    const childTables = fkRows
      .filter((r) => r.ncol === 1 && !known.has(r.child) && known.has(r.parent) && !NEVER_TOUCHED.includes(r.child))
      .map((r) => ({ table: r.child as string, parent: r.parent as string, column: r.col as string }));
    const seen = new Set<string>();
    const children = childTables.filter((c) => (seen.has(c.table) ? false : (seen.add(c.table), true)));
    const multi = fkRows.filter((r) => r.ncol > 1).map((r) => `${r.child}(${r.ncol} 列)`);
    if (multi.length) this.logger.warn(`[plan] 跳过复合外键的家生子（只支持单列 FK）：${multi.join('、')}`);

    const plan: TablePlan = {
      tenantTables,
      childTables: children,
      edges: fkRows.map((r) => ({ child: r.child, parent: r.parent })),
    };
    this.planCache.set(key, plan);
    this.logger.log(`租户数据表清单[${key}]：${tenantTables.length} 张带 tenant_id + ${children.length} 张家生子（${children.map((c) => c.table).join('、') || '无'}）`);
    return plan;
  }

  private async mustTenant(em: EntityManager, id: number, dbLabel = ''): Promise<TenantRow> {
    const rows: any[] = await em.query('select id, code, name, canceled_at from public.tenants where id = $1', [id]);
    if (!rows.length) {
      throw new NotFoundException(dbLabel
        ? `租户 ${id} 不存在于 ${dbLabel}（数据未迁移？检查 tenants.data_source_key 与目标库内容）`
        : '租户不存在');
    }
    return { id: Number(rows[0].id), code: rows[0].code, name: rows[0].name, canceledAt: rows[0].canceled_at ?? null };
  }

  /** D12 保留期看板：已退订租户 + 还剩几天 + 是否进入 7 天提醒窗口 */
  async retention(now = new Date()) {
    // 平台级跨租户查询：目录库走主连接（owner 或 BYPASSRLS 角色），不能带 app.tenant_id。
    // 计数按租户所属库分开取：独立库的 users/templates 不在共享库里，统一查主库会一律显示 0。
    const rows: any[] = await this.poolFor('default').query(`
      select t.id, t.code, t.name, t.canceled_at, t.data_source_key
      from public.tenants t where t.canceled_at is not null order by t.canceled_at asc`);
    const items = await Promise.all(rows.map(async (r) => {
      const ret = retentionOf(r.canceled_at, now);
      const key = (r.data_source_key as string) || 'default';
      let users: number | null = null;
      let templates: number | null = null;
      let countsAvailable = true;
      try {
        const c: any[] = await this.poolFor(key).query(
          `select (select count(*) from public.users u where u.tenant_id = $1)::int as users,
                  (select count(*) from public.templates tp where tp.tenant_id = $1)::int as templates`, [r.id]);
        users = Number(c[0]?.users ?? 0);
        templates = Number(c[0]?.templates ?? 0);
      } catch {
        countsAvailable = false;        // 库连不上不要拖垮整块看板，明确标出来
      }
      return {
        tenantId: Number(r.id), code: r.code, name: r.name, canceledAt: r.canceled_at,
        hardDeleteAt: ret.hardDeleteAt, daysLeft: ret.daysLeft, due: ret.due, warn: ret.warn,
        users, templates, countsAvailable, dataSourceKey: key,
      };
    }));
    return { retentionDays: RETENTION_DAYS, items };
  }

  /**
   * 全量导出某租户数据 → gzip JSON 落 tenant_backups(kind='export')。
   * 返回摘要（不含数据本体），下载走 /exports/:backupId/download。
   */
  async exportTenant(tenantId: number, actor: { id: number; username?: string }) {
    // 先读目录库确定库归属：独立库租户的整段导出都必须跑在它自己的库上，
    // 否则会把共享库里「同名 tenant_id」的空表当成客户数据导出去，还显示成功。
    const key = await this.routingKey(tenantId);
    const { result, rlsActive } = await this.tdsm.withTenantScope(tenantId, async ({ em, rlsActive: on }) => {
      const tenant = await this.mustTenant(em, tenantId, key === 'default' ? '' : `独立库 "${key}"`);
      const p = await this.plan(key);
      const isolation = key === 'default' ? (on ? 'rls' : 'app-only') : 'dedicated-db';
      const tables: Record<string, any[]> = {};
      const truncated: string[] = [];
      let rows = 0;

      tables['tenants'] = await em.query('select * from public.tenants where id = $1', [tenantId]);
      for (const t of p.tenantTables) {
        const data: any[] = await em.query(`select * from public.${t} where tenant_id = $1 limit ${EXPORT_ROW_CAP + 1}`, [tenantId]);
        if (data.length > EXPORT_ROW_CAP) { truncated.push(t); tables[t] = data.slice(0, EXPORT_ROW_CAP); }
        else tables[t] = data;
        rows += data.length;
      }
      for (const c of p.childTables) {
        const data: any[] = await em.query(
          `select ci.* from public.${c.table} ci join public.${c.parent} pa on pa.id = ci.${c.column} where pa.tenant_id = $1 limit ${EXPORT_ROW_CAP + 1}`,
          [tenantId],
        );
        if (data.length > EXPORT_ROW_CAP) { truncated.push(c.table); tables[c.table] = data.slice(0, EXPORT_ROW_CAP); }
        else tables[c.table] = data;
        rows += data.length;
      }

      const gz = gzipSync(Buffer.from(JSON.stringify({
        schemaVersion: 2, kind: 'export', tenantId, tenantCode: tenant.code, tenantName: tenant.name,
        exportedAt: new Date().toISOString(), dataSourceKey: key, isolation, rlsActive: on, tables,
      }), 'utf-8'));
      const name = backupName(tenant.code, 'export');
      const rec: any[] = await em.query(
        `insert into public.tenant_backups(tenant_id, name, storage_key, size_bytes, kind, created_by, data)
         values ($1, $2, $3, $4, 'export', $5, $6) returning id, created_at`,
        [tenantId, name, `export/${tenant.code}/${Date.now()}.json.gz`, gz.length, actor.id ?? null, gz],
      );
      return {
        tenantId, tenantCode: tenant.code, backupId: Number(rec[0].id), name,
        createdAt: rec[0].created_at, sizeBytes: gz.length,
        tableCount: Object.keys(tables).length, rowCount: rows, truncated,
        dataSourceKey: key, isolation, rlsActive: on,
      };
    }, this.scopeOpts(key));
    await this.audit.write(actor, 'platform.tenant.export',
      { tenantId, backupId: result.backupId, sizeBytes: result.sizeBytes, rowCount: result.rowCount, dataSourceKey: key, rlsActive },
      'tenant', tenantId);
    return result;
  }

  /** 导出件列表（平台侧看得全，包含租户自己手工备份的；在租户自己的库里查） */
  async listBackups(tenantId: number) {
    const key = await this.routingKey(tenantId);
    const rows: any[] = await this.poolFor(key).query(
      `select id, name, kind, size_bytes, storage_key, created_by, created_at
       from public.tenant_backups where tenant_id = $1 order by id desc limit 100`, [tenantId]);
    return { tenantId, dataSourceKey: key, items: rows.map((r) => ({
      id: Number(r.id), name: r.name, kind: r.kind, sizeBytes: r.size_bytes,
      storageKey: r.storage_key, createdBy: r.created_by, createdAt: r.created_at,
    })) };
  }

  /** 下载导出件：返回 gzip 原文件（验收/运营用 gunzip 解）。同时留一条下载审计 */
  async downloadBackup(tenantId: number, backupId: number, actor: { id: number; username?: string }) {
    const key = await this.routingKey(tenantId);
    const rows: any[] = await this.poolFor(key).query(
      `select name, kind, size_bytes, data from public.tenant_backups where id = $1 and tenant_id = $2`, [backupId, tenantId]);
    if (!rows.length) throw new NotFoundException('导出件不存在');
    const raw = rows[0].data;
    let buffer: Buffer;
    if (Buffer.isBuffer(raw)) buffer = raw;
    else if (raw instanceof Uint8Array) buffer = Buffer.from(raw);
    else buffer = Buffer.from(String(raw), 'base64');
    if (!buffer.length) throw new BadRequestException('导出件数据为空（可能是历史手工备份未落 data）');
    await this.audit.write(actor, 'platform.tenant.export.download',
      { tenantId, backupId, name: rows[0].name, kind: rows[0].kind, dataSourceKey: key }, 'tenant', tenantId);
    return { filename: `${rows[0].name}.json.gz`, buffer, sizeBytes: Number(rows[0].size_bytes ?? buffer.length) };
  }

  /**
   * 硬删租户全部业务数据（D12）。
   * 顺序：闸门 → 自动落 purge-pre 快照 → 家生子先删 → 按外键拓扑删主表 → 逐表复查剩余。
   */
  async purgeTenant(tenantId: number, actor: { id: number; username?: string }, body: { confirm?: string; force?: boolean } = {}) {
    const key = await this.routingKey(tenantId);
    const { result } = await this.tdsm.withTenantScope(tenantId, async ({ em, rlsActive: on }) => {
      const tenant = await this.mustTenant(em, tenantId, key === 'default' ? '' : `独立库 "${key}"`);
      const gate = assertPurgeAllowed({ code: tenant.code, canceledAt: tenant.canceledAt, confirm: body.confirm, force: !!body.force });
      if (!gate.ok) throw new BadRequestException(gate.reason);

      const p = await this.plan(key);
      // 1. 删之前自动落一份 purge-pre 快照（同一事务，复用带 GUC 的连接）
      const snapshot = await this.exportTenantInternal(em, tenant, p, actor, 'purge-pre', on);

      // 2. 删除范围 = 主表（去掉快照表本身）+ 家生子；家生子一定排在前面
      const mains = filterTables(p.tenantTables, KEEP_ON_PURGE);
      const kids = p.childTables.map((c) => c.table);
      const { ordered, cyclic } = deleteOrder([...kids, ...mains], p.edges);
      const deleted: { table: string; rows: number }[] = [];
      const remaining: string[] = [];

      for (const table of ordered) {
        const kid = p.childTables.find((c) => c.table === table);
        // 家生子自己没有 tenant_id：靠父表把范围钉死（不依赖 RLS 也安全）
        const scope = kid
          ? `from public.${table} ci join public.${kid.parent} pa on pa.id = ci.${kid.column} where pa.tenant_id = $1`
          : `from public.${table} where tenant_id = $1`;
        const count = async () => Number((await em.query(`select count(*)::bigint c ${scope}`, [tenantId]))[0]?.c ?? 0);
        const before = await count();
        if (kid) await em.query(`delete from public.${table} using public.${kid.parent} pa where pa.id = public.${table}.${kid.column} and pa.tenant_id = $1`, [tenantId]);
        else await em.query(`delete from public.${table} where tenant_id = $1`, [tenantId]);
        const after = await count();
        deleted.push({ table, rows: before });
        if (after !== 0) remaining.push(table);
      }
      if (cyclic.length) this.logger.warn(`[purge] 租户 ${tenantId} 存在外键环，按原顺序删除：${cyclic.join('、')}`);
      return {
        tenantId, tenantCode: tenant.code, dataSourceKey: key,
        isolation: key === 'default' ? (on ? 'rls' : 'app-only') : 'dedicated-db',
        rlsActive: on,
        snapshot, deletedRows: deleted.reduce((s, d) => s + d.rows, 0),
        tables: deleted.length, detail: deleted, remaining, cyclic,
      };
    }, this.scopeOpts(key));
    await this.audit.write(actor, 'platform.tenant.purge',
      { tenantId, tenantCode: result.tenantCode, deletedRows: result.deletedRows, snapshot: result.snapshot?.backupId, dataSourceKey: key, rlsActive: result.rlsActive, force: !!body.force },
      'tenant', tenantId);
    return result;
  }

  /** purge 内部复用：同一事务里落快照，避免再开一条连接（RLS 事务级 GUC 不跨连接） */
  private async exportTenantInternal(
    em: EntityManager, tenant: TenantRow, p: TablePlan,
    actor: { id: number; username?: string }, kind: 'export' | 'purge-pre', rlsActive: boolean,
  ) {
    const tables: Record<string, any[]> = {};
    tables['tenants'] = await em.query('select * from public.tenants where id = $1', [tenant.id]);
    for (const t of p.tenantTables) {
      tables[t] = await em.query(`select * from public.${t} where tenant_id = $1 limit ${EXPORT_ROW_CAP + 1}`, [tenant.id]);
    }
    for (const c of p.childTables) {
      tables[c.table] = await em.query(
        `select ci.* from public.${c.table} ci join public.${c.parent} pa on pa.id = ci.${c.column} where pa.tenant_id = $1 limit ${EXPORT_ROW_CAP + 1}`,
        [tenant.id],
      );
    }
    const gz = gzipSync(Buffer.from(JSON.stringify({
      schemaVersion: 2, kind, tenantId: tenant.id, tenantCode: tenant.code,
      exportedAt: new Date().toISOString(), rlsActive, tables,
    }), 'utf-8'));
    const name = backupName(tenant.code, kind);
    const rec: any[] = await em.query(
      `insert into public.tenant_backups(tenant_id, name, storage_key, size_bytes, kind, created_by, data)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [tenant.id, name, `${kind}/${tenant.code}/${Date.now()}.json.gz`, gz.length, kind, actor.id ?? null, gz],
    );
    return { backupId: Number(rec[0].id), name, sizeBytes: gz.length, tableCount: Object.keys(tables).length };
  }
}
