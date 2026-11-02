import { Module, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Controller, Get, Post, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { DataSource as DS, DataRow } from '../entities/print.entity';
import { TenantGuard } from '../common/tenant.guard';
import { useTenantId } from '../common/tenant.context';
import { AuditModule, AuditService } from '../audit/audit.module';

/**
 * 健壮 CSV 解析：支持引号包裹、引号内换行/逗号、"" 转义、CRLF，
 * 自动识别分隔符（逗号 / Tab / 分号）。
 */
export function parseCsv(text: string, delimiter?: string): { header: string[]; rows: string[][] } {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const delim = delimiter ?? detectDelimiter(raw);
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  // 丢弃完全空行
  const cleaned = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!cleaned.length) return { header: [], rows: [] };
  const header = cleaned[0].map((h) => h.trim());
  return { header, rows: cleaned.slice(1) };
}

function detectDelimiter(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
  const counts: Record<string, number> = {
    ',': (firstLine.match(/,/g) ?? []).length,
    '\t': (firstLine.match(/\t/g) ?? []).length,
    ';': (firstLine.match(/;/g) ?? []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

@Injectable()
export class DataSourceService {
  constructor(
    @InjectRepository(DS) private ds: Repository<DS>,
    @InjectRepository(DataRow) private rows: Repository<DataRow>,
    private audit: AuditService,
  ) {}

  list() {
    return this.ds.find({ where: { tenantId: useTenantId() }, order: { createdAt: 'DESC' } });
  }

  async get(id: number) {
    const s = await this.ds.findOne({ where: { id, tenantId: useTenantId() } });
    if (!s) throw new NotFoundException('数据源不存在');
    return s;
  }

  async remove(id: number) {
    await this.get(id);
    await this.rows.delete({ sourceId: id, tenantId: useTenantId() });
    await this.ds.delete({ id, tenantId: useTenantId() });
    await this.audit.write(useTenantId(), 'data_source.delete', { id }, undefined, 'data_source', id);
    return { ok: true };
  }

  /** 保存前端已解析的行（Excel/CSV/TSV/JSON 统一入口），并保留字段映射 */
  async saveRows(dto: { name?: string; type?: string; headers?: string[]; rows: any[]; fieldMap?: Record<string, string>; config?: any }) {
    const name = dto.name || `数据源 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const fieldMap = dto.fieldMap ?? {};
    // DB 约束只允许 csv/excel/sql；JSON/TSV 等导入来源统一归一为 csv，原始类型存 config
    const rawType = String(dto.type ?? 'csv').toLowerCase();
    const type = ['csv', 'excel', 'sql'].includes(rawType) ? rawType : 'csv';
    // 按字段映射把原始表头重命名为模板变量名
    const payloads = (dto.rows ?? []).map((r) => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(r)) out[fieldMap[k] ?? k] = v;
      return out;
    });
    const src = await this.ds.save({
      tenantId: useTenantId(),
      name,
      type,
      config: { headers: dto.headers ?? Object.keys(payloads[0] ?? {}), fieldMap, sourceType: rawType, ...(dto.config ?? {}) },
    });
    if (payloads.length) {
      await this.rows.save(payloads.map((p) => ({ tenantId: useTenantId(), sourceId: src.id, payload: p })));
    }
    await this.audit.write(useTenantId(), 'data_source.create', { id: src.id, name, rows: payloads.length }, undefined, 'data_source', src.id);
    return { sourceId: src.id, rows: payloads.length, columns: Object.keys(payloads[0] ?? {}), headers: dto.headers ?? [] };
  }

  // 兼容旧接口：上传 CSV 文本
  async uploadCsv(name: string, csvText: string, fieldMap: Record<string, string> = {}) {
    const { header, rows } = parseCsv(csvText);
    if (!header.length) throw new Error('CSV 内容为空');
    const payloads = rows.map((cells) => {
      const row: Record<string, any> = {};
      header.forEach((h, i) => { row[fieldMap[h] ?? h] = cells[i] ?? ''; });
      return row;
    });
    return this.saveRows({ name, type: 'csv', headers: header, rows: payloads, fieldMap: {} });
  }

  async rowsOf(sourceId: number, limit = 500, offset = 0) {
    await this.get(sourceId);
    return this.rows.find({
      where: { sourceId, tenantId: useTenantId() },
      order: { id: 'ASC' },
      take: Math.min(2000, limit),
      skip: offset,
    });
  }

  preview(sourceId: number, templateId: number, limit = 10) {
    return this.rows.find({ where: { sourceId, tenantId: useTenantId() }, take: limit });
  }
}

@Controller('data-sources')
@UseGuards(TenantGuard)
export class DataSourceController {
  constructor(private svc: DataSourceService) {}
  @Get() list() { return this.svc.list(); }
  @Post('upload') upload(@Body() b: { name: string; csvText: string; fieldMap: Record<string, string> }) {
    return this.svc.uploadCsv(b.name, b.csvText, b.fieldMap ?? {});
  }
  @Post('rows') saveRows(@Body() b: any) { return this.svc.saveRows(b); }
  @Get(':id/rows') rowsOf(@Param('id') id: number, @Query() q: any) {
    return this.svc.rowsOf(+id, q.limit ? +q.limit : 500, q.offset ? +q.offset : 0);
  }
  @Post('preview') preview(@Body() b: { sourceId: number; templateId: number; limit?: number }) {
    return this.svc.preview(b.sourceId, b.templateId, b.limit ?? 10);
  }
  @Delete(':id') remove(@Param('id') id: number) { return this.svc.remove(+id); }
}

@Module({
  imports: [TypeOrmModule.forFeature([DS, DataRow]), AuditModule],
  controllers: [DataSourceController],
  providers: [DataSourceService],
  exports: [DataSourceService],
})
export class DataSourceModule {}
