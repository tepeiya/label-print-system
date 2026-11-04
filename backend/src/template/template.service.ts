// 模板服务：CRUD / 版本快照 / 复制 / 收藏 / 导入导出 / 缩略图
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Template, TemplateVersion } from '../entities/template.entity';
import { useTenant, useTenantId } from '../common/tenant.context';
import { AuditService } from '../audit/audit.module';
import { renderThumbnail } from '../print/thumbnail-renderer';
import { assertAclAccess } from '../common/acl-check';

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
    const ctx = useTenant();
    const where: any = { tenantId: this.tid() };
    if (q.category) where.category = q.category;
    if (q.favorite) where.isFavorite = true;
    const isAdmin = ctx.roles?.includes('admin');
    return this.tpl.findAndCount({
      where,
      skip: ((q.page ?? 1) - 1) * (q.pageSize ?? 20),
      take: Math.min(5000, q.pageSize ?? 200), // 非 admin 拉多点以便内存过滤
      order: { updatedAt: 'DESC' },
    }).then(([rows, total]) => {
      if (isAdmin) return [rows, total];
      // 非 admin：内存过滤，只保留自己创建的 / public=true 的 / acl.users 含我的
      const uid = ctx.userId;
      const filtered = rows.filter((t) => isListVisible(t, uid, ctx.roles ?? []));
      return [filtered, filtered.length];
    });
  }

  async get(id: number) {
    const t = await this.tpl.findOne({ where: { id, tenantId: this.tid() } });
    if (!t) throw new NotFoundException('模板不存在');
    assertAclAccess(t, false);
    return t;
  }

  async create(dto: { name: string; category?: string; tags?: string[]; content: any; createdBy?: number; acl?: any }) {
    // 默认 acl：同租户所有人可读
    const acl = dto.acl ?? { public: true };
    const t = await this.tpl.save({
      ...dto, tenantId: this.tid(),
      schemaVersion: CURRENT_SCHEMA, currentVersion: 1,
      tags: dto.tags ?? [], acl,
    });
    await this.ver.save({ tenantId: this.tid(), templateId: t.id, version: 1, content: dto.content, createdBy: dto.createdBy });
    await this.audit.write(this.tid(), 'template.create', { id: t.id, name: t.name, category: t.category }, dto.createdBy, 'template', t.id);
    this.genThumbnail(t.id, dto.content).catch(() => { /* 缩略图生成失败不阻断主链路 */ });
    return t;
  }

  /** 保存新版本（每次保存生成快照，可回滚/对比） */
  async update(id: number, dto: { name?: string; content?: any; updatedBy?: number }) {
    const t = await this.get(id);
    assertAclAccess(t, true);
    const next = t.currentVersion + 1;
    if (dto.content) await this.ver.save({ tenantId: this.tid(), templateId: id, version: next, content: dto.content, createdBy: dto.updatedBy });
    const saved = await this.tpl.save({ ...t, ...dto, currentVersion: next });
    await this.audit.write(this.tid(), 'template.update', { id, version: next, name: dto.name }, dto.updatedBy, 'template', id);
    if (dto.content) this.genThumbnail(id, dto.content).catch(() => {});
    return saved;
  }

  async remove(id: number) {
    const t = await this.get(id);
    assertAclAccess(t, true);
    const r = await this.tpl.delete({ id, tenantId: this.tid() });
    await this.audit.write(this.tid(), 'template.delete', { id, name: t.name }, undefined, 'template', id);
    return r;
  }

  async copy(id: number, name?: string) {
    const t = await this.get(id);
    assertAclAccess(t, true);
    const created = await this.create({ name: name ?? `${t.name}-副本`, category: t.category, tags: t.tags, content: t.content, createdBy: t.createdBy });
    await this.audit.write(this.tid(), 'template.copy', { sourceId: id, newId: created.id }, undefined, 'template', created.id);
    return created;
  }

  async favorite(id: number, val: boolean) {
    const t = await this.get(id);
    assertAclAccess(t, true);
    const r = await this.tpl.save({ ...t, isFavorite: val }); return r;
  }

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

  /** 异步生成模板缩略图：用 sharp + SVG 真实渲染元素（图形/条码可见，文本简化） */
  private async genThumbnail(templateId: number, content: any) {
    try {
      const buf = await renderThumbnail(content);
      await this.tpl.update({ id: templateId, tenantId: this.tid() }, { thumbnail: buf });
    } catch (err) {
      // 缩略图生成失败不阻断主链路
      console.warn('[template] 缩略图生成失败（已跳过）：', err instanceof Error ? err.message : err);
    }
  }
}

/** list 过滤用：非 admin 保留 public/self/acl.users 的模板 */
function isListVisible(tpl: Template, userId: number | null, roles: string[]): boolean {
  if (roles.includes('admin')) return true;
  if (tpl.createdBy && userId && +tpl.createdBy === +userId) return true;
  const acl: any = tpl.acl ?? {};
  if (acl.public) return true;
  if (userId && (Array.isArray(acl.users) ? acl.users.map((u: any) => +u).includes(+userId) : false)) return true;
  if (Array.isArray(acl.roles) && acl.roles.some((r: string) => roles.includes(r))) return true;
  return false;
}
