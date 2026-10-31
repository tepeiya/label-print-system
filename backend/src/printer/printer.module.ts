import { Module, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { Printer } from '../entities/print.entity';
import { TenantGuard } from '../common/tenant.guard';
import { useTenantId } from '../common/tenant.context';
import { PrinterProviderRegistry } from '../../printer/printer-provider.interface';

@Injectable()
export class PrinterService {
  constructor(@InjectRepository(Printer) private repo: Repository<Printer>) {}
  list() { return this.repo.find({ where: { tenantId: useTenantId() } }); }
  create(dto: any) { return this.repo.save({ ...dto, tenantId: useTenantId() }); }
  update(id: number, dto: any) { return this.repo.update({ id, tenantId: useTenantId() }, dto); }
  remove(id: number) { return this.repo.delete({ id, tenantId: useTenantId() }); }
  calibrate(id: number, dx: number, dy: number) {
    return this.repo.update({ id, tenantId: useTenantId() }, { offsetXMm: dx, offsetYMm: dy });
  }
  async test(printer: Printer) {
    const provider = PrinterProviderRegistry.get(printer.type as any);
    const t0 = Date.now();
    await provider.validate(printer as any);
    return { ok: true, roundtripMs: Date.now() - t0 };
  }
}

@Controller('printers')
@UseGuards(TenantGuard)
export class PrinterController {
  constructor(private svc: PrinterService) {}
  @Get() list() { return this.svc.list(); }
  @Post() create(@Body() b: any) { return this.svc.create(b); }
  @Put(':id') update(@Param('id') id: number, @Body() b: any) { return this.svc.update(+id, b); }
  @Delete(':id') remove(@Param('id') id: number) { return this.svc.remove(+id); }
  @Post(':id/calibrate') calibrate(@Param('id') id: number, @Body() b: any) { return this.svc.calibrate(+id, b.offsetXMm, b.offsetYMm); }
}

@Module({ controllers: [PrinterController], providers: [PrinterService] })
export class PrinterModule {}
