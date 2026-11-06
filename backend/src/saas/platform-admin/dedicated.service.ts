// =============================================================================
// 独立库数据源（D2）平台侧管理：注册 / 诊断 / 注销
//
// 边界（有意为之，不是没做完）：
//   · 这里只负责「哪一个 dataSourceKey 连到哪个库」，以及能不能连、结构对不对；
//   · 业务读写仓库仍绑默认 DataSource，所以 **不做开通 / 不考虑接管 API**（见 provision 对
//     type='dedicated' 的 400）。只把平台侧的导出/删除/保留期打通到独立库。
//   · DSN 只在进程内存：返回值、审计、日志一律用 maskDsn() 的脱敏形式，密码不落库不出进程。
//
// 安全：平台 JWT（PlatformJwtGuard）已由 controller 把关，这里的每个写动作都留平台审计。
// =============================================================================
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantDataSourceManager } from '../../common/tenant-data-source.manager';
import { PlatformAuditService } from './platform-audit.service';
import { dsnTarget, isPostgresUrl, maskDsn, validateKey } from './dedicated.calc';

interface KeyRef { key: string; count: number; codes: string[] }

@Injectable()
export class DedicatedDataSourceService {
  constructor(private readonly tdsm: TenantDataSourceManager, private readonly audit: PlatformAuditService) {}

  /**
   * 诊断面板：已注册的库（脱敏）+ env 解析错误 + **被租户引用但没注册**的 key。
   * 最后一类是最容易让运营困惑的现场（租户查询 503，后台却看不出原因），必须显式列出来。
   */
  async status() {
    const pool = this.tdsm.get({ dataSourceKey: 'default' });
    const rows: any[] = await pool.query(
      `select data_source_key as k, count(*)::int as n, array_agg(code order by code) as codes
       from public.tenants where data_source_key is not null group by data_source_key order by 1`,
    );
    const refs: KeyRef[] = rows.map((r) => ({ key: String(r.k), count: Number(r.n), codes: (r.codes ?? []).map(String) }));
    const byKey = new Map(refs.map((r) => [r.key, r]));
    const registered = this.tdsm.describeDedicated();

    return {
      rlsEnabled: this.tdsm.rlsEnabled,
      envErrors: this.tdsm.envRegisterErrors(),
      items: registered.map((d) => ({
        ...d,
        tenantsUsing: byKey.get(d.key)?.count ?? 0,
        tenantCodes: byKey.get(d.key)?.codes ?? [],
      })),
      /** 租户表里写着、但本进程没有可用连接池的 key */
      missing: refs
        .filter((r) => !registered.some((d) => d.key === r.key))
        .map((r) => ({ ...r, hint: '配 DB_DEDICATED_DSNS 或调 POST /platform/datasources 注册' })),
    };
  }

  /** 注册/更新一个独立库：连得上 + 结构自检通过才落进注册表（否则 503，不静默） */
  async register(key: string, url: string, actor: { id: number; username?: string }) {
    const k = String(key ?? '').trim();
    const u = String(url ?? '').trim();
    const chk = validateKey(k);
    if (!chk.ok) throw new BadRequestException(chk.reason);
    if (!isPostgresUrl(u)) throw new BadRequestException('DSN 必须是 postgres:// 或 postgresql:// 连接串');
    const target = dsnTarget(u);
    if (!target) throw new BadRequestException('DSN 解析不出目标库（检查是否带了库名）');

    let info;
    try {
      info = await this.tdsm.registerFromUrl(k, u, 'api');
    } catch (e: any) {
      if (e?.status) throw e;                       // ServiceUnavailable：连接失败，原样透出
      throw new BadRequestException(`独立库不可用：${e?.message ?? e}`);
    }

    const masked = maskDsn(u);
    await this.audit.write(actor, 'platform.datasource.register',
      { key: k, target, maskedDsn: masked, source: info.source }, 'data_source');
    return { ...info, maskedDsn: masked };
  }

  /**
   * 注销：**有租户在用就拒绝**——否则这些租户会立刻 503，而且运营看不出是「刚被人注销了」。
   * 先把租户迁走（改 data_source_key）再注销。
   */
  async unregister(key: string, actor: { id: number; username?: string }) {
    const k = String(key ?? '').trim();
    const chk = validateKey(k);
    if (!chk.ok) throw new BadRequestException(chk.reason);

    const pool = this.tdsm.get({ dataSourceKey: 'default' });
    const used: any[] = await pool.query(
      `select id, code from public.tenants where data_source_key = $1 order by id`, [k],
    );
    if (used.length) {
      throw new BadRequestException(
        `数据源 "${k}" 仍被 ${used.length} 家租户使用（${used.map((r) => r.code).join('、')}），` +
        '请先迁移这些租户的 data_source_key 再注销',
      );
    }

    const info = this.tdsm.describeDedicated().find((d) => d.key === k);
    if (!info) throw new NotFoundException(`数据源 "${k}" 未注册`);

    await this.tdsm.unregisterDedicated(k);
    await this.audit.write(actor, 'platform.datasource.unregister',
      { key: k, target: { host: info.host, port: info.port, database: info.database, user: info.user }, source: info.source },
      'data_source');
    return { key: k, removed: true, source: info.source };
  }
}
