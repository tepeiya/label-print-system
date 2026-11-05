// =============================================================================
// AgentService —— Agent 客户端/Token 管理与鉴权底坐（docs/11 §11.5.3 / §11.6.1 /agents）
// 安全（§11.7.7）：
//   - 只存 sha256(token)，明文仅在签发响应里出现一次；列表/审计一律脱敏；
//   - scope ⊆ 创建者权限（超管角色跳过，与 PermissionGuard 的 SUPER_ROLES 语义一致）；
//   - 未显式给 scopes 时默认只读集合（护栏 2）。
// =============================================================================
import {
  BadRequestException, Injectable, NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AgentClient, AgentToken } from './agent.entity';
import { Tenant } from '../entities/tenant.entity';
import {
  argsHash, defaultReadScopes, hashAgentToken, isExpired, isValidScope,
  looksLikeAgentToken, maskToken, newAgentToken, scopeCovers,
} from './agent.calc';
import { matchPermission } from '../common/permission-match';

const SUPER_ROLES = ['admin', 'tenant_admin'];
const TOKEN_DEFAULT_TTL_DAYS = 90;

export interface AgentCtx {
  tenantId: number;
  clientId: number;
  clientName: string;
  scopes: string[];
  tokenId: number;
  /**
   * Agent 客户端的创建人（§11.7.6 on_behalf_of）。
   * 写工具在这个身份下执行（模板 createdBy、打印 job createdBy），审计也能追责到人；
   * 老数据 created_by 为空时为 null，写路径会退化成「无归属」并由执行层拒绝。
   */
  onBehalfOf: number | null;
}

export interface TokenAuthRecord {
  status: 'ok' | 'not_found' | 'revoked' | 'expired' | 'client_disabled' | 'tenant_disabled';
  token?: AgentToken;
  client?: AgentClient;
  tenant?: Tenant;
}

@Injectable()
export class AgentService {
  constructor(
    @InjectRepository(AgentClient) private clients: Repository<AgentClient>,
    @InjectRepository(AgentToken) private tokens: Repository<AgentToken>,
    @InjectRepository(Tenant) private tenants: Repository<Tenant>,
  ) {}

  // ------------------------------------------------------------ 鉴权

  /** Guard 专用：明文 token → 完整校验链。任何一环失败都只回状态码，不回原因细节之外的信息 */
  async authenticate(plain: string): Promise<TokenAuthRecord> {
    if (!looksLikeAgentToken(plain)) return { status: 'not_found' };
    const token = await this.tokens.findOne({ where: { tokenHash: hashAgentToken(plain) } });
    if (!token) return { status: 'not_found' };
    if (token.revoked) return { status: 'revoked' };
    if (isExpired(token.expiresAt)) return { status: 'expired' };
    const client = await this.clients.findOne({ where: { id: Number(token.clientId) } });
    if (!client || client.status !== 'active') return { token, status: 'client_disabled' };
    const tenant = await this.tenants.findOne({ where: { id: Number(token.tenantId) } });
    if (!tenant || Number(tenant.status) !== 1) return { token, client, status: 'tenant_disabled' };
    return { status: 'ok', token, client, tenant };
  }

  /** last_used_at 打点（失败忽略，不影响调用） */
  touch(tokenId: number) {
    return this.tokens.update({ id: tokenId }, { lastUsedAt: new Date() }).catch(() => undefined);
  }

  // ------------------------------------------------------------ 管理面（租户侧）

  async listClients(tenantId: number, page = 1, pageSize = 20) {
    const [rows, total] = await this.clients.findAndCount({
      where: { tenantId }, order: { id: 'DESC' },
      skip: (page - 1) * pageSize, take: pageSize,
    });
    // token 数量/末次使用时间批量统计
    const ids = rows.map((r) => Number(r.id));
    const counts = ids.length
      ? await this.tokens.createQueryBuilder('t')
        .select('t.agent_client_id', 'clientId')
        .addSelect('COUNT(*)', 'n')
        .addSelect('MAX(t.last_used_at)', 'lastUsed')
        .where('t.agent_client_id IN (:...ids)', { ids })
        .groupBy('t.agent_client_id').getRawMany()
      : [];
    const byClient = new Map(counts.map((c) => [Number(c.clientId), c]));
    return {
      items: rows.map((c) => ({
        id: Number(c.id), name: c.name, description: c.description, kind: c.kind,
        status: c.status, createdAt: c.createdAt,
        tokenCount: Number(byClient.get(Number(c.id))?.n ?? 0),
        lastUsedAt: byClient.get(Number(c.id))?.lastUsed ?? null,
      })),
      total,
    };
  }

  async createClient(tenantId: number, userId: number, dto: { name: string; description?: string; kind?: string }) {
    const kind = dto.kind ?? 'mcp_stdio';
    if (!['mcp_stdio', 'mcp_http', 'internal'].includes(kind)) {
      throw new BadRequestException('kind 仅支持 mcp_stdio / mcp_http / internal');
    }
    const row = await this.clients.save({
      tenantId, name: String(dto.name).trim(), description: dto.description?.trim() ?? null,
      kind: kind as AgentClient['kind'], status: 'active', createdBy: userId,
    } as Partial<AgentClient>);
    return { id: Number(row.id), name: row.name, kind: row.kind, status: row.status };
  }

  async getClient(tenantId: number, id: number): Promise<AgentClient> {
    const c = await this.clients.findOne({ where: { id, tenantId } });
    if (!c) throw new NotFoundException('Agent 客户端不存在');
    return c;
  }

  async setClientStatus(tenantId: number, id: number, status: 'active' | 'disabled') {
    const c = await this.getClient(tenantId, id);
    await this.clients.update({ id: Number(c.id) }, { status });
    return { id: Number(c.id), status };
  }

  /**
   * 签发 Token。creatorPerms = 创建者角色的权限点集合；
   * 超管跳过「scope ⊆ 创建者权限」校验（与 PermissionGuard 的 SUPER_ROLES 兜底一致）。
   * 明文只在这次响应里出现一次。
   */
  async createToken(
    tenantId: number, clientId: number,
    dto: { scopes?: string[]; expiresInDays?: number },
    creatorRoles: string[], creatorPerms: string[],
  ) {
    const client = await this.getClient(tenantId, clientId);
    let scopes = dto.scopes && dto.scopes.length ? dto.scopes.map((s) => String(s).trim()) : defaultReadScopes();
    scopes = Array.from(new Set(scopes));
    for (const s of scopes) {
      if (!isValidScope(s)) throw new BadRequestException(`scope 格式非法：${s}`);
    }
    const isSuper = (creatorRoles ?? []).some((r) => SUPER_ROLES.includes(r));
    if (!isSuper) {
      for (const s of scopes) {
        if (!matchPermission(creatorPerms ?? [], s)) {
          throw new BadRequestException(`scope 超出创建者权限：${s}（§11.7.7 护栏 1）`);
        }
      }
    }
    const days = Math.floor(Number(dto.expiresInDays ?? TOKEN_DEFAULT_TTL_DAYS));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      throw new BadRequestException('expiresInDays 仅支持 1–365');
    }
    const { plain, hash } = newAgentToken();
    const expiresAt = new Date(Date.now() + days * 86400_000);
    await this.tokens.save({
      clientId: Number(client.id), tenantId, tokenHash: hash, scopes, expiresAt, revoked: false,
    } as Partial<AgentToken>);
    return {
      token: plain,                 // 一次性明文
      tokenMasked: maskToken(plain),
      scopes, expiresAt,
      clientId: Number(client.id),
    };
  }

  async listTokens(tenantId: number, clientId: number) {
    await this.getClient(tenantId, clientId);
    const rows = await this.tokens.find({ where: { clientId, tenantId }, order: { id: 'DESC' } });
    return rows.map((t) => ({
      id: Number(t.id),
      hashTail: String(t.tokenHash).slice(-8),   // 只给指纹尾，反推不了 token
      scopes: t.scopes, revoked: t.revoked,
      expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt, createdAt: t.createdAt,
    }));
  }

  async revokeToken(tenantId: number, tokenId: number) {
    const t = await this.tokens.findOne({ where: { id: tokenId, tenantId } });
    if (!t) throw new NotFoundException('Token 不存在');
    await this.tokens.update({ id: Number(t.id) }, { revoked: true });
    return { id: Number(t.id), revoked: true };
  }

  /** 供审计/管理页展示的一次性指纹 */
  fingerprintArgs(args: unknown): string {
    return argsHash(args);
  }

  /** dispatch 用的 scope 判定（与目录同一个实现） */
  hasScope(scopes: string[], permission: string): boolean {
    return scopeCovers(scopes, permission);
  }

  /** 内部：批量取租户（platform 侧展示用，不出租户边界） */
  async tenantsByIds(ids: number[]): Promise<Map<number, Tenant>> {
    if (!ids.length) return new Map();
    const rows = await this.tenants.find({ where: { id: In(ids) } });
    return new Map(rows.map((r) => [Number(r.id), r]));
  }
}
