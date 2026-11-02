import { Module, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { createConnection } from 'net';
import { Printer } from '../entities/print.entity';
import { TenantGuard } from '../common/tenant.guard';
import { useTenantId } from '../common/tenant.context';
import { PrinterProviderRegistry } from '../../printer/printer-provider.interface';
import { AuditModule, AuditService } from '../audit/audit.module';
import { generateZpl } from '../../core/zpl-generator';
import { buildJob as buildTsplJob } from '../../core/tspl-generator';

/** numeric 列在 pg 驱动里是字符串 —— 统一转 number，避免前端算偏移出错 */
function normalize(p: any) {
  if (!p) return p;
  return {
    ...p,
    dpi: Number(p.dpi) || 203,
    labelWidthMm: Number(p.labelWidthMm),
    labelHeightMm: Number(p.labelHeightMm),
    offsetXMm: Number(p.offsetXMm),
    offsetYMm: Number(p.offsetYMm),
    orientation: Number(p.orientation) || 0,
    density: p.density == null ? null : Number(p.density),
    speed: p.speed == null ? null : Number(p.speed),
  };
}

@Injectable()
export class PrinterService {
  constructor(
    @InjectRepository(Printer) private repo: Repository<Printer>,
    private audit: AuditService,
  ) {}

  async list() {
    const rows = await this.repo.find({ where: { tenantId: useTenantId() }, order: { id: 'ASC' } });
    return rows.map(normalize);
  }

  async create(dto: any) {
    const p = await this.repo.save({ ...dto, tenantId: useTenantId() });
    await this.audit.write(useTenantId(), 'printer.create', { id: p.id, name: p.name, type: p.type }, undefined, 'printer', p.id);
    return normalize(p);
  }

  async update(id: number, dto: any) {
    await this.get(id);
    await this.repo.update({ id, tenantId: useTenantId() }, dto);
    await this.audit.write(useTenantId(), 'printer.update', { id, patch: dto }, undefined, 'printer', id);
    return normalize(await this.get(id));
  }

  async remove(id: number) {
    await this.get(id);
    const r = await this.repo.delete({ id, tenantId: useTenantId() });
    await this.audit.write(useTenantId(), 'printer.delete', { id }, undefined, 'printer', id);
    return r;
  }

  async get(id: number) {
    const p = await this.repo.findOne({ where: { id, tenantId: useTenantId() } });
    if (!p) throw new NotFoundException('打印机不存在');
    return p;
  }

  /** 校准：偏移 / 浓度 / 速度（均为可选，只更新传入项） */
  async calibrate(id: number, dto: { offsetXMm?: number; offsetYMm?: number; density?: number; speed?: number }) {
    await this.get(id);
    const patch: any = {};
    if (dto.offsetXMm !== undefined) patch.offsetXMm = dto.offsetXMm;
    if (dto.offsetYMm !== undefined) patch.offsetYMm = dto.offsetYMm;
    if (dto.density !== undefined) patch.density = dto.density;
    if (dto.speed !== undefined) patch.speed = dto.speed;
    await this.repo.update({ id, tenantId: useTenantId() }, patch);
    await this.audit.write(useTenantId(), 'printer.calibrate', { id, patch }, undefined, 'printer', id);
    return normalize(await this.get(id));
  }

  /** 连通性测试：raw_tcp 真实建连，其它通道只校验参数 */
  async test(id: number) {
    const printer = normalize(await this.get(id));
    if (printer.type === 'browser' || printer.type === 'windows_spooler') {
      return { ok: true, skipped: true, message: '该通道由前端/本地代理完成，无需服务端连通测试' };
    }
    const provider = PrinterProviderRegistry.get(printer.type as any);
    const t0 = Date.now();
    try {
      await provider.validate(printer as any);
      if (printer.type === 'raw_tcp') {
        const host = printer.connection?.host;
        if (!host) throw new Error('缺少 host');
        const port = printer.connection?.port ?? 9100;
        await new Promise<void>((resolve, reject) => {
          const s = createConnection({ host, port, timeout: 3000 });
          s.on('connect', () => { s.end(); resolve(); });
          s.on('timeout', () => { s.destroy(); reject(new Error('连接超时')); });
          s.on('error', (e) => reject(e));
        });
      }
      return { ok: true, roundtripMs: Date.now() - t0 };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e), roundtripMs: Date.now() - t0 };
    }
  }

  /** 打印测试标签：10×10 文本 + 条码 + 时间，验证偏移/浓度/速度 */
  async testPrint(id: number) {
    const printer = normalize(await this.get(id));
    if (printer.type === 'browser' || printer.type === 'windows_spooler') {
      return { ok: false, error: '该通道不支持服务端测试打印' };
    }
    const now = new Date();
    const stamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 19)}`;
    const textEls = [
      { type: 'text', xMm: 3, yMm: 3, text: 'LabelFlow 测试标签', fontHeightMm: 4, fontWidthMm: 3, bold: true },
      { type: 'text', xMm: 3, yMm: 9, text: stamp, fontHeightMm: 2.4, fontWidthMm: 1.6 },
      { type: 'barcode', xMm: 3, yMm: 14, barcode: { sym: 'CODE128', content: `TEST-${now.getTime()}`, moduleWidthMm: 0.3, wideRatio: 2.5, heightMm: 8, showText: true, textPosition: 'bottom' } },
    ];
    const protocol = (printer.connection?.protocol || 'zpl') as 'zpl' | 'tspl';
    const provider = PrinterProviderRegistry.get(printer.type as any);
    const t0 = Date.now();
    try {
      const result = await provider.print({
        tenantId: useTenantId(),
        jobId: 0,
        templateId: 0,
        printer: {
          type: printer.type,
          dpi: printer.dpi,
          widthMm: printer.labelWidthMm,
          heightMm: printer.labelHeightMm,
          offsetXMm: printer.offsetXMm,
          offsetYMm: printer.offsetYMm,
          orientation: printer.orientation,
          density: printer.density,
          speed: printer.speed,
          protocol,
          gapMm: Number(printer.connection?.gapMm ?? 2),
          connection: printer.connection ?? {},
        },
        copies: 1,
        labels: [{ zpl: textEls as any, tspl: textEls as any }],
      });
      await this.audit.write(useTenantId(), 'printer.test_print', { id, ok: result.ok, error: result.error }, undefined, 'printer', id);
      return { ...result, roundtripMs: Date.now() - t0 };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e), roundtripMs: Date.now() - t0 };
    }
  }

  /** 生成测试标签指令（不发送，用于前端预览/排错） */
  async testCommands(id: number, protocol?: 'zpl' | 'tspl') {
    const printer = normalize(await this.get(id));
    const p = protocol ?? ((printer.connection?.protocol as any) || 'zpl');
    const els: any[] = [
      { type: 'text', xMm: 3, yMm: 3, text: 'LabelFlow Test', fontHeightMm: 4, fontWidthMm: 3, bold: true },
    ];
    const text = p === 'tspl'
      ? buildTsplJob(els, printer.dpi, { widthMm: printer.labelWidthMm, heightMm: printer.labelHeightMm, gapMm: 2, copies: 1 }).toString('ascii')
      : generateZpl(els, printer.dpi);
    return { protocol: p, text };
  }
}

@Controller('printers')
@UseGuards(TenantGuard)
export class PrinterController {
  constructor(private svc: PrinterService) {}
  @Get() list() { return this.svc.list(); }
  @Post() create(@Body() b: any) { return this.svc.create(b); }
  @Get(':id') get(@Param('id') id: number) { return this.svc.get(+id).then(normalize); }
  @Put(':id') update(@Param('id') id: number, @Body() b: any) { return this.svc.update(+id, b); }
  @Delete(':id') remove(@Param('id') id: number) { return this.svc.remove(+id); }
  @Post(':id/calibrate') calibrate(@Param('id') id: number, @Body() b: any) { return this.svc.calibrate(+id, b); }
  @Post(':id/test') test(@Param('id') id: number) { return this.svc.test(+id); }
  @Post(':id/test-print') testPrint(@Param('id') id: number) { return this.svc.testPrint(+id); }
  @Post(':id/test-commands') testCommands(@Param('id') id: number, @Body() b: any) { return this.svc.testCommands(+id, b?.protocol); }
}

@Module({
  imports: [TypeOrmModule.forFeature([Printer]), AuditModule],
  controllers: [PrinterController],
  providers: [PrinterService],
  exports: [PrinterService],
})
export class PrinterModule {}
