// =============================================================================
// InventoryService —— P4 库存只读查询（docs/11 §11.7.2/§11.7.3）
// 只服务 Agent 只读工具（/agent/v1），没有租户 REST 控制器——完整 WMS 页面在后续阶段。
// 全部查询强制 tenant_id；数值列（numeric/bigint 反射为 string）出参前 Number()。
// =============================================================================
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type EntityManager } from 'typeorm';
import {
  Material, MaterialFieldDefinition, StockBatch, StockMove, Warehouse, WarehouseLocation, ProductGroup, Bom, BomItem,
} from './inventory.entity';
import { Template } from '../entities/template.entity';
import { Printer } from '../entities/print.entity';
import { PrintService } from '../print/print.service';
import { computeKit, escapeLike, KitOutcome, round3 } from './kit.calc';
import { assertFieldDef, normalizeCustomValues, toPrintFields } from './field-defs.calc';
// P6.2 阶段 B：事务/原生 QB 也按 TenantCtx.dataSourceKey 路由（Repository 已由代理模块接管）
import { TENANT_DATASOURCE, tenantDataSourceProxy } from '../common/tenant-routing';

type TenantDataSource = ReturnType<typeof tenantDataSourceProxy>;

/** jsonb 列经 getRawMany 可能是对象或字符串，统一解析为对象 */
function parseJsonb(v: unknown): Record<string, any> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
  if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
  return {};
}

/** 一次库存变动落到的批次行（P5 写路径：adjust / transfer 复用） */
export interface StockMoveLine {
  batchNo: string;
  warehouse: string;
  change: number;
  before: number;
  after: number;
  locationId?: number | null;
}

/** adjustStock / transferStock 的统一出参（dryRun 时 lines 是「将会发生」的变动） */
export interface StockWriteOutcome {
  material: { id: number; code: string; name: string; unit: string };
  warehouse: { id: number; code: string; name: string };
  dryRun: boolean;
  change: number;
  lines: StockMoveLine[];
  note: string | null;
}

export interface QueryStockArgs {
  keyword?: string;
  warehouse?: string;
  groupBy?: 'sku' | 'batch' | 'warehouse';
  belowSafety?: boolean;
  expiringDays?: number;
  limit?: number;
}

export interface StockRow {
  materialId: number; code: string; name: string; spec: string | null; unit: string;
  warehouseId?: number; warehouse?: string; batchNo?: string; expiresAt?: string | null;
  qty: number; safetyStock?: number; belowSafety?: boolean;
}

/** 台账单行：qty 带符号（入库/调入为正，出库/调出为负） */
export interface MoveLine {
  batchNo: string;
  warehouseId: number;
  qty: number;
  before: number;
  after: number;
  locationId?: number | null;
}

export interface QueryMovesArgs {
  kind?: 'in' | 'out' | 'transfer';
  keyword?: string;
  materialId?: number;
  warehouseId?: number;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** BOM 维护入参（纯结构，Controller 的 DTO 结构兼容；避免服务层依赖 class-validator） */
export interface SaveBomLineInput {
  /** 物料编码或名称 */
  material: string;
  qtyPer: number;
  lossRate?: number;
}
export interface SaveBomInput {
  id?: number;
  product: string;
  version?: string;
  status?: 'draft' | 'active' | 'inactive';
  items: SaveBomLineInput[];
}
export type BomStatus = 'draft' | 'active' | 'inactive';
export interface BomLineView {
  id: number; materialId: number; code: string; name: string; unit: string;
  qtyPer: number; lossRate: number;
}
export interface BomView {
  id: number; productMaterialId: number; productCode: string; productName: string;
  version: string; status: BomStatus; createdAt: string; lines: BomLineView[];
}

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(MaterialFieldDefinition) private fieldDefs: Repository<MaterialFieldDefinition>,
    @InjectRepository(Warehouse) private warehouses: Repository<Warehouse>,
    @InjectRepository(WarehouseLocation) private locations: Repository<WarehouseLocation>,
    @InjectRepository(ProductGroup) private groups: Repository<ProductGroup>,
    @InjectRepository(Printer) private printers: Repository<Printer>,
    @InjectRepository(StockBatch) private batches: Repository<StockBatch>,
    @InjectRepository(StockMove) private moves: Repository<StockMove>,
    @InjectRepository(Bom) private boms: Repository<Bom>,
    @InjectRepository(BomItem) private bomItems: Repository<BomItem>,
    @InjectRepository(Template) private templates: Repository<Template>,
    @Inject(TENANT_DATASOURCE) private ds: TenantDataSource,
    private print: PrintService,
  ) {}

  /** 分页上限统一 100（§11.7.4「分页统一」） */
  private clampLimit(limit?: number): number {
    const n = Math.floor(Number(limit ?? 20));
    if (!Number.isFinite(n) || n < 1) return 20;
    return Math.min(n, 100);
  }

  /** expiring_days ∈ [1,365]（§11.7.3 schema） */
  private clampDays(days?: number, dflt = 30): number {
    const n = Math.floor(Number(days ?? dflt));
    if (!Number.isFinite(n) || n < 1) return dflt;
    return Math.min(n, 365);
  }

  /**
   * 台账落库：必须与库存变动在同一个 EntityManager 事务里调用，
   * 这样「账」和「实」要么一起成、要么一起回滚。dryRun 时调用方不进入事务，自然不留痕。
   */
  private async recordMoves(
    em: EntityManager, tenantId: number, kind: 'in' | 'out' | 'transfer',
    material: Material, lines: MoveLine[], reason: string, operator: string, toWarehouseId?: number | null,
  ): Promise<void> {
    if (!lines.length) return;
    const repo = em.getRepository(StockMove);
    const moveNo = buildMoveNo(kind);
    for (const l of lines) {
      await repo.save(repo.create({
        tenantId, moveNo, kind,
        materialId: Number(material.id), warehouseId: Number(l.warehouseId),
        toWarehouseId: toWarehouseId == null ? null : Number(toWarehouseId),
        batchNo: l.batchNo, locationId: l.locationId == null ? null : Number(l.locationId),
        qty: String(round3(l.qty)), beforeQty: String(round3(l.before)), afterQty: String(round3(l.after)),
        reason: reason.slice(0, 200), operator: operator.slice(0, 80),
      }));
    }
  }

  /** 出入库台账查询（带物料/仓库名，供租户页面直接展示） */
  async queryMoves(tenantId: number, args: QueryMovesArgs = {}) {
    const limit = Math.min(Math.max(Math.floor(Number(args.limit ?? 20)) || 20, 1), 100);
    const offset = Math.max(Math.floor(Number(args.offset ?? 0)) || 0, 0);
    const qb = this.moves.createQueryBuilder('mv')
      .innerJoin(Material, 'm', 'm.id = mv.material_id')
      .innerJoin(Warehouse, 'w', 'w.id = mv.warehouse_id')
      .leftJoin(WarehouseLocation, 'l', 'l.id = mv.location_id')
      .where('mv.tenant_id = :tid', { tid: tenantId });
    if (args.kind && ['in', 'out', 'transfer'].includes(args.kind)) qb.andWhere('mv.kind = :kind', { kind: args.kind });
    if (args.materialId) qb.andWhere('mv.material_id = :mid', { mid: Number(args.materialId) });
    if (args.warehouseId) {
      qb.andWhere('(mv.warehouse_id = :wid OR mv.to_warehouse_id = :wid)', { wid: Number(args.warehouseId) });
    }
    if (args.keyword) {
      const kw = `%${escapeLike(args.keyword)}%`;
      qb.andWhere('(m.code ILIKE :kw OR m.name ILIKE :kw OR mv.batch_no ILIKE :kw OR mv.move_no ILIKE :kw OR mv.reason ILIKE :kw)', { kw });
    }
    if (args.from) qb.andWhere('mv.created_at >= :from', { from: new Date(args.from) });
    if (args.to) qb.andWhere('mv.created_at < :to', { to: new Date(new Date(args.to).getTime() + 86_400_000) });

    const total = await qb.getCount();
    const rows = await qb
      .select('mv.id', 'id').addSelect('mv.move_no', 'moveNo').addSelect('mv.kind', 'kind')
      .addSelect('m.code', 'materialCode').addSelect('m.name', 'materialName').addSelect('m.unit', 'unit')
      .addSelect('w.name', 'warehouse').addSelect('l.code', 'locationCode')
      .addSelect('mv.batch_no', 'batchNo')
      .addSelect('mv.qty', 'qty').addSelect('mv.before_qty', 'beforeQty').addSelect('mv.after_qty', 'afterQty')
      .addSelect('mv.reason', 'reason').addSelect('mv.operator', 'operator')
      .addSelect('to_char(mv.created_at, \'YYYY-MM-DD HH24:MI:SS\')', 'createdAt')
      .orderBy('mv.created_at', 'DESC').addOrderBy('mv.id', 'DESC')
      .offset(offset).limit(limit).getRawMany();
    return {
      total,
      items: rows.map((r) => ({ ...r, id: Number(r.id), qty: Number(r.qty), beforeQty: Number(r.beforeQty), afterQty: Number(r.afterQty) })),
    };
  }

  // --------------------------------------------------------------- 基础资料维护

  /** 物料列表 / 下拉（includeInactive=true 供维护页看全部） */
  async listMaterials(tenantId: number, keyword = '', limit = 100, includeInactive = false) {
    const qb = this.materials.createQueryBuilder('m')
      .leftJoin(Template, 't', 't.id = m.template_id')
      .leftJoin(ProductGroup, 'g', 'g.id = m.group_id')
      .where('m.tenant_id = :tid', { tid: tenantId });
    if (!includeInactive) qb.andWhere('m.active = true');
    if (keyword) {
      const kw = `%${escapeLike(keyword)}%`;
      qb.andWhere('(m.code ILIKE :kw OR m.name ILIKE :kw OR m.spec ILIKE :kw)', { kw });
    }
    const rows = await qb.select('m.id', 'id').addSelect('m.code', 'code').addSelect('m.name', 'name')
      .addSelect('m.spec', 'spec').addSelect('m.unit', 'unit').addSelect('m.category', 'category')
      .addSelect('m.safety_stock', 'safetyStock').addSelect('m.active', 'active')
      .addSelect('m.template_id', 'templateId').addSelect('t.name', 'templateName')
      .addSelect('m.group_id', 'groupId').addSelect('g.name', 'groupName')
      .addSelect('m.auto_print', 'autoPrint').addSelect('m.printer_id', 'printerId')
      .addSelect('m.default_warehouse_id', 'defaultWarehouseId')
      .addSelect('m.default_location_id', 'defaultLocationId')
      .addSelect('m.custom_fields', 'customFields')
      .orderBy('m.code', 'ASC').limit(Math.min(Math.max(limit, 1), 100)).getRawMany();
    return rows.map((r) => ({
      ...r, id: Number(r.id), safetyStock: Number(r.safetyStock),
      customFields: parseJsonb(r.customFields),
      templateId: r.templateId == null ? null : Number(r.templateId),
      groupId: r.groupId == null ? null : Number(r.groupId),
      printerId: r.printerId == null ? null : Number(r.printerId),
      defaultWarehouseId: r.defaultWarehouseId == null ? null : Number(r.defaultWarehouseId),
      defaultLocationId: r.defaultLocationId == null ? null : Number(r.defaultLocationId),
      autoPrint: !!r.autoPrint,
    }));
  }

  // ---------------- 产品自定义字段定义 ----------------

  /** 字段定义列表（含停用，维护页用）；按 sortOrder 排序 */
  async listFieldDefs(tenantId: number, includeInactive = false) {
    const where: any = { tenantId };
    if (!includeInactive) where.active = true;
    const rows = await this.fieldDefs.find({ where, order: { sortOrder: 'ASC', id: 'ASC' } });
    return rows.map((r) => ({
      id: Number(r.id), fieldKey: r.fieldKey, label: r.label, type: r.type,
      required: !!r.required, options: Array.isArray(r.options) ? r.options : [],
      sortOrder: Number(r.sortOrder ?? 0), active: !!r.active,
    }));
  }

  /** 用规范化定义校验产品自定义字段值（写入前统一入口） */
  private async normalizeValues(
    tenantId: number, raw: Record<string, unknown> | undefined,
  ): Promise<Record<string, any>> {
    const defs = await this.listFieldDefs(tenantId);
    try {
      return normalizeCustomValues(defs as any, raw);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? '自定义字段值不合法');
    }
  }

  async createFieldDef(tenantId: number, b: {
    fieldKey: string; label: string; type: string; required?: boolean;
    options?: string[]; sortOrder?: number;
  }) {
    let def: any;
    try { def = assertFieldDef(b); } catch (e: any) { throw new BadRequestException(e?.message); }
    const dup = await this.fieldDefs.findOne({ where: { tenantId, fieldKey: def.fieldKey } });
    if (dup) throw new BadRequestException(`字段标识已存在：${def.fieldKey}`);
    const row = await this.fieldDefs.save(this.fieldDefs.create({
      tenantId, fieldKey: def.fieldKey, label: def.label, type: def.type,
      required: def.required, options: def.options, sortOrder: def.sortOrder,
    }));
    return { id: Number(row.id), ...def };
  }

  async updateFieldDef(tenantId: number, id: number, b: {
    label?: string; type?: string; required?: boolean; options?: string[]; sortOrder?: number;
  }) {
    const row = await this.fieldDefs.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('字段定义不存在');
    // 合并现有值后整体走 assertFieldDef，保证改类型/选项后仍合法
    let def: any;
    try {
      def = assertFieldDef({
        fieldKey: row.fieldKey,
        label: b.label ?? row.label,
        type: b.type ?? row.type,
        required: b.required ?? row.required,
        options: b.options ?? row.options,
        sortOrder: b.sortOrder ?? row.sortOrder,
      });
    } catch (e: any) { throw new BadRequestException(e?.message); }
    await this.fieldDefs.update({ id, tenantId }, {
      label: def.label, type: def.type, required: def.required,
      options: def.options, sortOrder: def.sortOrder,
    });
    return { id: Number(id), ...def };
  }

  async setFieldDefActive(tenantId: number, id: number, active: boolean) {
    const row = await this.fieldDefs.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('字段定义不存在');
    await this.fieldDefs.update({ id, tenantId }, { active });
    return { id: Number(id), active };
  }

  /**
   * 批量绑定标签模板：支持「指定 ID / 按类别 / 只看未绑定」三种范围组合。
   * 至少给一个范围条件，禁止无条件全表更新（几千条商品误绑是灾难）。
   */
  async bindMaterialTemplate(
    tenantId: number,
    args: {
      materialIds?: number[]; category?: string; groupId?: number;
      onlyUnbound?: boolean; templateId: number | null;
    },
  ) {
    const ids = Array.isArray(args.materialIds) ? args.materialIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    const category = String(args.category ?? '').trim();
    const groupId = args.groupId ? Number(args.groupId) : null;
    if (!ids.length && !category && !groupId && !args.onlyUnbound) {
      throw new BadRequestException('请指定绑定范围：选中产品、产品分组、产品类别或仅未绑定产品');
    }
    const templateId = await this.templateFor(tenantId, args.templateId);
    if (groupId) await this.groupFor(tenantId, groupId);
    const qb = this.materials.createQueryBuilder()
      .update(Material)
      .set({ templateId })
      .where('tenant_id = :tid', { tid: tenantId });
    if (ids.length) qb.andWhere('id IN (:...ids)', { ids });
    if (category) qb.andWhere('category = :cat', { cat: category });
    if (groupId) qb.andWhere('group_id = :gid', { gid: groupId });
    if (args.onlyUnbound) qb.andWhere('template_id IS NULL');
    const r = await qb.execute();
    return {
      updated: r.affected ?? 0,
      templateId,
      scope: {
        materialIds: ids.length, category: category || null,
        groupId, onlyUnbound: !!args.onlyUnbound,
      },
    };
  }

  // ------------------------------------------------------------- 产品分组维护

  async listGroups(tenantId: number, type?: string, includeInactive = false) {
    const qb = this.groups.createQueryBuilder('g').where('g.tenant_id = :tid', { tid: tenantId });
    if (!includeInactive) qb.andWhere('g.active = true');
    if (type && ['brand', 'supplier', 'custom'].includes(type)) qb.andWhere('g.type = :type', { type });
    const rows = await qb.select('g.id', 'id').addSelect('g.code', 'code').addSelect('g.name', 'name')
      .addSelect('g.type', 'type').addSelect('g.active', 'active')
      .addSelect('g.default_warehouse_id', 'defaultWarehouseId')
      .addSelect('g.default_location_id', 'defaultLocationId')
      .orderBy('g.type', 'ASC').addOrderBy('g.code', 'ASC').getRawMany();
    return rows.map((r) => ({
      ...r, id: Number(r.id),
      defaultWarehouseId: r.defaultWarehouseId == null ? null : Number(r.defaultWarehouseId),
      defaultLocationId: r.defaultLocationId == null ? null : Number(r.defaultLocationId),
    }));
  }

  async createGroup(tenantId: number, b: {
    code: string; name: string; type?: string;
    defaultWarehouseId?: number | null; defaultLocationId?: number | null;
  }) {
    const code = String(b.code ?? '').trim();
    if (!code || !String(b.name ?? '').trim()) throw new BadRequestException('分组编码与名称必填');
    if (await this.groups.findOne({ where: { tenantId, code } })) {
      throw new BadRequestException(`分组编码已存在：${code}`);
    }
    const type = ['brand', 'supplier', 'custom'].includes(String(b.type)) ? b.type! : 'custom';
    const def = await this.defaultLocationPair(tenantId, b.defaultWarehouseId, b.defaultLocationId);
    const row = await this.groups.save(this.groups.create({
      tenantId, code, name: String(b.name).trim(), type: type as ProductGroup['type'],
      defaultWarehouseId: def.warehouseId, defaultLocationId: def.locationId,
    }));
    return { ...row, id: Number(row.id) };
  }

  async updateGroup(tenantId: number, id: number, b: {
    name?: string; type?: string; defaultWarehouseId?: number | null; defaultLocationId?: number | null;
  }) {
    const row = await this.groups.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('产品分组不存在');
    const patch: any = {};
    if (b.name !== undefined) patch.name = String(b.name).trim();
    if (b.type !== undefined && ['brand', 'supplier', 'custom'].includes(b.type)) patch.type = b.type;
    if (b.defaultWarehouseId !== undefined || b.defaultLocationId !== undefined) {
      const changed = b.defaultWarehouseId !== undefined
        && Number(b.defaultWarehouseId) !== row.defaultWarehouseId;
      const def = await this.defaultLocationPair(
        tenantId,
        b.defaultWarehouseId !== undefined ? b.defaultWarehouseId : row.defaultWarehouseId,
        b.defaultLocationId !== undefined ? b.defaultLocationId : (changed ? null : row.defaultLocationId),
      );
      patch.defaultWarehouseId = def.warehouseId;
      patch.defaultLocationId = def.locationId;
    }
    await this.groups.update({ id, tenantId }, patch);
    return this.groups.findOne({ where: { tenantId, id } });
  }

  async setGroupActive(tenantId: number, id: number, active: boolean) {
    const row = await this.groups.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('产品分组不存在');
    if (!active) {
      const used = await this.materials.count({ where: { tenantId, groupId: id } });
      if (used) throw new BadRequestException(`该分组仍被 ${used} 个产品使用，不能停用`);
    }
    await this.groups.update({ id, tenantId }, { active });
    return { id, active };
  }

  /** 产品类别清单（分组绑定的下拉来源） */
  async listMaterialCategories(tenantId: number): Promise<string[]> {
    const rows = await this.materials.createQueryBuilder('m')
      .where('m.tenant_id = :tid', { tid: tenantId })
      .andWhere("m.category IS NOT NULL AND m.category <> ''")
      .select('DISTINCT m.category', 'category')
      .orderBy('category', 'ASC').getRawMany();
    return rows.map((r: any) => String(r.category)).filter(Boolean);
  }

  /** 标签模板必须属于本租户；null = 解除绑定 */
  private async templateFor(tenantId: number, ref?: number | null): Promise<number | null> {
    if (ref == null) return null;
    const id = Number(ref);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('标签模板参数无效或需解除绑定');
    const tpl = await this.templates.findOne({ where: { id, tenantId } });
    if (!tpl) throw new BadRequestException('标签模板不存在');
    return id;
  }

  /** 分组 / 打印机也必须属于本租户；null 表示清空 */
  private async groupFor(tenantId: number, ref?: number | null): Promise<number | null> {
    if (ref == null) return null;
    const id = Number(ref);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('产品分组参数无效');
    const g = await this.groups.findOne({ where: { tenantId, id, active: true } });
    if (!g) throw new BadRequestException('产品分组不存在或已停用');
    return id;
  }

  private async printerFor(tenantId: number, ref?: number | null): Promise<number | null> {
    if (ref == null) return null;
    const id = Number(ref);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('打印机参数无效');
    const p = await this.printers.findOne({ where: { tenantId, id } });
    if (!p) throw new BadRequestException('打印机不存在');
    return id;
  }

  /** 默认仓库/库位成对校验：换仓库自动清空库位，避免指向别的仓库 */
  private async defaultLocationPair(
    tenantId: number, warehouseRef?: number | null, locationRef?: number | null,
  ): Promise<{ warehouseId: number | null; locationId: number | null }> {
    let warehouseId = warehouseRef == null ? null : Number(warehouseRef);
    let locationId: number | null = null;
    if (locationRef != null) {
      const loc = await this.locations.findOne({
        where: { tenantId, id: Number(locationRef), active: true },
      });
      if (!loc) throw new BadRequestException('默认库位不存在或已停用');
      if (warehouseId == null) warehouseId = Number(loc.warehouseId);
      if (Number(loc.warehouseId) !== warehouseId) {
        throw new BadRequestException('默认库位不属于指定仓库');
      }
      locationId = Number(loc.id);
    }
    if (warehouseId != null) {
      const w = await this.warehouses.findOne({ where: { tenantId, id: warehouseId, active: true } });
      if (!w) throw new BadRequestException('默认仓库不存在或已停用');
    }
    return { warehouseId, locationId };
  }

  async createMaterial(tenantId: number, b: {
    code: string; name: string; spec?: string | null; unit?: string;
    category?: string | null; safetyStock?: number; templateId?: number | null;
    groupId?: number | null; autoPrint?: boolean; printerId?: number | null;
    defaultWarehouseId?: number | null; defaultLocationId?: number | null;
    customFields?: Record<string, unknown>;
  }) {
    const code = String(b.code ?? '').trim();
    if (!code || !String(b.name ?? '').trim()) throw new BadRequestException('编码与名称必填');
    if (await this.materials.findOne({ where: { tenantId, code } })) {
      throw new BadRequestException(`物料编码已存在：${code}`);
    }
    const templateId = await this.templateFor(tenantId, b.templateId);
    const groupId = await this.groupFor(tenantId, b.groupId);
    const printerId = await this.printerFor(tenantId, b.printerId);
    const autoPrint = !!b.autoPrint && templateId != null;
    const def = await this.defaultLocationPair(tenantId, b.defaultWarehouseId, b.defaultLocationId);
    const customFields = await this.normalizeValues(tenantId, b.customFields);
    const row = await this.materials.save(this.materials.create({
      tenantId, code, name: String(b.name).trim(),
      spec: b.spec?.trim() || null, unit: b.unit?.trim() || '件',
      category: b.category?.trim() || null,
      safetyStock: String(round3(Number(b.safetyStock) || 0)),
      templateId, groupId, autoPrint, printerId,
      defaultWarehouseId: def.warehouseId, defaultLocationId: def.locationId,
      customFields,
    }));
    return {
      ...row, id: Number(row.id), safetyStock: Number(row.safetyStock),
      templateId, groupId, printerId, autoPrint,
    };
  }

  async updateMaterial(tenantId: number, id: number, b: {
    name?: string; spec?: string | null; unit?: string; category?: string | null;
    safetyStock?: number; templateId?: number | null;
    groupId?: number | null; autoPrint?: boolean; printerId?: number | null;
    defaultWarehouseId?: number | null; defaultLocationId?: number | null;
    customFields?: Record<string, unknown>;
  }) {
    const row = await this.materials.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('物料不存在');
    const patch: any = {};
    if (b.name !== undefined) patch.name = String(b.name).trim();
    if (b.spec !== undefined) patch.spec = b.spec?.trim() || null;
    if (b.unit !== undefined) patch.unit = b.unit?.trim() || '件';
    if (b.category !== undefined) patch.category = b.category?.trim() || null;
    if (b.safetyStock !== undefined) patch.safetyStock = String(round3(Number(b.safetyStock) || 0));
    if (b.templateId !== undefined) patch.templateId = await this.templateFor(tenantId, b.templateId);
    if (b.groupId !== undefined) patch.groupId = await this.groupFor(tenantId, b.groupId);
    if (b.printerId !== undefined) patch.printerId = await this.printerFor(tenantId, b.printerId);
    if (b.autoPrint !== undefined) {
      const effectiveTpl = b.templateId !== undefined ? patch.templateId : row.templateId;
      // 没绑模板就不能开自动打印，避免入库时静默失败
      patch.autoPrint = b.autoPrint && effectiveTpl != null;
    }
    if (b.defaultWarehouseId !== undefined || b.defaultLocationId !== undefined) {
      const changedWarehouse = b.defaultWarehouseId !== undefined
        && Number(b.defaultWarehouseId) !== row.defaultWarehouseId;
      const def = await this.defaultLocationPair(
        tenantId,
        b.defaultWarehouseId !== undefined ? b.defaultWarehouseId : row.defaultWarehouseId,
        b.defaultLocationId !== undefined ? b.defaultLocationId : (changedWarehouse ? null : row.defaultLocationId),
      );
      patch.defaultWarehouseId = def.warehouseId;
      patch.defaultLocationId = def.locationId;
    }
    if (b.customFields !== undefined) {
      patch.customFields = await this.normalizeValues(tenantId, b.customFields);
    }
    await this.materials.update({ id, tenantId }, patch);
    return this.listMaterials(tenantId, row.code, 1).then((r) => r[0]);
  }

  /** 停用而非硬删：物料被库存批次 / BOM 引用时保留历史可追溯 */
  async setMaterialActive(tenantId: number, id: number, active: boolean) {
    const row = await this.materials.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('物料不存在');
    if (!active) {
      const batches = await this.batches.count({ where: { tenantId, materialId: id } });
      const boms = await this.boms.count({ where: { tenantId, productMaterialId: id } });
      const bomItems = await this.bomItems.createQueryBuilder('bi')
        .innerJoin(Bom, 'b', 'b.id = bi.bom_id')
        .where('b.tenant_id = :tid', { tid: tenantId }).andWhere('bi.material_id = :mid', { mid: id }).getCount();
      if (batches || boms || bomItems) {
        throw new BadRequestException(
          `该物料仍被引用（库存批次 ${batches}、BOM ${boms}、BOM 明细 ${bomItems}），不能停用`,
        );
      }
    }
    await this.materials.update({ id, tenantId }, { active });
    return { id, active };
  }

  /**
   * 入库后自动打印（产品开关 auto_print）。失败只告警、不回滚库存——
   * 标签没打出来可以补打，但收货数量不能因为打印机离线而丢失。
   */
  private async autoPrintAfterInbound(tenantId: number, m: Material, lines: StockMoveLine[]): Promise<void> {
    if (!m.autoPrint || m.templateId == null) return;
    try {
      let printerId = m.printerId == null ? null : Number(m.printerId);
      if (printerId == null) {
        const def = await this.printers.findOne({ where: { tenantId, isDefault: true } });
        printerId = def ? Number(def.id) : null;
      }
      const base = {
        code: m.code, sku: m.code, name: m.name,
        spec: m.spec ?? '', unit: m.unit, category: m.category ?? '',
        // 中文别名：模板里可直接写 {{产品编码}} / {{产品名称}} 等
        产品编码: m.code, 产品名称: m.name, 规格型号: m.spec ?? '',
        单位: m.unit, 产品类别: m.category ?? '',
      };
      const rows = lines.map((l) => ({
        ...base, batchNo: l.batchNo, batch: l.batchNo, qty: l.change,
        批次号: l.batchNo, 数量: l.change,
      }));
      await this.print.createJob({
        templateId: Number(m.templateId),
        printerId: printerId ?? undefined,
        rows, copies: 1,
        params: { source: 'auto-inbound', materialId: Number(m.id) },
      });
    } catch (e: any) {
      console.warn(`[auto-print] 产品 ${m.code} 入库后自动打印失败：${e?.message}`);
    }
  }

  /**
   * 产品绑定模板后一键打印：把产品/批次数据组装成数据行交给 PrintService，
   * 模板里的条码元素写 {{code}} / {{batchNo}} 即可逐行出签（与手工打印同一条链路）。
   */
  async printMaterial(
    tenantId: number, id: number,
    args: { printerId?: number; copies?: number; batchNos?: string[] },
  ) {
    const m = await this.materials.findOne({ where: { tenantId, id } });
    if (!m) throw new NotFoundException('产品资料不存在');
    if (m.templateId == null) {
      throw new BadRequestException('该产品尚未绑定标签模板，请先在产品资料里绑定');
    }
    const base = {
      code: m.code, sku: m.code, name: m.name, material: m.name,
      spec: m.spec ?? '', unit: m.unit, category: m.category ?? '',
      // 中文别名：模板里可直接写 {{产品编码}} / {{产品名称}} 等
      产品编码: m.code, 产品名称: m.name, 规格型号: m.spec ?? '',
      单位: m.unit, 产品类别: m.category ?? '',
      defaultWarehouseId: m.defaultWarehouseId, defaultLocationId: m.defaultLocationId,
      // 自定义字段：同时以字段标识和中文名暴露（模板写 {{field_key}} 或 {{中文名}} 均可）
      ...toPrintFields(await this.listFieldDefs(tenantId), parseJsonb(m.customFields)),
    };
    const batchNos = Array.isArray(args.batchNos) ? args.batchNos.filter(Boolean) : [];
    const rows: any[] = [];
    if (batchNos.length) {
      for (const bn of batchNos) {
        const b = await this.batches.findOne({ where: { tenantId, materialId: id, batchNo: String(bn) } });
        if (!b) throw new BadRequestException(`批次不存在：${bn}`);
        rows.push({
          ...base,
          batchNo: b.batchNo, batch: b.batchNo,
          producedAt: b.producedAt ?? '', expiresAt: b.expiresAt ?? '',
          qty: Number(b.qty),
          批次号: b.batchNo,
          生产日期: b.producedAt ?? '',
          到期日: b.expiresAt ?? '',
          库存数量: Number(b.qty),
        });
      }
    } else {
      rows.push(base);
    }
    const job = await this.print.createJob({
      templateId: Number(m.templateId), printerId: args.printerId, rows,
      copies: args.copies ?? 1, params: { source: 'material', materialId: id },
    });
    return { ...job, templateId: Number(m.templateId), labelRows: rows.length, product: base };
  }

  /** 仓库列表（维护页可看停用项） */
  async listWarehouses(tenantId: number, includeInactive = false) {
    const qb = this.warehouses.createQueryBuilder('w').where('w.tenant_id = :tid', { tid: tenantId });
    if (!includeInactive) qb.andWhere('w.active = true');
    const rows = await qb.select('w.id', 'id').addSelect('w.code', 'code').addSelect('w.name', 'name')
      .addSelect('w.active', 'active')
      .orderBy('w.id', 'ASC').getRawMany();
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  async createWarehouse(tenantId: number, b: { code: string; name: string }) {
    const code = String(b.code ?? '').trim();
    if (!code || !String(b.name ?? '').trim()) throw new BadRequestException('仓库编码与名称必填');
    if (await this.warehouses.findOne({ where: { tenantId, code } })) {
      throw new BadRequestException(`仓库编码已存在：${code}`);
    }
    const row = await this.warehouses.save(this.warehouses.create({
      tenantId, code, name: String(b.name).trim(),
    }));
    return { ...row, id: Number(row.id) };
  }

  async updateWarehouse(tenantId: number, id: number, b: { name?: string }) {
    const row = await this.warehouses.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('仓库不存在');
    if (b.name !== undefined) await this.warehouses.update({ id, tenantId }, { name: String(b.name).trim() });
    return this.warehouses.findOne({ where: { tenantId, id } });
  }

  async setWarehouseActive(tenantId: number, id: number, active: boolean) {
    const row = await this.warehouses.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('仓库不存在');
    if (!active) {
      const batches = await this.batches.count({ where: { tenantId, warehouseId: id } });
      if (batches) throw new BadRequestException(`该仓库仍有 ${batches} 个库存批次，不能停用`);
      // 联动：库位随仓库停用，产品/分组的默认位置引用一并清空
      await this.locations.update({ tenantId, warehouseId: id }, { active: false });
      await this.materials.createQueryBuilder().update(Material)
        .set({ defaultWarehouseId: null, defaultLocationId: null })
        .where(`tenant_id = :tid AND (default_warehouse_id = :id OR default_location_id IN (SELECT id FROM warehouse_locations WHERE tenant_id = :tid AND warehouse_id = :id))`, { tid: tenantId, id })
        .execute();
      await this.groups.createQueryBuilder().update(ProductGroup)
        .set({ defaultWarehouseId: null, defaultLocationId: null })
        .where(`tenant_id = :tid AND (default_warehouse_id = :id OR default_location_id IN (SELECT id FROM warehouse_locations WHERE tenant_id = :tid AND warehouse_id = :id))`, { tid: tenantId, id })
        .execute();
    }
    await this.warehouses.update({ id, tenantId }, { active });
    return { id, active };
  }

  /** 库位列表（可按仓库过滤） */
  async listLocations(tenantId: number, args: { warehouseId?: number; keyword?: string; includeInactive?: boolean } = {}) {
    const qb = this.locations.createQueryBuilder('l')
      .innerJoin(Warehouse, 'w', 'w.id = l.warehouse_id')
      .where('l.tenant_id = :tid', { tid: tenantId });
    if (!args.includeInactive) qb.andWhere('l.active = true');
    if (args.warehouseId) qb.andWhere('l.warehouse_id = :wid', { wid: Number(args.warehouseId) });
    if (args.keyword) {
      const kw = `%${escapeLike(args.keyword)}%`;
      qb.andWhere('(l.code ILIKE :kw OR l.name ILIKE :kw OR l.zone ILIKE :kw)', { kw });
    }
    const rows = await qb
      .select('l.id', 'id').addSelect('l.code', 'code').addSelect('l.name', 'name')
      .addSelect('l.zone', 'zone').addSelect('l.active', 'active')
      .addSelect('l.warehouse_id', 'warehouseId').addSelect('w.name', 'warehouse')
      .orderBy('w.id', 'ASC').addOrderBy('l.code', 'ASC').getRawMany();
    return rows.map((r) => ({ ...r, id: Number(r.id), warehouseId: Number(r.warehouseId) }));
  }

  async createLocation(tenantId: number, b: {
    warehouseId: number; code: string; name: string; zone?: string | null;
  }) {
    const wid = Number(b.warehouseId);
    const warehouse = await this.warehouses.findOne({ where: { tenantId, id: wid, active: true } });
    if (!warehouse) throw new BadRequestException('仓库不存在或已停用');
    const code = String(b.code ?? '').trim();
    if (!code || !String(b.name ?? '').trim()) throw new BadRequestException('库位编码与名称必填');
    if (await this.locations.findOne({ where: { tenantId, warehouseId: wid, code } })) {
      throw new BadRequestException(`该仓库下库位编码已存在：${code}`);
    }
    const row = await this.locations.save(this.locations.create({
      tenantId, warehouseId: wid, code, name: String(b.name).trim(), zone: b.zone?.trim() || null,
    }));
    return { ...row, id: Number(row.id), warehouseId: wid };
  }

  async updateLocation(tenantId: number, id: number, b: { name?: string; zone?: string | null }) {
    const row = await this.locations.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('库位不存在');
    const patch: any = {};
    if (b.name !== undefined) patch.name = String(b.name).trim();
    if (b.zone !== undefined) patch.zone = b.zone?.trim() || null;
    await this.locations.update({ id, tenantId }, patch);
    const all = await this.listLocations(tenantId, { includeInactive: true });
    return all.find((x) => x.id === id);
  }

  async setLocationActive(tenantId: number, id: number, active: boolean) {
    const row = await this.locations.findOne({ where: { tenantId, id } });
    if (!row) throw new NotFoundException('库位不存在');
    if (!active) {
      const used = await this.batches.count({ where: { tenantId, locationId: id } });
      if (used) throw new BadRequestException(`该库位仍被 ${used} 个库存批次使用，不能停用`);
      // 联动：产品和分组若以此库位为默认，自动回落为「仅仓库」
      await this.materials.createQueryBuilder().update(Material)
        .set({ defaultLocationId: null })
        .where('tenant_id = :tid AND default_location_id = :id', { tid: tenantId, id }).execute();
      await this.groups.createQueryBuilder().update(ProductGroup)
        .set({ defaultLocationId: null })
        .where('tenant_id = :tid AND default_location_id = :id', { tid: tenantId, id }).execute();
    }
    await this.locations.update({ id, tenantId }, { active });
    return { id, active };
  }

  // 公共 WHERE 片段：keyword 模糊 + warehouse（名称/编码模糊，纯数字按 ID）
  private applyFilters(qb: any, args: { keyword?: string; warehouse?: string }) {
    if (args.keyword) {
      const kw = `%${escapeLike(args.keyword)}%`;
      qb.andWhere('(m.name ILIKE :kw OR m.code ILIKE :kw OR m.spec ILIKE :kw)', { kw });
    }
    if (args.warehouse) {
      const w = String(args.warehouse).trim();
      if (/^\d+$/.test(w)) {
        qb.andWhere('w.id = :wid', { wid: Number(w) });
      } else {
        const wl = `%${escapeLike(w)}%`;
        qb.andWhere('(w.name ILIKE :wl OR w.code ILIKE :wl)', { wl });
      }
    }
    return qb;
  }

  /** 多维度库存查询（group_by = sku | batch | warehouse） */
  async queryStock(tenantId: number, args: QueryStockArgs = {}): Promise<{ items: StockRow[]; groupBy: string; total: number }> {
    const groupBy = ['sku', 'batch', 'warehouse'].includes(String(args.groupBy)) ? args.groupBy! : 'sku';
    const limit = this.clampLimit(args.limit);

    if (groupBy === 'batch') {
      const qb = this.batches.createQueryBuilder('sb')
        .innerJoin(Material, 'm', 'm.id = sb.material_id')
        .innerJoin(Warehouse, 'w', 'w.id = sb.warehouse_id')
        .where('sb.tenant_id = :tid', { tid: tenantId })
        .andWhere('m.active = true');
      this.applyFilters(qb, args);
      if (args.expiringDays) {
        qb.andWhere('sb.expires_at IS NOT NULL AND sb.expires_at <= current_date + (:days)::int', { days: this.clampDays(args.expiringDays) });
      }
      const rows = await qb
        .select('sb.material_id', 'materialId').addSelect('m.code', 'code').addSelect('m.name', 'name')
        .addSelect('m.spec', 'spec').addSelect('m.unit', 'unit')
        .addSelect('w.id', 'warehouseId').addSelect('w.name', 'warehouse').addSelect('sb.batch_no', 'batchNo')
        .addSelect('to_char(sb.expires_at, \'YYYY-MM-DD\')', 'expiresAt')
        .addSelect('sb.qty', 'qty').addSelect('m.safety_stock', 'safetyStock')
        .orderBy('sb.expires_at', 'ASC', 'NULLS LAST').addOrderBy('sb.id', 'ASC')
        .limit(limit)
        .getRawMany();
      const items = rows.map((r) => ({
        ...r,
        materialId: Number(r.materialId), warehouseId: Number(r.warehouseId),
        qty: Number(r.qty), safetyStock: Number(r.safetyStock ?? 0),
      }));
      return { items, groupBy, total: items.length };
    }

    if (groupBy === 'warehouse') {
      const qb = this.batches.createQueryBuilder('sb')
        .innerJoin(Material, 'm', 'm.id = sb.material_id')
        .innerJoin(Warehouse, 'w', 'w.id = sb.warehouse_id')
        .where('sb.tenant_id = :tid', { tid: tenantId })
        .andWhere('m.active = true');
      this.applyFilters(qb, args);
      const rows = await qb
        .select('w.id', 'warehouseId').addSelect('w.name', 'warehouse')
        .addSelect('m.id', 'materialId').addSelect('m.code', 'code').addSelect('m.name', 'name')
        .addSelect('m.unit', 'unit')
        .addSelect('SUM(sb.qty)', 'qty')
        .groupBy('w.id').addGroupBy('w.name').addGroupBy('m.id').addGroupBy('m.code')
        .addGroupBy('m.name').addGroupBy('m.unit')
        .orderBy('w.id', 'ASC').addOrderBy('m.code', 'ASC')
        .limit(limit)
        .getRawMany();
      const items = rows.map((r) => ({ ...r, materialId: Number(r.materialId), warehouseId: Number(r.warehouseId), qty: Number(r.qty) }));
      return { items, groupBy, total: items.length };
    }

    // 默认 sku：按物料汇总；below_safety 只看低于安全库存的行
    const qb = this.batches.createQueryBuilder('sb')
      .innerJoin(Material, 'm', 'm.id = sb.material_id')
      .innerJoin(Warehouse, 'w', 'w.id = sb.warehouse_id')
      .where('sb.tenant_id = :tid', { tid: tenantId })
      .andWhere('m.active = true');
    this.applyFilters(qb, args);
    if (args.expiringDays) {
      // sku 维度下 expiring_days 先收敛批次再汇总
      qb.andWhere('sb.expires_at IS NOT NULL AND sb.expires_at <= current_date + (:days)::int', { days: this.clampDays(args.expiringDays) });
    }
    if (args.belowSafety) {
      qb.having('SUM(sb.qty) < MAX(m.safety_stock)');
    }
    const rows = await qb
      .select('m.id', 'materialId').addSelect('m.code', 'code').addSelect('m.name', 'name')
      .addSelect('m.spec', 'spec').addSelect('m.unit', 'unit')
      .addSelect('SUM(sb.qty)', 'qty').addSelect('MAX(m.safety_stock)', 'safetyStock')
      .groupBy('m.id').addGroupBy('m.code').addGroupBy('m.name').addGroupBy('m.spec').addGroupBy('m.unit')
      .orderBy('m.code', 'ASC')
      .limit(limit)
      .getRawMany();
    const items = rows.map((r) => {
      const qty = Number(r.qty); const safety = Number(r.safetyStock ?? 0);
      return { ...r, materialId: Number(r.materialId), qty, safetyStock: safety, belowSafety: qty < safety };
    });
    return { items, groupBy: 'sku', total: items.length };
  }

  /** 低于安全库存清单（sku 维度，含缺口） */
  async listLowStock(tenantId: number, args: { keyword?: string; limit?: number } = {}): Promise<{ items: Array<StockRow & { gap: number }>; total: number }> {
    const limit = this.clampLimit(args.limit);
    const qb = this.materials.createQueryBuilder('m')
      .leftJoin(StockBatch, 'sb', 'sb.material_id = m.id AND sb.tenant_id = m.tenant_id')
      .where('m.tenant_id = :tid', { tid: tenantId })
      .andWhere('m.active = true')
      .andWhere('m.safety_stock > 0');
    if (args.keyword) {
      const kw = `%${escapeLike(args.keyword)}%`;
      qb.andWhere('(m.name ILIKE :kw OR m.code ILIKE :kw)', { kw });
    }
    const rows = await qb
      .select('m.id', 'materialId').addSelect('m.code', 'code').addSelect('m.name', 'name')
      .addSelect('m.spec', 'spec').addSelect('m.unit', 'unit').addSelect('m.safety_stock', 'safetyStock')
      .addSelect('COALESCE(SUM(sb.qty), 0)', 'qty')
      .groupBy('m.id').addGroupBy('m.code').addGroupBy('m.name').addGroupBy('m.spec').addGroupBy('m.unit').addGroupBy('m.safety_stock')
      .having('COALESCE(SUM(sb.qty), 0) < m.safety_stock')
      .orderBy('m.code', 'ASC')
      .limit(limit)
      .getRawMany();
    const items = rows.map((r) => {
      const qty = Number(r.qty); const safety = Number(r.safetyStock);
      return { ...r, materialId: Number(r.materialId), qty, safetyStock: safety, gap: round3(Math.max(0, safety - qty)) };
    });
    return { items, total: items.length };
  }

  /** 批次列表（sku 明细视角，按到期升序） */
  async listBatches(tenantId: number, args: { keyword?: string; warehouse?: string; limit?: number } = {}) {
    const res = await this.queryStock(tenantId, { ...args, groupBy: 'batch' });
    return res;
  }

  /** 临期批次（默认 30 天内到期） */
  async listExpiring(tenantId: number, args: { days?: number; warehouse?: string; keyword?: string; limit?: number } = {}) {
    return this.queryStock(tenantId, {
      keyword: args.keyword, warehouse: args.warehouse, limit: args.limit,
      groupBy: 'batch', expiringDays: this.clampDays(args.days),
    });
  }

  /** 按编码或名称定位物料（业务标识优先，§11.7.4）；找不到 404 */
  async findMaterial(tenantId: number, ref: string): Promise<Material> {
    const q = String(ref ?? '').trim();
    if (!q) throw new BadRequestException('product/sku 不能为空');
    const byCode = await this.materials.findOne({ where: { tenantId, code: q } });
    if (byCode) return byCode;
    const row = await this.materials.createQueryBuilder('m')
      .where('m.tenant_id = :tid', { tid: tenantId })
      .andWhere('(m.name ILIKE :kw OR m.code ILIKE :kw)', { kw: `%${escapeLike(q)}%` })
      .orderBy('m.id', 'ASC').limit(1).getOne();
    if (!row) throw new NotFoundException(`物料不存在：${q}`);
    return row;
  }

  /** 某物料当前库存快照（resources 用） */
  async materialSnapshot(tenantId: number, ref: string) {
    const m = /^\d+$/.test(String(ref)) && !q_is_code(ref)
      ? await this.materials.findOne({ where: { tenantId, id: Number(ref) } }).then((r) => r ?? this.findMaterial(tenantId, ref))
      : await this.findMaterial(tenantId, ref);
    const stock = await this.queryStock(tenantId, { keyword: m.code, groupBy: 'batch', limit: 100 });
    return {
      material: {
        id: m.id, code: m.code, name: m.name, spec: m.spec, unit: m.unit,
        category: m.category, safetyStock: Number(m.safetyStock),
      },
      batches: stock.items,
      total: round3(stock.items.reduce((s: number, r) => s + Number(r.qty), 0)),
    };
  }

  /**
   * 齐套/缺料计算（§11.7.2 bom.check_kit_rate / explain_shortage）。
   * 无 BOM → 404（NotFoundException，不暴露其它租户信息）。
   */
  async checkKit(tenantId: number, args: { product: string; demand: number; warehouse?: string }): Promise<{ product: Material; bom: Bom; kit: KitOutcome }> {
    const product = await this.findMaterial(tenantId, args.product);
    const demand = Math.floor(Number(args.demand));
    if (!Number.isFinite(demand) || demand < 1) throw new BadRequestException('demand 必须是 ≥1 的整数');
    const bom = await this.boms.findOne({ where: { tenantId, productMaterialId: product.id, status: 'active' } });
    if (!bom) throw new NotFoundException(`产品「${product.name}」没有启用中的 BOM`);
    const items = await this.bomItems.find({ where: { bomId: bom.id } });
    if (!items.length) {
      // BOM 存在但没有行：视为 0 行齐套（空数据 → 友好摘要路径的一部分）
      return { product, bom, kit: computeKit([], demand) };
    }
    const matIds = items.map((i) => Number(i.materialId));
    const mats = await this.materials.createQueryBuilder('m')
      .where('m.tenant_id = :tid', { tid: tenantId }).andWhere('m.id IN (:...ids)', { ids: matIds })
      .getMany();
    const matById = new Map(mats.map((m) => [Number(m.id), m]));

    // 可用库存：按物料（可选仓库过滤）一次聚合
    const availQb = this.ds.createQueryBuilder()
      .select('sb.material_id', 'materialId')
      .addSelect('COALESCE(SUM(sb.qty), 0)', 'avail')
      .from('stock_batches', 'sb')
      .innerJoin('warehouses', 'w', 'w.id = sb.warehouse_id')
      .where('sb.tenant_id = :tid', { tid: tenantId })
      .andWhere('sb.material_id IN (:...ids)', { ids: matIds });
    if (args.warehouse) {
      const w = String(args.warehouse).trim();
      if (/^\d+$/.test(w)) availQb.andWhere('w.id = :wid', { wid: Number(w) });
      else {
        const wl = `%${escapeLike(w)}%`;
        availQb.andWhere('(w.name ILIKE :wl OR w.code ILIKE :wl)', { wl });
      }
    }
    availQb.groupBy('sb.material_id');
    const availRows: Array<{ materialId: string; avail: string }> = await availQb.getRawMany();
    const avail = new Map(availRows.map((r) => [Number(r.materialId), Number(r.avail)]));

    const lines = items.flatMap((i) => {
      const m = matById.get(Number(i.materialId));
      if (!m) return []; // 物料被物理删除时跳过（防御）
      return [{
        materialId: Number(i.materialId), code: m.code, name: m.name, unit: m.unit,
        qtyPer: Number(i.qtyPer), lossRate: Number(i.lossRate), available: avail.get(Number(i.materialId)) ?? 0,
      }];
    });
    return { product, bom, kit: computeKit(lines, demand) };
  }

  // ------------------------------------------------------------------ BOM 维护（P6 齐套率模块）
  // BOM 实体只有编码/版本/状态，没有独立 name；明细行 material_id 指向物料。
  // 约束：同一产品最多一个 active BOM（启用新的会把旧的降为 inactive）。

  /** 把 BOM 实体 + 明细行装配成前端视图；物料被删时跳过对应行（防御） */
  private async bomViews(tenantId: number, bomRows: Bom[]): Promise<BomView[]> {
    if (!bomRows.length) return [];
    const bomIds = bomRows.map((b) => Number(b.id));
    const items = await this.bomItems.createQueryBuilder('bi')
      .where('bi.bom_id IN (:...ids)', { ids: bomIds })
      .getMany();
    const matIds = Array.from(new Set([
      ...bomRows.map((b) => Number(b.productMaterialId)),
      ...items.map((i) => Number(i.materialId)),
    ]));
    const mats = matIds.length
      ? await this.materials.createQueryBuilder('m')
          .where('m.tenant_id = :tid', { tid: tenantId })
          .andWhere('m.id IN (:...ids)', { ids: matIds })
          .getMany()
      : [];
    const matById = new Map(mats.map((m) => [Number(m.id), m]));
    const linesByBom = new Map<number, BomLineView[]>();
    for (const it of items) {
      const m = matById.get(Number(it.materialId));
      if (!m) continue;
      const arr = linesByBom.get(Number(it.bomId)) ?? [];
      arr.push({
        id: Number(it.id), materialId: Number(it.materialId),
        code: m.code, name: m.name, unit: m.unit,
        qtyPer: Number(it.qtyPer), lossRate: Number(it.lossRate),
      });
      linesByBom.set(Number(it.bomId), arr);
    }
    return bomRows.map((b) => {
      const pm = matById.get(Number(b.productMaterialId));
      return {
        id: Number(b.id), productMaterialId: Number(b.productMaterialId),
        productCode: pm?.code ?? '', productName: pm?.name ?? '',
        version: b.version, status: b.status as BomStatus,
        createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt),
        lines: linesByBom.get(Number(b.id)) ?? [],
      };
    });
  }

  /** BOM 列表（可按产品过滤），最多 100 条 */
  async listBoms(tenantId: number, product?: string): Promise<BomView[]> {
    const qb = this.boms.createQueryBuilder('b')
      .where('b.tenant_id = :tid', { tid: tenantId });
    if (product?.trim()) {
      const m = await this.findMaterial(tenantId, product);
      qb.andWhere('b.product_material_id = :pid', { pid: m.id });
    }
    const rows = await qb.orderBy('b.id', 'DESC').limit(100).getMany();
    return this.bomViews(tenantId, rows);
  }

  /** BOM 详情（含明细行） */
  async getBom(tenantId: number, bomId: number): Promise<BomView> {
    const row = await this.boms.findOne({ where: { id: bomId, tenantId } });
    if (!row) throw new NotFoundException(`BOM #${bomId} 不存在`);
    return (await this.bomViews(tenantId, [row]))[0];
  }

  /** 新建/更新 BOM，明细行全量替换。启用时同产品其它 BOM 自动降为 inactive。 */
  async saveBom(tenantId: number, input: SaveBomInput): Promise<BomView> {
    const product = await this.findMaterial(tenantId, input.product);
    const lines = await Promise.all((input.items ?? []).map(async (it) => {
      const m = await this.findMaterial(tenantId, String(it.material));
      return {
        materialId: Number(m.id),
        qtyPer: Number(it.qtyPer),
        lossRate: Number(it.lossRate ?? 0),
      };
    }));
    if (new Set(lines.map((l) => l.materialId)).size !== lines.length) {
      throw new BadRequestException('BOM 明细存在重复物料');
    }
    const status: BomStatus = input.status === 'active' ? 'active'
      : input.status === 'inactive' ? 'inactive' : 'draft';

    let bom: Bom;
    if (input.id) {
      const existing = await this.boms.findOne({ where: { id: input.id, tenantId } });
      if (!existing) throw new NotFoundException(`BOM #${input.id} 不存在`);
      existing.productMaterialId = product.id;
      existing.version = input.version?.trim() || existing.version;
      existing.status = status;
      bom = await this.boms.save(existing);
    } else {
      bom = await this.boms.save(this.boms.create({
        tenantId, productMaterialId: product.id,
        version: input.version?.trim() || 'v1', status,
      }));
    }
    if (status === 'active') {
      await this.boms.createQueryBuilder()
        .update()
        .set({ status: 'inactive' })
        .where('tenant_id = :tid', { tid: tenantId })
        .andWhere('product_material_id = :pid', { pid: product.id })
        .andWhere('id <> :id', { id: bom.id })
        .execute();
    }
    // 明细全量替换：先删后插（BOM 已校验属本租户）
    await this.bomItems.delete({ bomId: bom.id });
    if (lines.length) {
      await this.bomItems.save(lines.map((l) => this.bomItems.create({
        bomId: bom.id, materialId: l.materialId,
        qtyPer: String(l.qtyPer), lossRate: String(l.lossRate),
      })));
    }
    return this.getBom(tenantId, Number(bom.id));
  }

  /** 启停 BOM：启用时同产品其它 BOM 降为 inactive */
  async setBomStatus(tenantId: number, bomId: number, status: BomStatus): Promise<BomView> {
    const bom = await this.boms.findOne({ where: { id: bomId, tenantId } });
    if (!bom) throw new NotFoundException(`BOM #${bomId} 不存在`);
    const next: BomStatus = status === 'active' || status === 'draft' ? status : 'inactive';
    if (next === 'active') {
      await this.boms.createQueryBuilder()
        .update()
        .set({ status: 'inactive' })
        .where('tenant_id = :tid', { tid: tenantId })
        .andWhere('product_material_id = :pid', { pid: bom.productMaterialId })
        .andWhere('id <> :id', { id: bomId })
        .execute();
    }
    bom.status = next;
    await this.boms.save(bom);
    return this.getBom(tenantId, bomId);
  }

  /** 删除 BOM：启用中的不允许删，需先停用；明细一并删除 */
  async deleteBom(tenantId: number, bomId: number): Promise<{ id: number }> {
    const bom = await this.boms.findOne({ where: { id: bomId, tenantId } });
    if (!bom) throw new NotFoundException(`BOM #${bomId} 不存在`);
    if (bom.status === 'active') {
      throw new BadRequestException('启用中的 BOM 不能删除，请先停用');
    }
    await this.bomItems.delete({ bomId });
    await this.boms.delete({ id: bomId, tenantId });
    return { id: bomId };
  }

  // ------------------------------------------------------------------ P5 写路径
  // docs/11 §11.7.2 把 inventory.adjust / inventory.transfer 定为「高危」工具：
  // 执行器只提供原子操作本身，审批（§11.7.6）与幂等（§11.7.4）由 Agent dispatch 层负责，
  // 这样同一套写路径将来也能直接给租户侧库存 REST 页面复用（P6）。

  /** 仓库定位：编码精确 → 数字 ID → 名称/编码模糊（与 findMaterial 同口径） */
  async findWarehouse(tenantId: number, ref: unknown): Promise<Warehouse> {
    const q = String(ref ?? '').trim();
    if (!q) throw new BadRequestException('warehouse 不能为空');
    const byCode = await this.warehouses.findOne({ where: { tenantId, code: q } });
    if (byCode) return byCode;
    if (/^\d+$/.test(q)) {
      const byId = await this.warehouses.findOne({ where: { tenantId, id: Number(q) } });
      if (byId) return byId;
    }
    const row = await this.warehouses.createQueryBuilder('w')
      .where('w.tenant_id = :tid', { tid: tenantId })
      .andWhere('(w.name ILIKE :kw OR w.code ILIKE :kw)', { kw: `%${escapeLike(q)}%` })
      .orderBy('w.id', 'ASC').limit(1).getOne();
    if (!row) throw new NotFoundException(`仓库不存在：${q}`);
    return row;
  }

  /** 库位合法性：必须属于指定仓库且处于启用状态，防止跨仓库位串货 */
  private async locationFor(tenantId: number, warehouseId: number, ref?: number | string | null): Promise<number | null> {
    if (ref == null || ref === '') return null;
    const id = Number(ref);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('库位参数无效');
    const loc = await this.locations.findOne({ where: { tenantId, id, warehouseId, active: true } });
    if (!loc) throw new BadRequestException(`库位不存在或不属于该仓库：${id}`);
    return id;
  }

  /** 出库批次排序：先到期先出（NULLS LAST 由 Postgres ASC 默认保证），再按生产日期、再按 ID */
  private fifoQb(tenantId: number, materialId: number, warehouseId: number, locationId?: number | null) {
    const qb = this.batches.createQueryBuilder('sb')
      .where('sb.tenant_id = :tid', { tid: tenantId })
      .andWhere('sb.material_id = :mid', { mid: materialId })
      .andWhere('sb.warehouse_id = :wid', { wid: warehouseId })
      .andWhere('sb.qty > 0');
    if (locationId != null) qb.andWhere('sb.location_id = :loc', { loc: Number(locationId) });
    return qb
      .orderBy('sb.expires_at', 'ASC')
      .addOrderBy('sb.produced_at', 'ASC')
      .addOrderBy('sb.id', 'ASC');
  }

  /**
   * 解析入库位置：请求指定 > 产品默认 > 分组默认 > 系统首个启用仓库。
   * 库位必须与最终仓库匹配，避免产品默认库位指向旧仓库后串货。
   */
  private async resolveStockLocation(
    tenantId: number, material: Material,
    requestedWarehouse?: string, requestedLocationId?: number | null,
  ): Promise<{ warehouse: Warehouse; locationId: number | null; source: string }> {
    let warehouse: Warehouse | null = null;
    let source = 'request';
    if (requestedWarehouse && String(requestedWarehouse).trim()) {
      warehouse = await this.findWarehouse(tenantId, requestedWarehouse);
    }
    if (!warehouse && material.defaultWarehouseId) {
      warehouse = await this.warehouses.findOne({
        where: { tenantId, id: material.defaultWarehouseId, active: true },
      });
      source = 'material';
    }
    if (!warehouse && material.groupId) {
      const g = await this.groups.findOne({ where: { tenantId, id: material.groupId } });
      if (g?.defaultWarehouseId) {
        warehouse = await this.warehouses.findOne({
          where: { tenantId, id: g.defaultWarehouseId, active: true },
        });
        source = 'group';
      }
    }
    if (!warehouse) {
      warehouse = await this.warehouses.findOne({ where: { tenantId, active: true }, order: { id: 'ASC' } });
      source = 'system';
    }
    if (!warehouse) throw new BadRequestException('没有可用仓库，请先在基础资料里创建仓库');

    let locationId: number | null = null;
    if (requestedLocationId != null) {
      locationId = await this.locationFor(tenantId, warehouse.id, requestedLocationId);
    } else {
      const candidates = [material.defaultLocationId];
      if (material.groupId) {
        const g = await this.groups.findOne({ where: { tenantId, id: material.groupId } });
        candidates.push(g?.defaultLocationId ?? null);
      }
      for (const candidate of candidates) {
        if (candidate == null) continue;
        const l = await this.locations.findOne({
          where: { tenantId, id: candidate, warehouseId: warehouse.id, active: true },
        });
        if (l) { locationId = Number(l.id); break; }
      }
    }
    return { warehouse, locationId, source };
  }

  /** 批量设置产品默认仓库/库位（按勾选产品，或整个分组） */
  async setDefaultLocation(tenantId: number, args: {
    materialIds?: number[]; groupId?: number; warehouseId?: number | null; locationId?: number | null;
  }) {
    const ids = Array.isArray(args.materialIds)
      ? args.materialIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    const groupId = args.groupId ? Number(args.groupId) : null;
    if (!ids.length && !groupId) throw new BadRequestException('请选择产品或产品分组');
    if (groupId) await this.groupFor(tenantId, groupId);

    let warehouseId: number | null = null;
    if (args.warehouseId != null) {
      const w = await this.warehouses.findOne({ where: { tenantId, id: Number(args.warehouseId), active: true } });
      if (!w) throw new BadRequestException('仓库不存在或已停用');
      warehouseId = Number(w.id);
    }
    let locationId: number | null = null;
    if (args.locationId != null && warehouseId != null) {
      locationId = await this.locationFor(tenantId, warehouseId, args.locationId);
    } else if (args.locationId != null) {
      throw new BadRequestException('设置库位时必须同时指定所属仓库');
    }

    const qb = this.materials.createQueryBuilder()
      .update(Material)
      .set({ defaultWarehouseId: warehouseId, defaultLocationId: locationId })
      .where('tenant_id = :tid', { tid: tenantId });
    if (ids.length) qb.andWhere('id IN (:...ids)', { ids });
    if (groupId) qb.andWhere('group_id = :gid', { gid: groupId });
    const r = await qb.execute();
    return { updated: r.affected ?? 0, warehouseId, locationId };
  }

  /**
   * 库存调整（§11.7.3 inventory.adjust）。
   * delta>0 入库：有 batch_no 就并入该批次，没有则生成 ADJ- 时间戳批次（保证批次可追溯，
   *   不把无主入库混进别人的批次）。
   * delta<0 出库：有 batch_no 只动该批次；没有则按 FIFO 跨批次扣减，不足则整笔拒绝（不做部分扣减）。
   * dryRun 只算不改，用于「高危可预演」。
   */
  async adjustStock(
    tenantId: number,
    args: { sku: string; warehouse?: string; batch_no?: string; delta: number; reason: string; location_id?: number | null },
    dryRun = false,
    operator = 'system',
  ): Promise<StockWriteOutcome> {
    const delta = round3(Number(args.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      throw new BadRequestException('delta 必须是非零数字（正数入库、负数出库）');
    }
    const reason = String(args.reason ?? '').trim();
    if (reason.length < 2) throw new BadRequestException('reason 必填（至少 2 个字符，调整要留痕）');
    const material = await this.findMaterial(tenantId, args.sku);
    const resolved = await this.resolveStockLocation(tenantId, material, args.warehouse, args.location_id);
    const warehouse = resolved.warehouse;
    const locationId = resolved.locationId;
    const batchNo = args.batch_no ? String(args.batch_no).trim() : '';

    if (batchNo) {
      const batch = await this.batches.findOne({
        where: { tenantId, materialId: material.id, warehouseId: warehouse.id, batchNo },
      });
      if (!batch) {
        if (delta < 0) throw new BadRequestException(`批次不存在，无法出库：${batchNo}（仓库 ${warehouse.name}）`);
        const created: StockMoveLine = {
          batchNo, change: delta, before: 0, after: delta, warehouse: warehouse.code, locationId,
        };
        if (!dryRun) {
          await this.ds.transaction(async (em) => {
            const repo = em.getRepository(StockBatch);
            await repo.save(repo.create({
              tenantId, materialId: material.id, warehouseId: warehouse.id,
              batchNo, qty: String(delta), locationId,
            }));
            await this.recordMoves(em, tenantId, 'in', material,
              [{ batchNo, warehouseId: Number(warehouse.id), qty: delta, before: 0, after: delta, locationId }], reason, operator);
          });
        }
        if (!dryRun) await this.autoPrintAfterInbound(tenantId, material, [created]);
        return this.outcome(material, warehouse, dryRun, delta, [created], `批次 ${batchNo} 新建`);
      }
      const before = Number(batch.qty);
      const after = round3(before + delta);
      if (after < -1e-9) {
        throw new BadRequestException(
          `库存不足：批次 ${batchNo} 现有 ${before}${material.unit}，本次需出 ${Math.abs(delta)}${material.unit}`,
        );
      }
      const lineLocation = locationId ?? batch.locationId ?? null;
      const line: StockMoveLine = { batchNo, change: delta, before, after, warehouse: warehouse.code, locationId: lineLocation };
      if (!dryRun) {
        await this.ds.transaction(async (em) => {
          // 入库指定库位时把批次归属一并更新；出库不改库位
          const patch: any = { qty: String(after) };
          if (delta > 0 && locationId != null) patch.locationId = locationId;
          await em.getRepository(StockBatch).update({ id: batch.id }, patch);
          await this.recordMoves(em, tenantId, delta > 0 ? 'in' : 'out', material,
            [{ batchNo, warehouseId: Number(warehouse.id), qty: delta, before, after, locationId: lineLocation }], reason, operator);
        });
      }
      if (!dryRun && delta > 0) await this.autoPrintAfterInbound(tenantId, material, [line]);
      return this.outcome(material, warehouse, dryRun, delta, [line]);
    }

    if (delta > 0) {
      const generated = `ADJ-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
      const line: StockMoveLine = {
        batchNo: generated, change: delta, before: 0, after: delta, warehouse: warehouse.code, locationId,
      };
      if (!dryRun) {
        await this.ds.transaction(async (em) => {
          const repo = em.getRepository(StockBatch);
          await repo.save(repo.create({
            tenantId, materialId: material.id, warehouseId: warehouse.id,
            batchNo: generated, qty: String(delta), locationId,
          }));
          await this.recordMoves(em, tenantId, 'in', material,
            [{ batchNo: generated, warehouseId: Number(warehouse.id), qty: delta, before: 0, after: delta, locationId }], reason, operator);
        });
      }
      if (!dryRun) await this.autoPrintAfterInbound(tenantId, material, [line]);
      return this.outcome(material, warehouse, dryRun, delta, [line], '未给批次号，按入库生成新批次');
    }

    // 出库 FIFO：先算计划，再在事务里加锁复核（并发下不能被别的调用扣成负数）
    const plan = await this.planFifo(tenantId, material, warehouse, Math.abs(delta), locationId);
    const lines: StockMoveLine[] = plan.map((p) => ({
      batchNo: p.batch.batchNo, change: -p.take, before: p.before, after: round3(p.before - p.take),
      warehouse: warehouse.code, locationId: p.batch.locationId ?? null,
    }));
    if (!dryRun) {
      await this.ds.transaction(async (em) => {
        const ids = plan.map((p) => Number(p.batch.id));
        const locked = await em.getRepository(StockBatch).find({ where: { id: In(ids) }, lock: { mode: 'pessimistic_write' } });
        const byId = new Map(locked.map((b) => [Number(b.id), b]));
        for (const p of plan) {
          const b = byId.get(Number(p.batch.id));
          if (!b) throw new BadRequestException(`批次 ${p.batch.batchNo} 已被删除，调整中止`);
          const now = round3(Number(b.qty));
          if (now + 1e-9 < p.take) {
            throw new BadRequestException(
              `并发冲突：批次 ${b.batchNo} 仅剩 ${now}${material.unit}，本次需出 ${p.take}${material.unit}，请重试`,
            );
          }
          await em.getRepository(StockBatch).update({ id: b.id }, { qty: String(round3(now - p.take)) });
        }
        await this.recordMoves(em, tenantId, 'out', material,
          plan.map((p) => ({
            batchNo: p.batch.batchNo, warehouseId: Number(warehouse.id), qty: -p.take,
            before: p.before, after: round3(p.before - p.take), locationId: p.batch.locationId ?? null,
          })), reason, operator);
      });
    }
    return this.outcome(material, warehouse, dryRun, delta, lines);
  }

  /**
   * 跨仓调拨（§11.7.2 inventory.transfer）。
   * 同批次号原样带过去（批次是追溯单位），目标仓没有该批次就按源批次属性新建一行。
   */
  async transferStock(
    tenantId: number,
    args: {
      sku: string; from_warehouse: string; to_warehouse: string; qty: number;
      batch_no?: string; reason?: string; from_location_id?: number | null; to_location_id?: number | null;
    },
    dryRun = false,
    operator = 'system',
  ): Promise<StockWriteOutcome> {
    const qty = round3(Number(args.qty));
    if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('qty 必须是正数');
    const material = await this.findMaterial(tenantId, args.sku);
    const from = await this.findWarehouse(tenantId, args.from_warehouse);
    const to = await this.findWarehouse(tenantId, args.to_warehouse);
    if (Number(from.id) === Number(to.id)) throw new BadRequestException('调拨的出入仓库不能相同');
    const fromLocationId = await this.locationFor(tenantId, from.id, args.from_location_id);
    const toLocationId = await this.locationFor(tenantId, to.id, args.to_location_id);
    const onlyBatch = args.batch_no ? String(args.batch_no).trim() : '';

    const candidates = onlyBatch
      ? [await this.batches.findOne({ where: { tenantId, materialId: material.id, warehouseId: from.id, batchNo: onlyBatch } })]
      : await this.fifoQb(tenantId, material.id, from.id, fromLocationId).getMany();
    const valid = candidates.filter((b): b is StockBatch => !!b);
    if (!valid.length) {
      throw new BadRequestException(
        `${from.name} 没有可调拨的「${material.name}」批次${onlyBatch ? `（批次 ${onlyBatch}）` : ''}`,
      );
    }
    const plan = onlyBatch
      ? this.allocate([{ batch: valid[0], before: Number(valid[0].qty) }], qty, material)
      : this.allocate(valid.map((b) => ({ batch: b, before: Number(b.qty) })), qty, material);

    const lines: StockMoveLine[] = [];
    for (const p of plan) {
      const srcLoc = p.batch.locationId ?? fromLocationId ?? null;
      lines.push({
        batchNo: p.batch.batchNo, change: -p.take, before: p.before, after: round3(p.before - p.take),
        warehouse: from.code, locationId: srcLoc,
      });
      const target = await this.batches.findOne({
        where: { tenantId, materialId: material.id, warehouseId: to.id, batchNo: p.batch.batchNo },
      });
      if (target) {
        const tb = Number(target.qty);
        lines.push({
          batchNo: p.batch.batchNo, change: p.take, before: tb, after: round3(tb + p.take),
          warehouse: to.code, locationId: toLocationId ?? target.locationId ?? null,
        });
      } else {
        lines.push({
          batchNo: p.batch.batchNo, change: p.take, before: 0, after: p.take,
          warehouse: to.code, locationId: toLocationId,
        });
      }
    }
    if (!dryRun) {
      await this.ds.transaction(async (em) => {
        const repo = em.getRepository(StockBatch);
        const ids = plan.map((p) => Number(p.batch.id));
        const locked = await repo.find({ where: { id: In(ids) }, lock: { mode: 'pessimistic_write' } });
        const byId = new Map(locked.map((b) => [Number(b.id), b]));
        const moveLines: MoveLine[] = [];
        for (const p of plan) {
          const b = byId.get(Number(p.batch.id));
          if (!b) throw new BadRequestException(`批次 ${p.batch.batchNo} 已被删除，调拨中止`);
          const now = round3(Number(b.qty));
          if (now + 1e-9 < p.take) {
            throw new BadRequestException(
              `并发冲突：${from.name} 的批次 ${b.batchNo} 仅剩 ${now}${material.unit}，本次需调 ${p.take}${material.unit}`,
            );
          }
          await repo.update({ id: b.id }, { qty: String(round3(now - p.take)) });
          moveLines.push({
            batchNo: b.batchNo, warehouseId: Number(from.id), qty: -p.take,
            before: now, after: round3(now - p.take), locationId: b.locationId ?? fromLocationId ?? null,
          });
          const target = await repo.findOne({
            where: { tenantId, materialId: material.id, warehouseId: to.id, batchNo: b.batchNo },
          });
          if (target) {
            const tb = Number(target.qty);
            const patch: any = { qty: String(round3(tb + p.take)) };
            if (toLocationId != null) patch.locationId = toLocationId;
            await repo.update({ id: target.id }, patch);
            moveLines.push({
              batchNo: b.batchNo, warehouseId: Number(to.id), qty: p.take,
              before: tb, after: round3(tb + p.take), locationId: toLocationId ?? target.locationId ?? null,
            });
          } else {
            await repo.save(repo.create({
              tenantId, materialId: material.id, warehouseId: to.id, batchNo: b.batchNo,
              qty: String(p.take), unitCostCents: b.unitCostCents, producedAt: b.producedAt, expiresAt: b.expiresAt,
              locationId: toLocationId,
            }));
            moveLines.push({
              batchNo: b.batchNo, warehouseId: Number(to.id), qty: p.take,
              before: 0, after: p.take, locationId: toLocationId,
            });
          }
        }
        const reason = String(args.reason ?? '').trim() || `调拨 ${from.name} → ${to.name}`;
        await this.recordMoves(em, tenantId, 'transfer', material, moveLines, reason, operator, Number(to.id));
      });
    }
    return this.outcome(material, from, dryRun, qty, lines, `调拨至 ${to.name}（${to.code}）`);
  }

  /** FIFO 出库计划（不足则抛错，带缺口数量） */
  private async planFifo(
    tenantId: number, material: Material, warehouse: Warehouse, need: number, locationId?: number | null,
  ) {
    const rows = await this.fifoQb(tenantId, material.id, warehouse.id, locationId).getMany();
    if (!rows.length) {
      throw new BadRequestException(
        `${warehouse.name}${locationId ? `（指定库位 ${locationId}）` : ''} 没有「${material.name}」的可出库批次`,
      );
    }
    return this.allocate(rows.map((b) => ({ batch: b, before: Number(b.qty) })), need, material, warehouse.name);
  }

  private allocate(
    source: Array<{ batch: StockBatch; before: number }>, need: number, material: Material, where = '',
  ): Array<{ batch: StockBatch; before: number; take: number }> {
    let left = round3(need);
    const out: Array<{ batch: StockBatch; before: number; take: number }> = [];
    for (const s of source) {
      if (left <= 1e-9) break;
      const take = round3(Math.min(left, Math.max(0, s.before)));
      if (take <= 0) continue;
      out.push({ ...s, take });
      left = round3(left - take);
    }
    if (left > 1e-9) {
      throw new BadRequestException(
        `库存不足${where ? `（${where}）` : ''}：「${material.name}」需 ${round3(need)}${material.unit}，`
        + `可用 ${round3(need - left)}${material.unit}，缺 ${round3(left)}${material.unit}`,
      );
    }
    return out;
  }

  private outcome(
    material: Material, warehouse: Warehouse, dryRun: boolean, change: number,
    lines: StockMoveLine[], note?: string,
  ): StockWriteOutcome {
    return {
      material: { id: Number(material.id), code: material.code, name: material.name, unit: material.unit },
      warehouse: { id: Number(warehouse.id), code: warehouse.code, name: warehouse.name },
      dryRun, change: round3(change), lines, note: note ?? null,
    };
  }
}

// resource id 判断辅助：stock 快照的 :id 既可能是物料数字 ID，也可能是编码（如 M-APPLE-ORG）
// '123' 这种纯数字串优先按 ID 找；找不到再按名称/编码模糊。抽成函数便于测试与阅读。
function q_is_code(ref: unknown): boolean {
  return /^[A-Za-z]/.test(String(ref ?? ''));
}

/** 台账单号：IN/OUT/TR + 秒级时间戳 + 短随机串（同一笔多行共用一个单号） */
function buildMoveNo(kind: 'in' | 'out' | 'transfer'): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const prefix = kind === 'transfer' ? 'TR' : kind.toUpperCase();
  return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}
