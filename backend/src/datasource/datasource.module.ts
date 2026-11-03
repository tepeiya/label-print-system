import { Module, Injectable, NotFoundException, Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, UseInterceptors, UploadedFile, ForbiddenException, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as XLSX from 'xlsx';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource as DS, DataRow } from '../entities/print.entity';
import { TenantGuard } from '../common/tenant.guard';
import { Roles, RoleName } from '../common/roles.guard';
import { useTenantId } from '../common/tenant.context';
import { AuditModule, AuditService } from '../audit/audit.module';
import { encrypt, decrypt, hasProdKey } from './sql-crypto';
import * as sqlx from './sql-executor';

const DS_WRITE: RoleName[] = ['admin', 'operator'];
const SQL_ROLES: RoleName[] = ['admin', 'sql'];

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
    const src = await this.get(id);
    // SQL 数据源：释放连接池
    if (src.type === 'sql' && src.config?.encryptedUrl) {
      try { await sqlx.releasePool(decrypt(src.config.encryptedUrl)); } catch { /* ignore */ }
    }
    await this.rows.delete({ sourceId: id, tenantId: useTenantId() });
    await this.ds.delete({ id, tenantId: useTenantId() });
    await this.audit.write(useTenantId(), 'data_source.delete', { id }, undefined, 'data_source', id);
    return { ok: true };
  }

  async saveRows(dto: { name?: string; type?: string; headers?: string[]; rows: any[]; fieldMap?: Record<string, string>; config?: any }) {
    const name = dto.name || `数据源 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const fieldMap = dto.fieldMap ?? {};
    const rawType = String(dto.type ?? 'csv').toLowerCase();
    const type = ['csv', 'excel', 'sql'].includes(rawType) ? rawType : 'csv';
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

  // ================== SQL 数据源 ==================

  /** 保存 SQL 数据源定义（连接串加密） */
  async saveSql(dto: { name: string; connectionUrl: string; queryTemplate?: string; description?: string }) {
    if (!dto.connectionUrl) throw new Error('缺少 connectionUrl');
    if (!dto.connectionUrl.startsWith('postgresql://') && !dto.connectionUrl.startsWith('postgres://')) {
      throw new Error('仅支持 postgresql:// 连接串（需带用户名/密码/端口）');
    }
    const encryptedUrl = encrypt(dto.connectionUrl);
    const src = await this.ds.save({
      tenantId: useTenantId(),
      name: dto.name || `SQL 数据源`,
      type: 'sql',
      config: {
        driver: 'postgres',
        encryptedUrl,
        queryTemplate: dto.queryTemplate || '',
        description: dto.description || '',
        createdAt: new Date().toISOString(),
        envKeySet: hasProdKey(),
      },
    });
    await this.audit.write(useTenantId(), 'data_source.save_sql', { id: src.id, name: src.name }, undefined, 'data_source', src.id);
    return { sourceId: src.id, envKeySet: hasProdKey() };
  }

  /** 测试 SQL 数据源连接（SELECT 1） */
  async testSql(id: number) {
    const src = await this.get(id);
    if (src.type !== 'sql') throw new Error('该数据源不是 SQL 类型');
    const url = decrypt(src.config.encryptedUrl);
    return sqlx.ping({ connection: url });
  }

  /** 执行 SQL（参数化 + 只读强制） */
  async execSql(id: number, params: any[] = [], limit = 1000): Promise<sqlx.SqlExecResult> {
    const src = await this.get(id);
    if (src.type !== 'sql') throw new Error('该数据源不是 SQL 类型');
    const query = String(src.config.queryTemplate || '').trim();
    if (!query) throw new Error('该 SQL 数据源尚未配置查询模板');
    const url = decrypt(src.config.encryptedUrl);
    let result: sqlx.SqlExecResult;
    try {
      result = await sqlx.execute({ connection: url }, query, params, limit);
    } catch (e: any) {
      throw new BadRequestException(e?.message || String(e));
    }
    await this.audit.write(useTenantId(), 'data_source.exec_sql', { id, rowCount: result.rowCount, durationMs: result.durationMs, paramCount: params.length }, undefined, 'data_source', id);
    return result;
  }
}

@Controller('data-sources')
@UseGuards(TenantGuard)
export class DataSourceController {
  constructor(private svc: DataSourceService) {}

  @Get() list() { return this.svc.list(); }

  @Roles(...DS_WRITE)
  @Post('upload') upload(@Body() b: { name: string; csvText: string; fieldMap: Record<string, string> }) {
    return this.svc.uploadCsv(b.name, b.csvText, b.fieldMap ?? {});
  }

  /** 服务端 Excel 上传 */
  @Roles(...DS_WRITE)
  @Post('upload-excel')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadExcel(@UploadedFile() file: Express.Multer.File, @Body() body: { name?: string; fieldMap?: string } = {} as any) {
    if (!file) throw new Error('缺少 file');
    if (!/\.xlsx?$/i.test(file.originalname || '')) throw new Error('仅支持 .xlsx / .xls');
    const wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: false });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('Excel 中没有工作表');
    const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false });
    if (!rows.length) throw new Error('Excel 没有数据行');
    const headers = Object.keys(rows[0]);
    let fieldMap: Record<string, string> = {};
    if (body.fieldMap) {
      try { fieldMap = typeof body.fieldMap === 'string' ? JSON.parse(body.fieldMap) : body.fieldMap; } catch { fieldMap = {}; }
    }
    return this.svc.saveRows({
      name: body.name || `Excel ${file.originalname}`,
      type: 'excel',
      headers, rows, fieldMap,
      config: { sourceType: 'excel', originalName: file.originalname, sheet: sheetName, sizeBytes: file.size },
    });
  }

  @Roles(...DS_WRITE)
  @Post('rows') saveRows(@Body() b: any) { return this.svc.saveRows(b); }

  @Roles(...DS_WRITE)
  @Post('save-sql') saveSql(@Body() b: { name: string; connectionUrl: string; queryTemplate?: string; description?: string }) {
    return this.svc.saveSql(b);
  }

  @Roles(...SQL_ROLES)
  @Post(':id/sql-test') testSql(@Param('id') id: number) { return this.svc.testSql(+id); }

  @Roles(...SQL_ROLES)
  @Post(':id/sql-exec')
  execSql(
    @Param('id') id: number,
    @Body() b: { params?: any[]; limit?: number } = {},
  ) {
    return this.svc.execSql(+id, Array.isArray(b.params) ? b.params : [], b.limit ?? 1000);
  }

  @Roles(...SQL_ROLES)
  @Post(':id/sql-preview')
  previewSql(
    @Param('id') id: number,
    @Body() b: { params?: any[]; limit?: number } = {},
  ) {
    return this.svc.execSql(+id, Array.isArray(b.params) ? b.params : [], b.limit ?? 200);
  }

  @Get(':id/rows') rowsOf(@Param('id') id: number, @Query() q: any) {
    return this.svc.rowsOf(+id, q.limit ? +q.limit : 500, q.offset ? +q.offset : 0);
  }

  @Post('preview') preview(@Body() b: { sourceId: number; templateId: number; limit?: number }) {
    return this.svc.preview(b.sourceId, b.templateId, b.limit ?? 10);
  }

  @Roles(...DS_WRITE)
  @Delete(':id') remove(@Param('id') id: number) { return this.svc.remove(+id); }
}

@Module({
  imports: [TypeOrmModule.forFeature([DS, DataRow]), AuditModule],
  controllers: [DataSourceController],
  providers: [DataSourceService],
  exports: [DataSourceService],
})
export class DataSourceModule {}
