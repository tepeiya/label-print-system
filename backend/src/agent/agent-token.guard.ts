// Agent Token 守卫（docs/11 §11.6.3：Bearer lfagent_xxx → 直接解析 tenantId，禁止请求体传租户）
// 挂在 /agent/v1 控制器上；控制器类级 @Public() 已让全局 JWT/模块/权限链跳过，
// 这里失败一律 401（身份无效）或 403（客户端/租户被停用），与 P2 PlatformJwtGuard 同一模式。
import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { AgentService } from './agent.service';
import { looksLikeAgentToken } from './agent.calc';

const MESSAGES: Record<string, string> = {
  not_found: 'Agent Token 无效',
  revoked: 'Agent Token 已撤销',
  expired: 'Agent Token 已过期',
  client_disabled: 'Agent 客户端已停用',
  tenant_disabled: '租户已停用',
};

@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(private agent: AgentService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth = String(req.headers?.authorization ?? '');
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (!m) throw new UnauthorizedException('缺少 Agent Token（Authorization: Bearer <token>）');
    const plain = m[1];
    // 形态不符（例如拿租户 JWT 来打 /agent/v1）按无效处理，不做二次解释
    if (!looksLikeAgentToken(plain)) {
      throw new UnauthorizedException(MESSAGES.not_found);
    }
    const rec = await this.agent.authenticate(plain);
    if (rec.status !== 'ok' || !rec.token || !rec.client || !rec.tenant) {
      const message = MESSAGES[rec.status] ?? MESSAGES.not_found;
      // 身份本身无效 → 401；身份有效但客户端/租户被停用 → 403（§11.9 越权语义的 agent 版）
      if (rec.status === 'client_disabled' || rec.status === 'tenant_disabled') {
        throw new ForbiddenException(message);
      }
      throw new UnauthorizedException(message);
    }
    req.agentCtx = {
      tenantId: Number(rec.token.tenantId),
      clientId: Number(rec.client.id),
      clientName: rec.client.name,
      scopes: rec.token.scopes ?? [],
      tokenId: Number(rec.token.id),
      onBehalfOf: rec.client.createdBy === null || rec.client.createdBy === undefined
        ? null : Number(rec.client.createdBy),
    };
    // last_used_at 打点失败不影响本次调用
    void this.agent.touch(Number(rec.token.id));
    return true;
  }
}
