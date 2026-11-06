// =============================================================================
// BrandingService —— 白标（D6）：品牌主题 + 自定义域名校验 + Host→租户解析
//
// 三条硬规矩（改动前请先读完）：
//  1. **未 verified 的域名绝不参与解析**。域名唯一约束意味着「先登记就是抢注」，
//     客户必须在 DNS 上放一条 TXT 记录证明这个域名归他，我们才能把 Host 映射到他的租户。
//  2. **解析结果只用于「显示什么品牌」和「允许省略 tenantCode」，绝不用于鉴权**。
//     登录仍然要 username + password + （显式或由已校验域名推出的）租户；
//     伪造 Host 头能得到的最多是「看到一个租户的 logo 和名字」，拿不到任何数据。
//  3. **品牌值一律白名单清洗**（见 branding.calc.sanitizeBranding），不接受自由 CSS。
//
// 与 RLS 的关系：解析走**默认连接**（今天仍是 owner）。以后主链路切到 labelflow_app 时，
// 这条公开查询必须改走平台角色连接（`labelflow_platform`），否则 fail-closed 策略会让它恒定 0 行、
// 白标解析当场静默失效。切换清单见 docs/10 §10.22.4。
// =============================================================================
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { promises as nodeDns } from 'dns';
import { TenantDomain } from './tenant-domain.entity';
import { Tenant } from '../../entities/tenant.entity';
import {
  MAX_DOMAINS_PER_TENANT, cssVarsToObject, isRegistrableDomain, makeTokenLike, matchVerifyToken,
  normalizeHost, resolveTenantByHost, sanitizeBranding, verifyRecordName,
} from './branding.calc';

/** TXT 解析函数签名：单测里塞假的，真实环境用 node 的 dns.promises */
export type TxtResolver = (name: string) => Promise<string[][]>;

/** 解析缓存：Host → { tenantId, at }。只缓存「命中」与「明确没命中」两种结论，异常不缓存 */
const RESOLVE_TTL_MS = +(process.env.BRANDING_CACHE_MS || 30_000);
const RESOLVE_MAX = 500;

@Injectable()
export class BrandingService {
  private readonly logger = new Logger(BrandingService.name);
  private readonly cache = new Map<string, { tenantId: number | null; branding: PublicBranding | null; at: number }>();
  /** 测试/开发可注入的 TXT 解析器（默认 node dns） */
  txtResolver: TxtResolver = (name) => nodeDns.resolveTxt(name);

  constructor(
    @InjectRepository(TenantDomain) private domains: Repository<TenantDomain>,
    @InjectRepository(Tenant) private tenants: Repository<Tenant>,
  ) {}

  // ---------------------------------------------------------------- 公开解析

  /**
   * 供登录页 / 平台侧用的「按 Host 取品牌」。
   * 返回 null 表示这个 Host 不是任何租户的已校验域名（前端就回默认品牌 + 手输租户码）。
   */
  async publicBrandingByHost(host: string | undefined | null): Promise<PublicBranding | null> {
    const h = normalizeHost(host);
    if (!h) return null;
    const hit = this.cache.get(h);
    if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.branding;
    const rows = await this.domains.find();
    const tenantId = resolveTenantByHost(
      rows.map((r) => ({ tenantId: Number(r.tenantId), domain: r.domain, verified: !!r.verified })),
      h,
    );
    let out: PublicBranding | null = null;
    if (tenantId) {
      const t = await this.tenants.findOne({ where: { id: tenantId } });
      if (t && Number(t.status) === 1) {
        const b = (t.branding || {}) as Record<string, string>;
        out = {
          tenantId: Number(t.id),
          tenantCode: t.code,
          tenantName: t.name,
          matchedDomain: h,
          appName: b.appName || t.name,
          logoUrl: b.logoUrl || null,
          faviconUrl: b.faviconUrl || null,
          primaryColor: b.primaryColor || null,
          backgroundColor: b.backgroundColor || null,
          loginNotice: b.loginNotice || null,
          cssVars: cssVarsToObject(b.customCssVars),
        };
      }
    }
    if (this.cache.size > RESOLVE_MAX) this.cache.clear();
    this.cache.set(h, { tenantId, branding: out, at: Date.now() });
    return out;
  }

  /**
   * 登录时由 Host 推出的租户（auth.service 用）。
   * 返回 null = 走原来的「必须显式传 tenantCode」。
   */
  async tenantIdByHost(host: string | undefined | null): Promise<number | null> {
    const b = await this.publicBrandingByHost(host);
    return b ? b.tenantId : null;
  }

  /** 让下一次 Host 解析重新查库（改品牌/改域名后调用，避免 30s 内还是旧样子） */
  invalidateHostCache(host?: string) {
    if (host) this.cache.delete(normalizeHost(host));
    else this.cache.clear();
  }

  // ---------------------------------------------------------------- 品牌配置

  async getBranding(tenantId: number) {
    const t = await this.mustTenant(tenantId);
    const branding = (t.branding || {}) as Record<string, string>;
    return {
      tenantId: Number(t.id),
      tenantCode: t.code,
      tenantName: t.name,
      branding,
      cssVars: cssVarsToObject(branding.customCssVars),
      domains: await this.listDomains(tenantId),
    };
  }

  /** 全量覆盖式写入（前端每次提交完整表单）；返回清洗后的实际落库值 + 被丢弃的键 */
  async setBranding(tenantId: number, input: any, _actor?: { id?: number; username?: string }) {
    const t = await this.mustTenant(tenantId);
    const { branding, dropped, errors } = sanitizeBranding(input);
    if (errors.length) throw new BadRequestException({ message: errors[0], errors });
    // jsonb 列：TypeORM 的 QueryDeepPartialEntity 不收 Record<string,string>，这里按实体声明的形状交给它
    await this.tenants.update({ id: tenantId }, { branding: branding as any });
    this.invalidateHostCache();
    return { tenantId: Number(t.id), branding, dropped, cleared: Object.keys(branding).length === 0 };
  }

  // ---------------------------------------------------------------- 域名管理

  async listDomains(tenantId: number) {
    const rows = await this.domains.find({ where: { tenantId }, order: { isPrimary: 'DESC', id: 'ASC' } });
    return rows.map((r) => ({
      id: Number(r.id),
      domain: r.domain,
      verified: !!r.verified,
      verifiedAt: r.verifiedAt,
      isPrimary: !!r.isPrimary,
      // 令牌只在校验前暴露给租户管理员自己（他要去 DNS 里填），已校验的不再回显
      verifyToken: r.verified ? null : r.verifyToken,
      verifyRecordName: r.verified ? null : verifyRecordName(r.domain),
    }));
  }

  async addDomain(tenantId: number, rawDomain: string, userId?: number) {
    // normalizeHost 是给**请求头**用的，会顺手剥端口和路径；登记吃的是用户手填的裸域名，
    // 直接复用的话 `acme.com:3200/path` 会被静默规范化成 `acme.com`，用户以为登记的是另一个东西。
    const raw = String(rawDomain ?? '').trim();
    if (/[\/@\s]/.test(raw)) throw new BadRequestException('请填写裸域名（不要带协议、路径、端口或空格）');
    const domain = normalizeHost(raw);
    const chk = isRegistrableDomain(domain);
    if (!chk.ok) throw new BadRequestException(chk.reason || '域名不合法');
    const owned = await this.domains.count({ where: { tenantId } });
    if (owned >= MAX_DOMAINS_PER_TENANT) {
      throw new BadRequestException(`每个租户最多 ${MAX_DOMAINS_PER_TENANT} 个自定义域名`);
    }
    const dup = await this.domains.findOne({ where: { domain } });
    if (dup) {
      // 不给「已被别家占用」的域名生成新令牌，也不透露归属方是谁
      throw new BadRequestException(
        Number(dup.tenantId) === Number(tenantId) ? '该域名已登记' : '该域名已被占用，如属误占请联系平台运营',
      );
    }
    const token = makeTokenLike(randomBytes(24).toString('hex'));
    const row = await this.domains.save(this.domains.create({
      tenantId, domain, verified: false, verifyToken: token,
      isPrimary: owned === 0, createdBy: userId ?? null,
    }));
    this.invalidateHostCache(domain);
    return {
      id: Number(row.id), domain, verified: false, isPrimary: !!row.isPrimary,
      verifyToken: token, verifyRecordName: verifyRecordName(domain),
      instruction: `请在域名 ${domain} 的 DNS 添加 TXT 记录 ${verifyRecordName(domain)} = labelflow-verify=${token}，然后调 verify`,
    };
  }

  /**
   * 校验：查 TXT 比对令牌。
   * ⚠️ dev 逃生口 `BRANDING_DEV_VERIFY=1` 只允许在**非 production** 生效，
   *    否则任何人都能拿别人的域名一键 verified。
   */
  async verifyDomain(tenantId: number, domainId: number) {
    const row = await this.domains.findOne({ where: { id: domainId, tenantId } });
    if (!row) throw new NotFoundException('域名不存在或不属于当前租户');
    if (row.verified) return { id: Number(row.id), domain: row.domain, verified: true, already: true };
    const token = row.verifyToken || makeTokenLike(String(row.id));

    if (process.env.BRANDING_DEV_VERIFY === '1' && process.env.NODE_ENV !== 'production') {
      row.verified = true; row.verifiedAt = new Date(); row.verifyToken = null;
      await this.domains.save(row);
      this.invalidateHostCache(row.domain);
      this.logger.warn(`[dev] 域名 ${row.domain} 由 BRANDING_DEV_VERIFY=1 直接标记已校验（生产不可用）`);
      return { id: Number(row.id), domain: row.domain, verified: true, devBypass: true };
    }

    let records: string[][] = [];
    try {
      records = await this.txtResolver(verifyRecordName(row.domain));
    } catch (e: any) {
      // NXDOMAIN / 无 TXT / 网络不通，对用户是同一句话：还没查到校验记录
      this.logger.debug(`TXT ${verifyRecordName(row.domain)} 查询失败：${e?.code || e?.message}`);
      throw new BadRequestException({
        message: `未查到校验记录 ${verifyRecordName(row.domain)}，请添加 TXT 记录后重试`,
        expected: { record: verifyRecordName(row.domain), value: `labelflow-verify=${token}` },
      });
    }
    if (!matchVerifyToken(records, row.domain, token)) {
      throw new BadRequestException({
        message: '校验记录内容不匹配',
        expected: { record: verifyRecordName(row.domain), value: `labelflow-verify=${token}` },
        got: records,
      });
    }
    row.verified = true; row.verifiedAt = new Date(); row.verifyToken = null;
    await this.domains.save(row);
    this.invalidateHostCache(row.domain);
    return { id: Number(row.id), domain: row.domain, verified: true };
  }

  async removeDomain(tenantId: number, domainId: number) {
    const row = await this.domains.findOne({ where: { id: domainId, tenantId } });
    if (!row) throw new NotFoundException('域名不存在或不属于当前租户');
    // ⚠️ 先取 id：Repository.remove() 之后实体的主键会被清成 undefined，
    //    直接 Number(row.id) 交给审计的 target_id → NaN → PG 报 invalid input syntax for type bigint（实测 500）
    const id = Number(row.id);
    const domain = row.domain;
    await this.domains.remove(row);
    this.invalidateHostCache(domain);
    return { id, domain, removed: true };
  }

  async setPrimaryDomain(tenantId: number, domainId: number) {
    const row = await this.domains.findOne({ where: { id: domainId, tenantId } });
    if (!row) throw new NotFoundException('域名不存在或不属于当前租户');
    if (!row.verified) throw new BadRequestException('只有已校验的域名可以设为主域名');
    await this.domains.update({ tenantId }, { isPrimary: false });
    await this.domains.update({ id: domainId }, { isPrimary: true });
    return { id: Number(row.id), domain: row.domain, isPrimary: true };
  }

  /**
   * 平台运营强制校验（客户搞不定 DNS 时的工单通道，走平台 JWT + 落平台审计）。
   * tenantId 是**必给**的：运营是从某个租户的页面点进来的，这里再核一次归属，
   * 免得拿着别的租户的 domainId 也能调通（路径参数里的 :id 就成了摆设）。
   */
  async forceVerifyByPlatform(tenantId: number, domainId: number) {
    const row = await this.domains.findOne({ where: { id: domainId } });
    if (!row) throw new NotFoundException('域名不存在');
    if (Number(row.tenantId) !== Number(tenantId)) throw new BadRequestException('该域名不属于此租户');
    if (row.verified) return { id: Number(row.id), tenantId, domain: row.domain, verified: true, already: true };
    row.verified = true; row.verifiedAt = new Date(); row.verifyToken = null;
    await this.domains.save(row);
    this.invalidateHostCache(row.domain);
    return { id: Number(row.id), tenantId, domain: row.domain, verified: true, forced: true };
  }

  private async mustTenant(id: number): Promise<Tenant> {
    const t = await this.tenants.findOne({ where: { id } });
    if (!t) throw new NotFoundException('租户不存在');
    return t;
  }
}

export interface PublicBranding {
  tenantId: number;
  tenantCode: string;
  tenantName: string;
  matchedDomain: string;
  appName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  backgroundColor: string | null;
  loginNotice: string | null;
  cssVars: Record<string, string>;
}
