// =============================================================================
// PromptsService —— 租户侧「Prompt 库」（P6.5，docs/11 §11.7.5 / D8）
//
// 读写模型：
//   · 系统默认只读（代码里的 SYSTEM_PROMPTS）；租户写的是**同名覆盖行**或自定义行；
//   · 列表 = 系统默认 + 租户行的合并视图（source=system/custom，overridden 标出覆盖）；
//   · 删除租户行 = 回落到系统默认（或彻底删掉自定义行），不存在「删了系统提示词」这种操作。
//
// 为什么要合并视图而不是「开通时给每个租户塞 3 行」：
//   提示词文案会随产品迭代，塞进表里就变成 N 份互不一致的存量数据；
//   合并视图让所有租户默认吃到最新文案，只有真正改过的租户才需要维护。
// =============================================================================
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentPrompt, AgentPromptVersion } from './agent.entity';
import { SYSTEM_PROMPTS, SYSTEM_PROMPT_NAMES } from './prompt.defaults';
import {
  MergedPrompt, PromptInput, PromptSourceDef, PromptSnapshot, enabledPrompts, mergePromptList,
  nextVersion, renderPromptContent, snapshotChanged, snapshotOf, validatePromptInput,
  versionSummary, visibleToRoles,
} from './prompt.calc';

export interface PromptDto {
  name: string;
  title: string;
  description: string;
  arguments: any[];
  content: string;
  enabled: boolean;
  sortOrder: number;
  source: 'system' | 'custom';
  overridden: boolean;
  updatedAt?: Date | null;
  version: number;
  roles: string[];
  usageCount: number;
}

export interface PromptVersionDto {
  id: number;
  version: number;
  action: string;
  summary: string;
  title: string;
  content: string;
  arguments: any[];
  enabled: boolean;
  actorId: number | null;
  createdAt: Date;
}

@Injectable()
export class PromptsService {
  constructor(
    @InjectRepository(AgentPrompt) private readonly repo: Repository<AgentPrompt>,
    @InjectRepository(AgentPromptVersion) private readonly versions: Repository<AgentPromptVersion>,
  ) {}

  private toDef(r: AgentPrompt): PromptSourceDef & { roles?: string[]; version?: number; usageCount?: number } {
    return {
      name: r.name,
      title: r.title,
      description: r.description ?? '',
      content: r.content,
      arguments: Array.isArray(r.arguments) ? r.arguments : [],
      enabled: r.enabled,
      sortOrder: r.sortOrder,
      updatedAt: r.updatedAt,
      roles: Array.isArray((r as any).roles) ? (r as any).roles : [],
      version: (r as any).version ?? 1,
      usageCount: (r as any).usageCount ?? 0,
    };
  }

  private toDto(p: MergedPrompt & { roles?: string[]; version?: number; usageCount?: number }): PromptDto {
    return {
      name: p.name,
      title: p.title,
      description: p.description,
      arguments: p.arguments ?? [],
      content: p.content,
      enabled: p.enabled,
      sortOrder: p.sortOrder,
      source: p.source,
      overridden: p.overridden,
      updatedAt: (p.updatedAt as Date) ?? null,
      version: p.version ?? 1,
      roles: (p as any).roles ?? [],
      usageCount: (p as any).usageCount ?? 0,
    };
  }

  /** 管理视图：系统默认 + 租户覆盖（含被禁用的，否则用户没法再打开）。可按角色过滤。 */
  async list(tenantId: number, viewerRoles: string[] = []): Promise<PromptDto[]> {
    const rows = await this.repo.find({ where: { tenantId }, order: { id: 'ASC' } });
    const merged = mergePromptList(SYSTEM_PROMPTS, rows.map((r) => this.toDef(r)));
    const scoped = viewerRoles.length ? visibleToRoles(merged, viewerRoles) : merged;
    return scoped.map((p) => this.toDto(p));
  }

  /**
   * Agent 侧视图：只下发启用项、带正文（MCP server 本地渲染 prompts/get）。
   * AgentCtx 无可靠角色 → 不传角色，带 roles 限制的 prompt 被 fail-closed 过滤掉。
   */
  async forAgent(tenantId: number): Promise<PromptDto[]> {
    const merged = mergePromptList(
      SYSTEM_PROMPTS,
      (await this.repo.find({ where: { tenantId }, order: { id: 'ASC' } })).map((r) => this.toDef(r)),
    );
    return enabledPrompts(visibleToRoles(merged, [])).map((p) => this.toDto(p));
  }

  async get(tenantId: number, name: string): Promise<PromptDto> {
    const items = await this.list(tenantId);
    const found = items.find((i) => i.name === name);
    if (!found) throw new NotFoundException(`提示词 "${name}" 不存在`);
    return found;
  }

  /**
   * MCP prompts/get 的历史版本取用（§10.37）：从版本表取指定 version 的正文，
   * 按 forAgent 的 DTO 口径返回（只含 enabled 的提示词）。版本表里没有（如系统默认
   * 从未被覆盖过）则回落到当前 forAgent 视图，并标记 versionServed=current。
   */
  async forAgentVersion(tenantId: number, name: string, version: number): Promise<PromptDto & { versionServed: number; fromHistory: boolean }> {
    const target = await this.versions.findOne({
      where: { tenantId, name, version: Number(version) }, order: { id: 'DESC' },
    });
    if (!target) {
      const current = await this.forAgent(tenantId);
      const def = current.find((p) => p.name === name);
      if (!def) throw new NotFoundException(`提示词 "${name}" 不存在`);
      return { ...def, versionServed: (def as any).version ?? 1, fromHistory: false };
    }
    return {
      name,
      title: target.title,
      description: (target as any).description ?? '',
      arguments: Array.isArray(target.arguments) ? target.arguments : [],
      content: target.content,
      enabled: (target as any).enabled !== false,
      sortOrder: (target as any).sortOrder ?? 0,
      version: Number((target as any).version),
      usageCount: 0,
      versionServed: Number((target as any).version),
      fromHistory: true,
    } as PromptDto & { versionServed: number; fromHistory: boolean };
  }

  /**
   * 新建或覆盖（同名 system 行即覆盖）；一个 name 在租户内只有一行。
   * 覆盖前若内容确有变化，写入一条版本快照（version = 旧版本号），版本号随之 +1。
   */
  async upsert(
    tenantId: number, name: string, input: PromptInput, userId: number | null,
    opts: { roles?: string[]; action?: string } = {},
  ): Promise<PromptDto> {
    const v = validatePromptInput(name, input);
    if (!v.ok) throw new BadRequestException({ message: v.errors[0], errors: v.errors });
    const value = v.value!;
    const next: PromptSnapshot = snapshotOf(value as PromptSnapshot);
    const roles = Array.isArray(opts.roles)
      ? opts.roles.map((r) => String(r).slice(0, 40)).filter(Boolean).slice(0, 20)
      : [];
    const existing = await this.repo.findOne({ where: { tenantId, name: value.name } });

    if (existing) {
      const prev: PromptSnapshot = snapshotOf(existing as unknown as PromptSnapshot);
      const changed = snapshotChanged(prev, next);
      const newVersion = nextVersion((existing as any).version);
      if (changed) {
        await this.versions.insert({
          tenantId, name: value.name, version: (existing as any).version ?? 1,
          title: prev.title, description: prev.description, content: prev.content,
          arguments: prev.arguments as any[], enabled: prev.enabled, sortOrder: prev.sortOrder,
          action: opts.action ?? 'upsert', actorId: userId,
        });
      }
      await this.repo.update({ id: existing.id }, {
        title: next.title,
        description: next.description,
        content: next.content,
        arguments: next.arguments as any[],
        enabled: next.enabled,
        sortOrder: next.sortOrder,
        version: changed ? newVersion : ((existing as any).version ?? 1),
        roles: roles as any[],
        updatedBy: userId,
        updatedAt: new Date(),
      });
    } else {
      // 首次创建也存一条 initial 快照，使「第一次改动前」可回滚
      await this.versions.insert({
        tenantId, name: value.name, version: 1,
        title: next.title, description: next.description, content: next.content,
        arguments: next.arguments as any[], enabled: next.enabled, sortOrder: next.sortOrder,
        action: 'initial', actorId: userId,
      });
      await this.repo.insert({
        tenantId,
        name: value.name,
        title: next.title,
        description: next.description,
        content: next.content,
        arguments: next.arguments as any[],
        enabled: next.enabled,
        sortOrder: next.sortOrder,
        roles: roles as any[],
        version: 1,
        createdBy: userId,
        updatedBy: userId,
      });
    }
    return this.get(tenantId, value.name);
  }

  /** 版本历史（倒序）；summary 由相邻版本对比得出（纯函数） */
  async listVersions(tenantId: number, name: string): Promise<PromptVersionDto[]> {
    const rows = await this.versions.find({
      where: { tenantId, name }, order: { version: 'DESC', id: 'DESC' },
    });
    return rows.map((r, i) => {
      const cur = snapshotOf(r as unknown as PromptSnapshot);
      const prevRow = rows[i + 1]; // 更旧的相邻版本
      const summary = prevRow
        ? versionSummary(snapshotOf(prevRow as unknown as PromptSnapshot), cur, r.action)
        : versionSummary(cur, cur, r.action); // 最早一条是存档基线
      return {
        id: Number(r.id),
        version: Number((r as any).version),
        action: r.action,
        summary,
        title: r.title,
        content: r.content,
        arguments: Array.isArray(r.arguments) ? r.arguments : [],
        enabled: r.enabled,
        actorId: (r as any).actorId ?? null,
        createdAt: r.createdAt,
      };
    });
  }

  /**
   * 回滚到指定版本：把历史内容作为新一次 upsert 写回（version 继续 +1），
   * 并在版本表留下 rollback 快照，形成可追溯链。找不到目标版本 404。
   */
  async rollback(tenantId: number, name: string, targetVersion: number, userId: number | null): Promise<PromptDto> {
    const target = await this.versions.findOne({
      where: { tenantId, name, version: Number(targetVersion) }, order: { id: 'DESC' },
    });
    if (!target) throw new NotFoundException(`提示词「${name}」没有版本 v${targetVersion}`);
    return this.upsert(tenantId, name, {
      title: target.title,
      description: target.description,
      content: target.content,
      arguments: Array.isArray(target.arguments) ? target.arguments : [],
      enabled: target.enabled,
      sortOrder: target.sortOrder,
    }, userId, { action: 'rollback' });
  }

  /** 累加调用/渲染次数（best-effort；失败不影响主流程） */
  async bumpUsage(tenantId: number, name: string): Promise<void> {
    try {
      await this.repo.createQueryBuilder()
        .update(AgentPrompt)
        .set({ usageCount: () => 'COALESCE(usage_count, 0) + 1' })
        .where('tenant_id = :tenantId', { tenantId })
        .andWhere('name = :name', { name })
        .execute();
    } catch { /* 统计失败不影响预览/Agent 渲染 */ }
  }

  /** 删除租户行：系统同名 → 回落默认；自定义 → 彻底消失 */
  async remove(tenantId: number, name: string) {
    const res = await this.repo.delete({ tenantId, name });
    if (!res.affected) {
      throw new NotFoundException(`租户没有自定义「${name}」${SYSTEM_PROMPT_NAMES.includes(name) ? '（系统默认不可删除）' : ''}`);
    }
    return { name, removed: true, revertedToSystem: SYSTEM_PROMPT_NAMES.includes(name) };
  }

  /** 渲染预览（与 Agent 的 prompts/get 同一套纯函数，避免「预览好好的、Agent 拿到空的」） */
  async preview(tenantId: number, name: string, args: Record<string, any>) {
    const def = await this.get(tenantId, name);
    const r = renderPromptContent(def.content, def.arguments as any, args ?? {});
    if (!r.ok) throw new BadRequestException(r.reason);
    void this.bumpUsage(tenantId, name); // best-effort，不 await 不阻塞
    return {
      name: def.name, title: def.title, source: def.source,
      text: r.text, length: (r.text ?? '').length,
    };
  }
}
