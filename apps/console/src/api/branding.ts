// =============================================================================
// 白标（D6）前端接口：公开品牌解析 + 租户侧品牌/域名管理
//
// ⚠️ 公开解析（apiPublicBranding）**故意不走 http 实例**，用裸 axios：
//    1) 它在登录页就会被调用，那时没有 token，401/网络错都不该弹 toast 吓用户；
//    2) 后端老版本没有 /branding 路由时会 404，白标是增强项，必须静默降级成默认品牌。
//    管理接口照常走 http（有信封拆包与统一报错）。
// =============================================================================
import axios from 'axios';
import http from './index';

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

export interface BrandingResolveResult {
  matched: boolean;
  host: string;
  branding: PublicBranding | null;
}

export interface TenantDomainRow {
  id: number;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  isPrimary: boolean;
  verifyToken: string | null;
  verifyRecordName: string | null;
}

export interface MyBranding {
  tenantId: number;
  tenantCode: string;
  tenantName: string;
  branding: Record<string, string>;
  cssVars: Record<string, string>;
  domains: TenantDomainRow[];
}

export interface BrandingForm {
  appName?: string;
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor?: string;
  backgroundColor?: string;
  loginNotice?: string;
  customCssVars?: string;
}

/** 按当前 Host 解析品牌（静默，失败返回 null） */
export async function apiPublicBranding(domain?: string): Promise<BrandingResolveResult | null> {
  try {
    const res = await axios.get('/api/v1/branding', {
      params: domain ? { domain } : {},
      timeout: 8_000,
    });
    const body: any = res?.data;
    // 裸 axios 不经过信封拆包，这里自己拆一次
    const data = body && typeof body === 'object' && 'code' in body ? body.data : body;
    return (data ?? null) as BrandingResolveResult | null;
  } catch {
    return null;
  }
}

export const apiMyBranding = (): Promise<MyBranding> => http.get('/branding/me');
export const apiSaveBranding = (data: BrandingForm) => http.put('/branding/me', data);
export const apiListDomains = (): Promise<TenantDomainRow[]> => http.get('/branding/domains');
export const apiAddDomain = (domain: string) => http.post('/branding/domains', { domain });
export const apiVerifyDomain = (id: number) => http.post(`/branding/domains/${id}/verify`);
export const apiSetPrimaryDomain = (id: number) => http.put(`/branding/domains/${id}/primary`);
export const apiDeleteDomain = (id: number) => http.delete(`/branding/domains/${id}`);
