import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { TemplateService } from './template.service';
import { TenantGuard } from '../common/tenant.guard';
import { Roles, RoleName } from '../common/roles.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';

/** 模板写操作权限 */
const TPL_WRITE: RoleName[] = ['admin', 'operator'];

@Controller('templates')
@UseGuards(TenantGuard) // 注入 tenantId，禁止前端决定数据范围
// SaaS 四层模型落点（docs/11 §11.4.4）：模块是门（templates），权限是钥匙（template:*）
// 三个套餐都含 templates，所以对现有租户零行为变化；没订阅的租户拿到 4031。
@RequireModule('templates')
export class TemplateController {
  constructor(private svc: TemplateService) {}
  @RequirePermission('template:read')
  @Get() list(@Query() q: any) { return this.svc.list(q); }
  @RequirePermission('template:read')
  @Get(':id') get(@Param('id') id: number) { return this.svc.get(+id); }
  @RequirePermission('template:write')
  @Roles(...TPL_WRITE)
  @Post() create(@Body() b: any) { return this.svc.create(b); }
  @RequirePermission('template:write')
  @Roles(...TPL_WRITE)
  @Put(':id') update(@Param('id') id: number, @Body() b: any) { return this.svc.update(+id, b); }
  @RequirePermission('template:write')
  @Roles(...TPL_WRITE)
  @Delete(':id') remove(@Param('id') id: number) { return this.svc.remove(+id); }
  @RequirePermission('template:write')
  @Roles(...TPL_WRITE)
  @Post(':id/copy') copy(@Param('id') id: number, @Body() b: any) { return this.svc.copy(+id, b?.name); }
  @RequirePermission('template:favorite')
  @Roles(...TPL_WRITE)
  @Post(':id/favorite') favorite(@Param('id') id: number, @Body() b: any) { return this.svc.favorite(+id, b?.value ?? true); }
  @RequirePermission('template:read')
  @Get(':id/versions') versions(@Param('id') id: number) { return this.svc.versions(+id); }
  @RequirePermission('template:read')
  @Get(':id/versions/:v') version(@Param('id') id: number, @Param('v') v: number) { return this.svc.version(+id, +v); }
  @RequirePermission('template:write')
  @Roles(...TPL_WRITE)
  @Post(':id/versions/:v/rollback') rollback(@Param('id') id: number, @Param('v') v: number) { return this.svc.rollback(+id, +v); }
  @RequirePermission('template:write')
  @Roles(...TPL_WRITE)
  @Post('import') importOne(@Body() b: any) { return this.svc.import(b); }
  @RequirePermission('template:read')
  @Get(':id/export') exportOne(@Param('id') id: number) { return this.svc.exportOne(+id); }
}
