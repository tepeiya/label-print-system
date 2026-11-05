// =============================================================================
// IdempotencyService —— 写工具幂等（docs/11 §11.7.4「写操作幂等」/ §11.7.7 护栏 4）
//
// 语义（对齐常见幂等实现，避免「失败也永久占坑」）：
//   claim()   先占坑（result=null）。命中已有记录时：
//             · 有 result → 首次已成功，直接重放（同 args_hash）或 409（不同 args_hash）
//             · 无 result → 前一次仍在执行/已崩溃；同 hash 允许接管重试，不同 hash 拒 409
//   finish()  执行成功后把结果信封写回，之后的重放就靠它
//   release() 执行失败删掉占坑记录，同一 key 可以安全重试
// =============================================================================
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ToolIdempotency } from './agent.entity';

export interface ClaimResult {
  row: ToolIdempotency;
  /** true = 本次新建占坑（可以执行）；false = 已有记录（重放或接管） */
  fresh: boolean;
}

@Injectable()
export class IdempotencyService {
  private logger = new Logger('IdempotencyService');

  constructor(@InjectRepository(ToolIdempotency) private repo: Repository<ToolIdempotency>) {}

  async find(tenantId: number, tool: string, idemKey: string): Promise<ToolIdempotency | null> {
    if (!idemKey) return null;
    return this.repo.findOne({
      where: { tenantId, tool, idemKey },
      order: { id: 'DESC' },
    });
  }

  async claim(args: {
    tenantId: number; clientId: number; tool: string; idemKey: string; argsHash: string; approvalId?: number | null;
  }): Promise<ClaimResult> {
    const existing = await this.find(args.tenantId, args.tool, args.idemKey);
    if (existing) return { row: existing, fresh: false };
    try {
      const row = await this.repo.save(this.repo.create({
        tenantId: args.tenantId,
        agentClientId: args.clientId,
        tool: args.tool,
        idemKey: args.idemKey,
        argsHash: args.argsHash,
        approvalId: args.approvalId ?? null,
        result: null,
      }));
      return { row, fresh: true };
    } catch (e) {
      // 并发下唯一索引 (tenant_id, tool, idem_key) 冲突 → 当作已有记录处理
      const row = await this.find(args.tenantId, args.tool, args.idemKey);
      if (row) return { row, fresh: false };
      throw e;
    }
  }

  async finish(id: number, result: Record<string, any>): Promise<void> {
    await this.repo.update({ id }, { result });
  }

  async release(id: number): Promise<void> {
    try {
      await this.repo.delete({ id });
    } catch (e) {
      this.logger.warn(`幂等占坑释放失败 id=${id}: ${(e as Error).message}`);
    }
  }
}
