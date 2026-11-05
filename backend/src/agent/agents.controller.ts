// =============================================================================
// AgentsController —— 租户侧 Agent 管理（docs/11 §11.6.1，权限 sys:agent:manage）
// PRO 套餐专属：类上 @RequireModule('agent')；token 明文只在签发响应出现一次。
// =============================================================================
import {
  Body, Controller, Get, Param, Post, Query, Request, UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenantId } from '../common/tenant.context';
import { AgentService } from './agent.service';
import { PermissionsService } from '../saas/permissions.service';
import { AuditService } from '../audit/audit.module';
import {
  CreateAgentClientDto, CreateAgentTokenDto, SetAgentClientStatusDto,
} from './dto/agent.dto';

@Controller('agents')
@UseGuards(TenantGuard)
@RequireModule('agent')
export class AgentsController {
  constructor(
    private agent: AgentService,
    private perms: PermissionsService,
    private audit: AuditService,
  ) {}

  /** Agent 客户端列表 */
  @Get()
  @RequirePermission('sys:agent:manage')
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.agent.listClients(useTenantId(), Number(page) || 1, Math.min(Number(pageSize) || 20, 100));
  }

  /** 新建 Agent（默认 kind=mcp_stdio，状态 active） */
  @Post()
  @RequirePermission('sys:agent:manage')
  async create(@Request() req: any, @Body() dto: CreateAgentClientDto) {
    const tenantId = useTenantId();
    const row = await this.agent.createClient(tenantId, req.user?.sub, dto);
    await this.audit.write(tenantId, 'agent.client.create', { name: dto.name, kind: row.kind }, req.user?.sub, 'agent_client', row.id);
    return row;
  }

  /** 某 Agent 的 Token 列表（脱敏：只回 hash 尾 8 位） */
  @Get(':id/tokens')
  @RequirePermission('sys:agent:manage')
  tokens(@Param('id') id: string) {
    return this.agent.listTokens(useTenantId(), Number(id));
  }

  /**
   * 签发 Token（§11.7.7 护栏 1：scope ⊆ 创建者权限）。
   * ⚠️ 明文 token 只出现在本次响应，服务端仅存 sha256。
   */
  @Post(':id/tokens')
  @RequirePermission('sys:agent:manage')
  async createToken(@Request() req: any, @Param('id') id: string, @Body() dto: CreateAgentTokenDto) {
    const tenantId = useTenantId();
    const roles: string[] = req.user?.roles ?? [];
    const creatorPerms = await this.perms.listByRoles(roles).catch(() => [] as string[]);
    const res = await this.agent.createToken(tenantId, Number(id), dto, roles, creatorPerms);
    await this.audit.write(tenantId, 'agent.token.create', {
      clientId: res.clientId, scopes: res.scopes, tokenMasked: res.tokenMasked, expiresInDays: dto.expiresInDays ?? 90,
    }, req.user?.sub, 'agent_client', res.clientId);
    return res;
  }

  /** 启停 Agent 客户端（停用后其所有 token 立即失效） */
  @Post(':id/status')
  @RequirePermission('sys:agent:manage')
  async setStatus(@Request() req: any, @Param('id') id: string, @Body() dto: SetAgentClientStatusDto) {
    const tenantId = useTenantId();
    const res = await this.agent.setClientStatus(tenantId, Number(id), dto.status);
    await this.audit.write(tenantId, dto.status === 'disabled' ? 'agent.client.disable' : 'agent.client.enable',
      { status: dto.status }, req.user?.sub, 'agent_client', res.id);
    return res;
  }

  /** 撤销单个 Token（立即生效：鉴权处 revoked 检查） */
  @Post(':id/tokens/:tokenId/revoke')
  @RequirePermission('sys:agent:manage')
  async revokeToken(@Request() req: any, @Param('id') id: string, @Param('tokenId') tokenId: string) {
    const tenantId = useTenantId();
    const res = await this.agent.revokeToken(tenantId, Number(tokenId));
    await this.audit.write(tenantId, 'agent.token.revoke', { clientId: Number(id) }, req.user?.sub, 'agent_token', res.id);
    return res;
  }
}
