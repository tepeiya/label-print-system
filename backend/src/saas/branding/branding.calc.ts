// 白标（D6）可测逻辑：全部纯函数，**不 import TypeORM 实体**（单测跑在 `node --test` + tsx，
// 没有装饰器元数据，import 实体必炸，见 docs/10 §10.15.6 的 ⚠️ 条）。
// 服务层只做取数与写库，判定与清洗全在这里。

/** Host 头里允许的域名最大长度（与 tenant_domains.domain VARCHAR(200) 对齐） */
export const MAX_DOMAIN_LEN = 200;
/** 单租户自定义域名上限：白标是增值能力，但不能被用来囤域名 */
export const MAX_DOMAINS_PER_TENANT = 10;
/** 品牌 JSON 序列化后的字节上限（jsonb 里存 base64 logo 会把库撑爆，超限直接拒） */
export const MAX_BRANDING_BYTES = 8 * 1024;
/** DNS TXT 校验记录前缀（写进客户接入文档的就是这个） */
export const VERIFY_TXT_PREFIX = '_labelflow-verify.';

/** 品牌字段白名单：只有这些键会被写进 tenants.branding，其余一律丢弃 */
export const BRANDING_KEYS = [
  'appName', 'logoUrl', 'faviconUrl', 'primaryColor', 'backgroundColor',
  'loginNotice', 'customCssVars',
] as const;
export type BrandingKey = (typeof BRANDING_KEYS)[number];

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** http(s) 绝对地址；顺手挡掉 javascript: / data: —— logo 是 <img src>，但留着口子早晚出事 */
const URL_RE = /^https:\/\/[a-z0-9.-]{1,200}(?::\d{2,5})?(?:\/[^\s]{0,180})?$/i;
const CSS_VAR_RE = /^--[a-z][a-z0-9-]{0,30}$/;

/**
 * 规范化 Host：去端口、转小写、去尾部点（FQDN 写法 `a.com.` 与 `a.com` 必须等价，
 * 否则唯一约束形同虚设，两条记录能指向同一个域名）。
 * 非法输入返回 ''，调用方据此判「解析不出来」。
 */
export function normalizeHost(input: string | undefined | null): string {
  if (!input) return '';
  let h = String(input).trim().toLowerCase();
  if (!h) return '';
  // IPv6 形式 [::1]:3200 —— 括号内不是租户域名，直接当非法
  if (h.startsWith('[')) return '';
  const colon = h.indexOf(':');
  if (colon > 0) h = h.slice(0, colon);
  h = h.replace(/\.+$/, '');
  return h.length > 0 && h.length <= MAX_DOMAIN_LEN && /^[a-z0-9]([a-z0-9.-]{0,198}[a-z0-9])?$/.test(h) ? h : '';
}

/** 是否像「租户自己的域名」：localhost / 裸 IP / 单标签主机名一律不许登记为自定义域名 */
export function isRegistrableDomain(host: string): { ok: boolean; reason?: string } {
  if (!host) return { ok: false, reason: '域名格式不正确' };
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'localhost 不能作为自定义域名' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ok: false, reason: '不能直接用 IP 作为自定义域名' };
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return { ok: false, reason: '请填写完整域名（至少一个点）' };
  if (host.includes('..')) return { ok: false, reason: '域名格式不正确' };
  if (/\s/.test(host)) return { ok: false, reason: '域名不能含空格' };
  return { ok: true };
}

/** 校验记录名：`_labelflow-verify.customer.com` */
export function verifyRecordName(domain: string): string {
  return `${VERIFY_TXT_PREFIX}${domain}`;
}

/**
 * DNS TXT 是否命中令牌。
 * 一条 TXT 可能被拆成多个字符串片段（RFC 1035 的 char-string 分段），
 * 所以每一段都要单独比，也要比 join 后的整串——两种写法都合法，只比一种会误判失败。
 */
export function matchVerifyToken(v: string[][], domain: string, token: string): boolean {
  const want = `labelflow-verify=${token}`;
  const name = verifyRecordName(domain);
  for (const record of v || []) {
    const parts = (record || []).map((s) => String(s).trim());
    const candidates = [...parts, parts.join('')];
    for (const c of candidates) {
      if (c === want || c === token || c === name || c === `${name}=${token}`) return true;
    }
  }
  return false;
}

export interface BrandingSanitizeResult {
  branding: Record<string, string>;
  dropped: string[];      // 被丢掉的键（前端要如实提示，不要静默吞）
  errors: string[];       // 硬错误（颜色格式、超长）→ 控制器据此报 400
}

/**
 * 清洗品牌配置：只保留白名单键 + 逐键校验取值。
 * 关键约束：**任何情况下都不接受自由 CSS**（customCssVars 只能是 `--x-y` 形式的变量名，
 * 值仍走颜色/URL 校验），否则一个租户的管理员可以用 `body{position:fixed}` 覆盖别的界面，
 * 也给了我们一个 XSS 面（前端注入 <style>）。
 */
export function sanitizeBranding(input: any): BrandingSanitizeResult {
  const src = input && typeof input === 'object' ? input : {};
  const branding: Record<string, string> = {};
  const dropped: string[] = [];
  const errors: string[] = [];

  for (const key of Object.keys(src)) {
    if (!(BRANDING_KEYS as readonly string[]).includes(key)) { dropped.push(key); continue; }
    const raw = src[key];
    if (raw === null || raw === undefined || raw === '') continue;   // 显式清空 = 不写这个键
    if (typeof raw !== 'string') { errors.push(`${key} 必须是字符串`); continue; }

    if (key === 'primaryColor' || key === 'backgroundColor') {
      if (!COLOR_RE.test(raw)) { errors.push(`${key} 必须是 #RGB 或 #RRGGBB`); continue; }
      branding[key] = raw.toLowerCase();
    } else if (key === 'logoUrl' || key === 'faviconUrl') {
      if (!URL_RE.test(raw)) { errors.push(`${key} 必须是 https 绝对地址（不支持 data:/base64/内联脚本）`); continue; }
      branding[key] = raw;
    } else if (key === 'customCssVars') {
      const bad = parseCssVars(raw, errors);
      if (bad) continue;
      branding[key] = raw;
    } else {
      // appName / loginNotice：纯文本，限长 + 去尖括号，前端一律用文本节点渲染
      const text = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 200);
      if (!text) { errors.push(`${key} 不能为空`); continue; }
      branding[key] = text;
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(branding), 'utf-8');
  if (bytes > MAX_BRANDING_BYTES) errors.push(`品牌配置过大（${bytes} > ${MAX_BRANDING_BYTES} 字节）`);
  return { branding, dropped, errors };
}

/**
 * customCssVars 形态：`--a: v; --b: v`。只允许 `--小写名`，值里不许出现 `}` `<` `"` `\\` `url(`。
 * 返回 true 表示有错（错误已推进 errors）。
 */
export function parseCssVars(input: string, errors: string[]): boolean {
  const segs = input.split(';').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) { errors.push('customCssVars 不能为空'); return true; }
  for (const s of segs) {
    const idx = s.indexOf(':');
    if (idx <= 0) { errors.push(`customCssVars 写法应为 --变量: 值（坏在「${s.slice(0, 24)}」）`); return true; }
    const name = s.slice(0, idx).trim();
    const val = s.slice(idx + 1).trim();
    if (!CSS_VAR_RE.test(name)) { errors.push(`customCssVars 只接受 --小写变量名（坏在「${name.slice(0, 32)}」）`); return true; }
    if (!val || /[}"'\\]|url\(/i.test(val)) { errors.push(`customCssVars 的值「${name}」不合法`); return true; }
  }
  return false;
}

/** 把 CSS 变量串摊成 { '--x': 'v' }，前端 style 直接吃这个形状 */
export function cssVarsToObject(input?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const s of String(input).split(';')) {
    const seg = s.trim();
    if (!seg) continue;
    const idx = seg.indexOf(':');
    if (idx <= 0) continue;
    const name = seg.slice(0, idx).trim();
    const val = seg.slice(idx + 1).trim();
    if (CSS_VAR_RE.test(name) && val && !/[}"'\\]|url\(/i.test(val)) out[name] = val;
  }
  return out;
}

export interface DomainRowLite {
  tenantId: number;
  domain: string;
  verified: boolean;
}

/**
 * Host → 租户解析。只认**已校验**的域名（精确匹配规范化后的 host），
 * 未校验的一律忽略——这是抢注防护的唯一屏障，别在这里放宽。
 * 返回 null 表示「按默认租户/按用户手输 tenantCode 走」。
 */
export function resolveTenantByHost(rows: DomainRowLite[], host: string | undefined | null): number | null {
  const h = normalizeHost(host);
  if (!h) return null;
  const hit = (rows || []).find((r) => r.verified && normalizeHost(r.domain) === h);
  return hit ? Number(hit.tenantId) : null;
}

/** 验证码去噪：只留 base32 可读字符，长度 32 */
export function makeTokenLike(seed: string): string {
  return seed.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 32);
}

/**
 * 从请求头取「对外域名」。trustForwarded 由调用方传（env BRANDING_TRUST_FORWARDED_HOST），
 * 默认只看 Host —— 反代场景下如果不显式信任 X-Forwarded-Host，用户伪造头就能把品牌切到别家，
 * 宁可白标不生效也不能认错租户。
 */
export function hostFromHeaders(
  headers: Record<string, any> | undefined | null,
  trustForwarded = false,
): string {
  if (trustForwarded) {
    const xf = headers?.['x-forwarded-host'];
    const first = Array.isArray(xf) ? xf[0] : xf;
    if (first) return normalizeHost(String(first).split(',')[0].trim());
  }
  return normalizeHost((headers?.host as string) || '');
}
