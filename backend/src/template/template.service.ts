// 模板服务：CRUD / 版本快照 / 复制 / 收藏 / 导入导出
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Template, TemplateVersion } from '../entities/template.entity';
import { useTenantId } from '../common/tenant.context';
import { AuditService } from '../audit/audit.module';

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
    private audit: AuditService,
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
    await this.audit.write(this.tid(), 'template.create', { id: t.id, name: t.name, category: t.category }, dto.createdBy, 'template', t.id);
    return t;
  }

  /** 保存新版本（每次保存生成快照，可回滚/对比） */
  async update(id: number, dto: { name?: string; content?: any; updatedBy?: number }) {
    const t = await this.get(id);
    const next = t.currentVersion + 1;
    if (dto.content) await this.ver.save({ tenantId: this.tid(), templateId: id, version: next, content: dto.content, createdBy: dto.updatedBy });
    const saved = await this.tpl.save({ ...t, ...dto, currentVersion: next });
    await this.audit.write(this.tid(), 'template.update', { id, version: next, name: dto.name }, dto.updatedBy, 'template', id);
    return saved;
  }

  async remove(id: number) {
    const t = await this.get(id);
    const r = await this.tpl.delete({ id, tenantId: this.tid() });
    await this.audit.write(this.tid(), 'template.delete', { id, name: t.name }, undefined, 'template', id);
    return r;
  }

  async copy(id: number, name?: string) {
    const t = await this.get(id);
    const created = await this.create({ name: name ?? `${t.name}-副本`, category: t.category, tags: t.tags, content: t.content, createdBy: t.createdBy });
    await this.audit.write(this.tid(), 'template.copy', { sourceId: id, newId: created.id }, undefined, 'template', created.id);
    return created;
  }

  async favorite(id: number, val: boolean) { const t = await this.get(id); const r = await this.tpl.save({ ...t, isFavorite: val }); return r; }

  versions(id: number) { return this.ver.find({ where: { templateId: id, tenantId: this.tid() }, order: { version: 'DESC' } }); }

  /** 单个版本内容（版本对比用） */
  async version(id: number, version: number) {
    const v = await this.ver.findOne({ where: { templateId: id, version, tenantId: this.tid() } });
    if (!v) throw new NotFoundException('版本不存在');
    return v;
  }

  async rollback(id: number, version: number) {
    const v = await this.version(id, version);
    const saved = await this.update(id, { content: v.content });
    await this.audit.write(this.tid(), 'template.rollback', { id, fromVersion: version, toVersion: saved.currentVersion }, undefined, 'template', id);
    return saved;
  }

  /** 导入：校验 schemaVersion 并迁移 */
  async import(raw: any) {
    let t = raw;
    while (t.schemaVersion < CURRENT_SCHEMA) t = (migrators[t.schemaVersion] ?? ((x: any) => x))(t);
    const created = await this.create({ name: t.name, category: t.category, tags: t.tags, content: t.content });
    await this.audit.write(this.tid(), 'template.import', { newId: created.id, name: created.name }, undefined, 'template', created.id);
    return created;
  }

  /** 导出单模板为 .ziptpl 等效 JSON（真实场景用 jszip 打包 assets/） */
  async exportOne(id: number) {
    const t = await this.get(id);
    return { template: t, schemaVersion: CURRENT_SCHEMA };
  }
}
