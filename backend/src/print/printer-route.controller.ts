// =============================================================================
// printer-route.controller.ts —— 逻辑打印路由（P9）
//   WMS 只认识 printerRoute（如 receipt-station）；这里维护 route → 物理打印机的映射。
//   一个 route 可挂多台打印机，按 priority 升序取第一台。
// =============================================================================
import { Controller, Get, Post, Delete, Body, Param, UseGuards, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PrintPrinterRoute, Printer } from '../entities/print.entity';
import { TenantGuard } from '../common/tenant.guard';
import { Roles } from '../common/roles.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenantId } from '../common/tenant.context';

@Controller('print/printer-routes')
@UseGuards(TenantGuard)
@RequireModule('print')
export class PrinterRouteController {
  constructor(
    @InjectRepository(PrintPrinterRoute) private routes: Repository<PrintPrinterRoute>,
    @InjectRepository(Printer) private printers: Repository<Printer>,
  ) {}

  @Get()
  @RequirePermission('print:job:read')
  async list() {
    const tenantId = useTenantId();
    const rows = await this.routes.find({ where: { tenantId }, order: { routeCode: 'ASC', priority: 'ASC', id: 'ASC' } });
    const ids = [...new Set(rows.map((r) => Number(r.printerId)))];
    const found = ids.length ? await this.printers.find({ where: { tenantId, id: In(ids) } }) : [];
    const names = new Map(found.map((p) => [Number(p.id), p.name]));
    return rows.map((r) => ({
      id: Number(r.id), routeCode: r.routeCode, printerId: Number(r.printerId),
      printerName: names.get(Number(r.printerId)) ?? null,
      enabled: r.enabled, priority: r.priority, remark: r.remark,
    }));
  }

  /** upsert：同一 (routeCode, printerId) 只保留一条 */
  @Post()
  @RequirePermission('print:job:write')
  @Roles('admin', 'operator')
  async upsert(@Body() b: { routeCode?: string; printerId?: number; enabled?: boolean; priority?: number; remark?: string }) {
    const tenantId = useTenantId();
    const routeCode = String(b.routeCode ?? '').trim();
    if (!routeCode || routeCode.length > 80) throw new BadRequestException('routeCode 必填且 ≤80 字符');
    const printerId = Number(b.printerId);
    if (!Number.isInteger(printerId) || printerId <= 0) throw new BadRequestException('printerId 必填');
    const printer = await this.printers.findOne({ where: { tenantId, id: printerId } });
    if (!printer) throw new NotFoundException('打印机不存在（先到打印设置里新增打印机）');
    const priority = b.priority == null ? 10 : Number(b.priority);
    if (!Number.isFinite(priority) || priority < 0 || priority > 1000) throw new BadRequestException('priority 取 0~1000');

    let row = await this.routes.findOne({ where: { tenantId, routeCode, printerId } });
    if (row) {
      row.enabled = b.enabled !== false;
      row.priority = priority;
      row.remark = b.remark ?? row.remark;
      row = await this.routes.save(row);
    } else {
      row = await this.routes.save(this.routes.create({
        tenantId, routeCode, printerId, enabled: b.enabled !== false, priority, remark: b.remark ?? null,
      }));
    }
    return {
      id: Number(row.id), routeCode: row.routeCode, printerId: Number(row.printerId),
      printerName: printer.name, enabled: row.enabled, priority: row.priority, remark: row.remark,
    };
  }

  @Delete(':id')
  @RequirePermission('print:job:write')
  @Roles('admin', 'operator')
  async remove(@Param('id') id: number) {
    const tenantId = useTenantId();
    const row = await this.routes.findOne({ where: { tenantId, id: Number(id) } });
    if (!row) throw new NotFoundException('路由不存在');
    await this.routes.delete({ id: row.id });
    return { id: Number(row.id), deleted: true };
  }
}
