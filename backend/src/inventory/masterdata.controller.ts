// =============================================================================
// MasterdataController —— 产品资料 / 仓库 / 库位维护
// 模块门用 masterdata（inventory 的依赖，订阅库存会自动展开），权限点为已种库的
// masterdata:item:read / masterdata:item:write；删除一律做「停用 + 引用保护」。
// =============================================================================
import { Controller, Get, Post, Put, Body, Param, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenantId } from '../common/tenant.context';
import { InventoryService } from './inventory.service';
import {
  ActiveDto, BindTemplateDto, CreateFieldDefDto, CreateGroupDto, CreateLocationDto, CreateMaterialDto,
  CreateWarehouseDto, PrintMaterialDto, SetDefaultLocationDto, UpdateFieldDefDto, UpdateGroupDto,
  UpdateLocationDto, UpdateMaterialDto, UpdateWarehouseDto,
} from './dto/masterdata.dto';

@Controller('inventory/masterdata')
@UseGuards(TenantGuard)
@RequireModule('masterdata')
export class MasterdataController {
  constructor(private svc: InventoryService) {}

  // ---------------- 产品资料（物料） ----------------

  @Get('materials')
  @RequirePermission('masterdata:item:read')
  materials(
    @Query('keyword') keyword?: string,
    @Query('limit') limit?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.svc.listMaterials(useTenantId(), keyword, Number(limit) || 100, includeInactive === 'true');
  }

  @Get('materials/categories')
  @RequirePermission('masterdata:item:read')
  materialCategories() { return this.svc.listMaterialCategories(useTenantId()); }

  // ---------------- 产品自定义字段定义 ----------------

  /** 字段定义列表；includeInactive=true 供维护页查看已停用字段 */
  @Get('fields')
  @RequirePermission('masterdata:item:read')
  fields(@Query('includeInactive') includeInactive?: string) {
    return this.svc.listFieldDefs(useTenantId(), includeInactive === 'true');
  }

  @Post('fields')
  @RequirePermission('masterdata:item:write')
  createField(@Body() b: CreateFieldDefDto) { return this.svc.createFieldDef(useTenantId(), b); }

  @Put('fields/:id')
  @RequirePermission('masterdata:item:write')
  updateField(@Param('id') id: number, @Body() b: UpdateFieldDefDto) {
    return this.svc.updateFieldDef(useTenantId(), Number(id), b);
  }

  @Post('fields/:id/active')
  @RequirePermission('masterdata:item:write')
  setFieldActive(@Param('id') id: number, @Body() b: ActiveDto) {
    return this.svc.setFieldDefActive(useTenantId(), Number(id), b.active);
  }

  /** 批量设置默认仓库/库位：选中的产品或整个分组一次联动 */
  @Post('materials/set-default-location')
  @RequirePermission('masterdata:item:write')
  setDefaultLocation(@Body() b: SetDefaultLocationDto) {
    return this.svc.setDefaultLocation(useTenantId(), b);
  }

  /** 批量绑定：几千个产品不用逐个点编辑 */
  @Post('materials/bind-template')
  @RequirePermission('masterdata:item:write')
  bindTemplate(@Body() b: BindTemplateDto) {
    return this.svc.bindMaterialTemplate(useTenantId(), { ...b, templateId: b.templateId ?? null });
  }

  @Post('materials')
  @RequirePermission('masterdata:item:write')
  createMaterial(@Body() b: CreateMaterialDto) { return this.svc.createMaterial(useTenantId(), b); }

  @Put('materials/:id')
  @RequirePermission('masterdata:item:write')
  updateMaterial(@Param('id') id: number, @Body() b: UpdateMaterialDto) {
    return this.svc.updateMaterial(useTenantId(), Number(id), b);
  }

  @Post('materials/:id/active')
  @RequirePermission('masterdata:item:write')
  setMaterialActive(@Param('id') id: number, @Body() b: ActiveDto) {
    return this.svc.setMaterialActive(useTenantId(), Number(id), b.active);
  }

  /** 产品绑定模板后一键打印条码/标签；走与手工打印相同的 PrintService（配额/治理/流水号一致） */
  @Post('materials/:id/print')
  @RequirePermission('print:job:write')
  printMaterial(@Param('id') id: number, @Body() b: PrintMaterialDto) {
    return this.svc.printMaterial(useTenantId(), Number(id), b);
  }

  // ---------------- 产品分组 ----------------

  @Get('groups')
  @RequirePermission('masterdata:item:read')
  groups(@Query('type') type?: string, @Query('includeInactive') includeInactive?: string) {
    return this.svc.listGroups(useTenantId(), type, includeInactive === 'true');
  }

  @Post('groups')
  @RequirePermission('masterdata:item:write')
  createGroup(@Body() b: CreateGroupDto) { return this.svc.createGroup(useTenantId(), b); }

  @Put('groups/:id')
  @RequirePermission('masterdata:item:write')
  updateGroup(@Param('id') id: number, @Body() b: UpdateGroupDto) {
    return this.svc.updateGroup(useTenantId(), Number(id), b);
  }

  @Post('groups/:id/active')
  @RequirePermission('masterdata:item:write')
  setGroupActive(@Param('id') id: number, @Body() b: ActiveDto) {
    return this.svc.setGroupActive(useTenantId(), Number(id), b.active);
  }

  // ---------------- 仓库 ----------------

  @Get('warehouses')
  @RequirePermission('masterdata:item:read')
  warehouses(@Query('includeInactive') includeInactive?: string) {
    return this.svc.listWarehouses(useTenantId(), includeInactive === 'true');
  }

  @Post('warehouses')
  @RequirePermission('masterdata:item:write')
  createWarehouse(@Body() b: CreateWarehouseDto) { return this.svc.createWarehouse(useTenantId(), b); }

  @Put('warehouses/:id')
  @RequirePermission('masterdata:item:write')
  updateWarehouse(@Param('id') id: number, @Body() b: UpdateWarehouseDto) {
    return this.svc.updateWarehouse(useTenantId(), Number(id), b);
  }

  @Post('warehouses/:id/active')
  @RequirePermission('masterdata:item:write')
  setWarehouseActive(@Param('id') id: number, @Body() b: ActiveDto) {
    return this.svc.setWarehouseActive(useTenantId(), Number(id), b.active);
  }

  // ---------------- 库位 ----------------

  @Get('locations')
  @RequirePermission('masterdata:item:read')
  locations(
    @Query('warehouseId') warehouseId?: string,
    @Query('keyword') keyword?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.svc.listLocations(useTenantId(), {
      warehouseId: warehouseId ? Number(warehouseId) : undefined,
      keyword, includeInactive: includeInactive === 'true',
    });
  }

  @Post('locations')
  @RequirePermission('masterdata:item:write')
  createLocation(@Body() b: CreateLocationDto) { return this.svc.createLocation(useTenantId(), b); }

  @Put('locations/:id')
  @RequirePermission('masterdata:item:write')
  updateLocation(@Param('id') id: number, @Body() b: UpdateLocationDto) {
    return this.svc.updateLocation(useTenantId(), Number(id), b);
  }

  @Post('locations/:id/active')
  @RequirePermission('masterdata:item:write')
  setLocationActive(@Param('id') id: number, @Body() b: ActiveDto) {
    return this.svc.setLocationActive(useTenantId(), Number(id), b.active);
  }
}
