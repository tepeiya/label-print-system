// =============================================================================
// BrandingController —— 白标（D6）：公开品牌解析 + 租户侧品牌/域名管理
//
// 路由分组（同一控制器里混着 @Public 与需鉴权的路由，靠 handler 级装饰器区分）：
//   GET   /branding                 @Public  按 Host（或 ?domain=）解析已校验域名 → 品牌
//   GET   /branding/me              租户侧   当前租户品牌 + 域名列表（要 sys:branding:manage）
//   PUT   /branding/me              租户侧   写品牌（清洗后落库，白名单外键丢弃并回报）
//   GET   /branding/domains         租户侧
//   POST  /branding/domains         租户侧   登记 → 返回 TXT 校验令牌
//   POST  /branding/domains/:id/verify  租户侧 查 DNS TXT 比对令牌
//   PUT   /branding/domains/:id/primary 租户侧
//   DELETE /branding/domains/:id    租户侧
//
// ⚠️ 解析口径：默认取 `Host` 头；**只有显式设了 BRANDING_TRUST_FORWARDED_HOST=1 才认
//    X-Forwarded-Host**。反代后面如果不设这个环境变量，拿到的会是上游内部 Host，白标不生效
//    （不生效比认错租户安全）。`?domain=` 只用于平台预览，同样只认已校验域名。
// =============================================================================
import {
  BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Request, UseGuards,
} from '@nestjs/common';
import { Public } from '../../common/public.decorator';
import { TenantGuard } from '../../common/tenant.guard';
import { RequirePermission } from '../../common/permission.guard';
import { useTenantId } from '../../common/tenant.context';
import { BrandingService } from './branding.service';
import { hostFromHeaders, normalizeHost } from './branding.calc';
import { AuditService } from '../../audit/audit.module';

const TRUST_FORWARDED = process.env.BRANDING_TRUST_FORWARDED_HOST === '1';
function requestHost(req: any): string {
  return hostFromHeaders(req?.headers, TRUST_FORWARDED);
}

@Controller('branding')
@UseGuards(TenantGuard)
export class BrandingController {
  constructor(private svc: BrandingService, private audit: AuditService) {}

  /** 登录页/外壳用：命中已校验域名就回品牌，没命中回 { matched:false }（不 404，前端要能静默兜底） */
  @Public()
  @Get()
  async resolve(@Request() req: any, @Query('domain') domain?: string) {
    const host = domain ? normalizeHost(domain) : requestHost(req);
    const branding = await this.svc.publicBrandingByHost(host);
    return { matched: !!branding, host, branding };
  }

  // ------------------------------------------------------------ 租户侧配置

  @Get('me')
  @RequirePermission('sys:branding:manage')
  me() {
    return this.svc.getBranding(useTenantId());
  }

  @Put('me')
  @RequirePermission('sys:branding:manage')
  async setMe(@Request() req: any, @Body() body: any) {
    const tenantId = useTenantId();
    const out = await this.svc.setBranding(tenantId, body ?? {}, req.user);
    await this.audit.write(tenantId, 'branding.update', { keys: Object.keys(out.branding), dropped: out.dropped }, req.user?.sub);
    return out;
  }

  @Get('domains')
  @RequirePermission('sys:branding:manage')
  listDomains() {
    return this.svc.listDomains(useTenantId());
  }

  @Post('domains')
  @RequirePermission('sys:branding:manage')
  async addDomain(@Request() req: any, @Body() body: { domain?: string }) {
    const tenantId = useTenantId();
    const out = await this.svc.addDomain(tenantId, String(body?.domain ?? ''), req.user?.sub);
    await this.audit.write(tenantId, 'branding.domain.add', { domain: out.domain }, req.user?.sub, 'tenant_domain', out.id);
    return out;
  }

  @Post('domains/:id/verify')
  @RequirePermission('sys:branding:manage')
  async verifyDomain(@Request() req: any, @Param('id') id: string) {
    if (!/^\d+$/.test(String(id))) throw new BadRequestException('domain id 必须是数字');
    const tenantId = useTenantId();
    const out = await this.svc.verifyDomain(tenantId, Number(id));
    await this.audit.write(tenantId, 'branding.domain.verify', out, req.user?.sub, 'tenant_domain', out.id);
    return out;
  }

  @Put('domains/:id/primary')
  @RequirePermission('sys:branding:manage')
  async setPrimary(@Param('id') id: string) {
    if (!/^\d+$/.test(String(id))) throw new BadRequestException('domain id 必须是数字');
    return this.svc.setPrimaryDomain(useTenantId(), Number(id));
  }

  @Delete('domains/:id')
  @RequirePermission('sys:branding:manage')
  async removeDomain(@Request() req: any, @Param('id') id: string) {
    if (!/^\d+$/.test(String(id))) throw new BadRequestException('domain id 必须是数字');
    const tenantId = useTenantId();
    const out = await this.svc.removeDomain(tenantId, Number(id));
    await this.audit.write(tenantId, 'branding.domain.remove', out, req.user?.sub, 'tenant_domain', out.id);
    return out;
  }
}
