// 模板服务：CRUD / 版本快照 / 复制 / 收藏 / 导入导出
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Template, TemplateVersion } from '../entities/template.entity';
import { useTenantId } from '../common/tenant.context';

const CURRENT_SCHEMA = 1;
// 导入兼容迁移（按 schemaVersion 路由）
const migrators: Record<number, (t: any) => any> = {
  0: (t) => ({ ...t, page: { ...t.page, orientation: t.page.orientation ?? 0 }, schemaVersion: 1 }),
};

@Injectable()
export class TemplateService {
  constructor(
    @InjectRepository(Template) private tpl: Repository<Template>,
    @InjectRepository(TemplateVersion) private ver: Repository<TemplateVersion>,
  ) {}

  private tid() { return useTenantId(); }

  list(q: { category?: string; keyword?: string; favorite?: boolean; page?: number; pageSize?: number }) {
    const where: any = { tenantId: this.tid() };
    if (q.category) where.category = q.category;
    if (q.favorite) where.isFavorite = true;
    return this.tpl.findAndCount({
      where,
      skip: ((q.page ?? 1) - 1) * (q.pageSize ?? 20),
      take: q.pageSize ?? 20,
      order: { updatedAt: 'DESC' },
    });
  }

  async get(id: number) {
    const t = await this.tpl.findOne({ where: { id, tenantId: this.tid() } });
    if (!t) throw new NotFoundException('模板不存在');
    return t;
  }

  async create(dto: { name: string; category?: string; tags?: string[]; content: any; createdBy?: number }) {
    // 保存即生成版本 1
    const t = await this.tpl.save({ ...dto, tenantId: this.tid(), schemaVersion: CURRENT_SCHEMA, currentVersion: 1, tags: dto.tags ?? [] });
    await this.ver.save({ tenantId: this.tid(), templateId: t.id, version: 1, content: dto.content, createdBy: dto.createdBy });
    return t;
  }

  /** 保存新版本（每次保存生成快照，可回滚/对比） */
  async update(id: number, dto: { name?: string; content?: any; updatedBy?: number }) {
    const t = await this.get(id);
    const next = t.currentVersion + 1;
    if (dto.content) await this.ver.save({ tenantId: this.tid(), templateId: id, version: next, content: dto.content, createdBy: dto.updatedBy });
    return this.tpl.save({ ...t, ...dto, currentVersion: next });
  }

  async remove(id: number) { await this.get(id); return this.tpl.delete({ id, tenantId: this.tid() }); }

  async copy(id: number, name?: string) {
    const t = await this.get(id);
    return this.create({ name: name ?? `${t.name}-副本`, category: t.category, tags: t.tags, content: t.content, createdBy: t.createdBy });
  }

  async favorite(id: number, val: boolean) { const t = await this.get(id); return this.tpl.save({ ...t, isFavorite: val }); }

  versions(id: number) { return this.ver.find({ where: { templateId: id, tenantId: this.tid() }, order: { version: 'DESC' } }); }

  async rollback(id: number, version: number) {
    const v = await this.ver.findOne({ where: { templateId: id, version, tenantId: this.tid() } });
    if (!v) throw new NotFoundException('版本不存在');
    return this.update(id, { content: v.content });
  }

  /** 导入：校验 schemaVersion 并迁移 */
  import(raw: any) {
    let t = raw;
    while (t.schemaVersion < CURRENT_SCHEMA) t = (migrators[t.schemaVersion] ?? ((x: any) => x))(t);
    return this.create({ name: t.name, category: t.category, tags: t.tags, content: t.content });
  }

  /** 导出单模板为 .ziptpl 等效 JSON（真实场景用 jszip 打包 assets/） */
  async exportOne(id: number) {
    const t = await this.get(id);
    return { template: t, schemaVersion: CURRENT_SCHEMA };
  }
}
