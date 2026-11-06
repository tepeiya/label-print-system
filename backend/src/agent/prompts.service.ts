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
import { AgentPrompt } from './agent.entity';
import { SYSTEM_PROMPTS, SYSTEM_PROMPT_NAMES } from './prompt.defaults';
import {
  MergedPrompt, PromptInput, PromptSourceDef, enabledPrompts, mergePromptList,
  renderPromptContent, validatePromptInput,
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
}

@Injectable()
export class PromptsService {
  constructor(@InjectRepository(AgentPrompt) private readonly repo: Repository<AgentPrompt>) {}

  private toDef(r: AgentPrompt): PromptSourceDef {
    return {
      name: r.name,
      title: r.title,
      description: r.description ?? '',
      content: r.content,
      arguments: Array.isArray(r.arguments) ? r.arguments : [],
      enabled: r.enabled,
      sortOrder: r.sortOrder,
      updatedAt: r.updatedAt,
    };
  }

  private toDto(p: MergedPrompt): PromptDto {
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
    };
  }

  /** 管理视图：系统默认 + 租户覆盖（含被禁用的，否则用户没法再打开） */
  async list(tenantId: number): Promise<PromptDto[]> {
    const rows = await this.repo.find({ where: { tenantId }, order: { id: 'ASC' } });
    return mergePromptList(SYSTEM_PROMPTS, rows.map((r) => this.toDef(r))).map((p) => this.toDto(p));
  }

  /** Agent 侧视图：只下发启用项，带正文（MCP server 本地渲染 prompts/get） */
  async forAgent(tenantId: number): Promise<PromptDto[]> {
    return enabledPrompts(mergePromptList(
      SYSTEM_PROMPTS,
      (await this.repo.find({ where: { tenantId }, order: { id: 'ASC' } })).map((r) => this.toDef(r)),
    )).map((p) => this.toDto(p));
  }

  async get(tenantId: number, name: string): Promise<PromptDto> {
    const items = await this.list(tenantId);
    const found = items.find((i) => i.name === name);
    if (!found) throw new NotFoundException(`提示词 "${name}" 不存在`);
    return found;
  }

  /** 新建或覆盖（同名 system 行即覆盖）；一个 name 在租户内只有一行 */
  async upsert(tenantId: number, name: string, input: PromptInput, userId: number | null): Promise<PromptDto> {
    const v = validatePromptInput(name, input);
    if (!v.ok) throw new BadRequestException({ message: v.errors[0], errors: v.errors });
    const value = v.value!;
    const existing = await this.repo.findOne({ where: { tenantId, name: value.name } });
    if (existing) {
      await this.repo.update({ id: existing.id }, {
        title: value.title,
        description: value.description,
        content: value.content,
        arguments: value.arguments as any[],
        enabled: value.enabled,
        sortOrder: value.sortOrder,
        updatedBy: userId,
        updatedAt: new Date(),
      });
    } else {
      await this.repo.insert({
        tenantId,
        name: value.name,
        title: value.title,
        description: value.description,
        content: value.content,
        arguments: value.arguments as any[],
        enabled: value.enabled,
        sortOrder: value.sortOrder,
        createdBy: userId,
        updatedBy: userId,
      });
    }
    return this.get(tenantId, value.name);
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
    return {
      name: def.name, title: def.title, source: def.source,
      text: r.text, length: (r.text ?? '').length,
    };
  }
}
