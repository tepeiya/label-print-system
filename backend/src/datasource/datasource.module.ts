// =============================================================================
// DataSourceModule —— 数据源 HTTP 层 + 模块装配（P8.4）
// DataSourceService 已抽到 datasource.service.ts（见该文件注释），此处 re-export 保持兼容。
// P8.4 新增：自动刷新 repeatable 调度器与 Worker 均装配在本模块内，依赖单向无环。
// =============================================================================
import { Module, Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as XLSX from 'xlsx';
import { BullModule } from '@nestjs/bullmq';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { DataSource as DS, DataRow } from '../entities/print.entity';
import { TenantGuard } from '../common/tenant.guard';
import { Roles, RoleName } from '../common/roles.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { AuditModule } from '../audit/audit.module';
import { DsPreviewDto, LookupDto, RefreshConfigDto, SaveRowsDto, SaveSqlDto, SqlExecDto, UploadCsvDto, UploadExcelMetaDto } from './dto/datasource.dto';
import { DataSourceService } from './datasource.service';
import { DatasourceRefreshService } from './refresh-scheduler.service';
import { DatasourceRefreshProcessor } from './refresh.processor';
import { REFRESH_QUEUE, REFRESH_SCHEDULER_ENV } from './refresh-scheduler.calc';

// 兼容原有 import 路径（datasource.module.ts 曾内联导出这两个符号）
export { DataSourceService, parseCsv } from './datasource.service';

const DS_WRITE: RoleName[] = ['admin', 'operator'];
const SQL_ROLES: RoleName[] = ['admin', 'sql'];

@Controller('data-sources')
@UseGuards(TenantGuard)
@RequireModule('datasource')   // 订阅层：BASIC 没开 datasource → 403
export class DataSourceController {
  constructor(
    private svc: DataSourceService,
    private scheduler: DatasourceRefreshService,
  ) {}

  @RequirePermission('datasource:read')
  @Get() list() { return this.svc.list(); }

  @Roles(...DS_WRITE)
  @RequirePermission('datasource:write')
  @Post('upload') upload(@Body() b: UploadCsvDto) {
    return this.svc.uploadCsv(b.name, b.csvText, b.fieldMap ?? {});
  }

  /** 服务端 Excel 上传 */
  @Roles(...DS_WRITE)
  @RequirePermission('datasource:write')
  @Post('upload-excel')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadExcel(@UploadedFile() file: Express.Multer.File, @Body() body: UploadExcelMetaDto = new UploadExcelMetaDto()) {
    if (!file) throw new BadRequestException('缺少 file');
    if (!/\.xlsx?$/i.test(file.originalname || '')) throw new BadRequestException('仅支持 .xlsx / .xls');
    const wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: false });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new BadRequestException('Excel 中没有工作表');
    const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false });
    if (!rows.length) throw new BadRequestException('Excel 没有数据行');
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
  @Post('rows') saveRows(@Body() b: SaveRowsDto) { return this.svc.saveRows(b); }

  @Roles(...DS_WRITE)
  @Post('save-sql') saveSql(@Body() b: SaveSqlDto) {
    return this.svc.saveSql(b);
  }

  /** P8.4：支持的 SQL 驱动清单（前端建源向导用） */
  @Get('drivers')
  drivers() {
    return {
      drivers: [
        { code: 'postgres', urlPrefix: 'postgresql://', placeholder: '$1', driverPackage: 'pg（内置）' },
        { code: 'mysql', urlPrefix: 'mysql://', placeholder: '?', driverPackage: 'mysql2（按需 npm i mysql2）' },
        { code: 'mssql', urlPrefix: 'mssql://', placeholder: '@p1', driverPackage: 'mssql（按需 npm i mssql）' },
      ],
      note: 'MySQL / SQL Server 驱动懒加载，未安装时明确报错；真连库回归需第二套数据库实例',
    };
  }

  /**
   * P8.4 运维端点：查看当前队列里已登记的自动刷新任务。
   * 只暴露 job name 与周期，不返回 DSN / 查询模板。
   */
  @Roles('admin')
  @Get('refresh-schedule')
  async refreshSchedule(@Query('limit') limit?: number) {
    return {
      queue: REFRESH_QUEUE,
      schedulerEnabled: String(process.env[REFRESH_SCHEDULER_ENV] ?? '1') !== '0',
      jobs: await this.scheduler.scheduled(limit ? +limit : 100),
    };
  }

  /** P8.4 运维端点：手动触发一次启动期对齐（Redis 恢复后无需重启进程） */
  @Roles('admin')
  @Post('refresh-bootstrap')
  refreshBootstrap() { return this.scheduler.bootstrap(); }

  @Roles(...SQL_ROLES)
  @Post(':id/sql-test') testSql(@Param('id') id: number) { return this.svc.testSql(+id); }

  @Roles(...SQL_ROLES)
  @Post(':id/sql-exec')
  execSql(
    @Param('id') id: number,
    @Body() b: SqlExecDto = new SqlExecDto(),
  ) {
    return this.svc.execSql(+id, Array.isArray(b.params) ? b.params : [], b.limit ?? 1000, b.offset ?? 0);
  }

  @Roles(...SQL_ROLES)
  @Post(':id/sql-preview')
  previewSql(
    @Param('id') id: number,
    @Body() b: SqlExecDto = new SqlExecDto(),
  ) {
    return this.svc.execSql(+id, Array.isArray(b.params) ? b.params : [], b.limit ?? 200, b.offset ?? 0);
  }

  @Roles(...SQL_ROLES)
  @Post(':id/lookup')
  lookup(@Param('id') id: number, @Body() b: LookupDto = new LookupDto()) {
    return this.svc.lookup(+id, b.filters ?? {}, b.limit ?? 200);
  }

  /** P8.4：手动刷新（真执行 SQL 并落库），自动刷新 Worker 复用同一 Service 方法 */
  @Roles(...DS_WRITE)
  @Post(':id/refresh')
  refresh(@Param('id') id: number) { return this.svc.refresh(+id); }

  @Roles(...DS_WRITE)
  @Get(':id/refresh-plan')
  refreshPlan(@Param('id') id: number) { return this.svc.refreshPlanOf(+id); }

  @Roles(...DS_WRITE)
  @Put(':id/refresh-config')
  setRefreshConfig(@Param('id') id: number, @Body() b: RefreshConfigDto = new RefreshConfigDto()) {
    return this.svc.setRefreshConfig(+id, b.refresh ?? {});
  }

  @Get(':id/rows') rowsOf(@Param('id') id: number, @Query() q: any) {
    return this.svc.rowsOf(+id, q.limit ? +q.limit : 500, q.offset ? +q.offset : 0);
  }

  @Post('preview') preview(@Body() b: DsPreviewDto) {
    return this.svc.preview(b.sourceId, b.templateId, b.limit ?? 10);
  }

  @Roles(...DS_WRITE)
  @Delete(':id') remove(@Param('id') id: number) { return this.svc.remove(+id); }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([DS, DataRow]),
    AuditModule,
    BullModule.registerQueue({ name: REFRESH_QUEUE }),
  ],
  controllers: [DataSourceController],
  providers: [DataSourceService, DatasourceRefreshService, DatasourceRefreshProcessor],
  exports: [DataSourceService],
})
export class DataSourceModule {}
