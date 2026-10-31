import { Module, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { DataSource as DS, DataRow } from '../entities/print.entity';
import { TenantGuard } from '../common/tenant.guard';
import { useTenantId } from '../common/tenant.context';

@Injectable()
export class DataSourceService {
  constructor(@InjectRepository(DS) private ds: Repository<DS>, @InjectRepository(DataRow) private rows: Repository<DataRow>) {}
  // 简易 CSV 解析（真实场景用 csv-parse / exceljs）
  async uploadCsv(name: string, csvText: string, fieldMap: Record<string, string>) {
    const lines = csvText.trim().split('\n');
    const header = lines[0].split(',');
    const payloads = lines.slice(1).map((l) => {
      const cells = l.split(',');
      const row: Record<string, any> = {};
      header.forEach((h, i) => { row[fieldMap[h] ?? h] = cells[i]; }); // 字段映射到模板变量
      return row;
    });
    const src = await this.ds.save({ tenantId: useTenantId(), name, type: 'csv', config: { fieldMap } });
    await this.rows.save(payloads.map((p) => ({ tenantId: useTenantId(), sourceId: src.id, payload: p })));
    return { sourceId: src.id, rows: payloads.length, columns: Object.keys(payloads[0] ?? {}) };
  }
  preview(sourceId: number, templateId: number, limit = 10) {
    return this.rows.find({ where: { sourceId, tenantId: useTenantId() }, take: limit });
  }
}

@Controller('data-sources')
@UseGuards(TenantGuard)
export class DataSourceController {
  constructor(private svc: DataSourceService) {}
  @Post('upload') upload(@Body() b: { name: string; csvText: string; fieldMap: Record<string, string> }) {
    return this.svc.uploadCsv(b.name, b.csvText, b.fieldMap);
  }
  @Post('preview') preview(@Body() b: { sourceId: number; templateId: number; limit?: number }) {
    return this.svc.preview(b.sourceId, b.templateId, b.limit ?? 10);
  }
}

@Module({ controllers: [DataSourceController], providers: [DataSourceService] })
export class DataSourceModule {}
