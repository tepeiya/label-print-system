import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { TemplateService } from './template.service';
import { TenantGuard } from '../common/tenant.guard';
import { Roles, RoleName } from '../common/roles.guard';

/** 模板写操作权限 */
const TPL_WRITE: RoleName[] = ['admin', 'operator'];

@Controller('templates')
@UseGuards(TenantGuard) // 注入 tenantId，禁止前端决定数据范围
export class TemplateController {
  constructor(private svc: TemplateService) {}
  @Get() list(@Query() q: any) { return this.svc.list(q); }
  @Get(':id') get(@Param('id') id: number) { return this.svc.get(+id); }
  @Roles(...TPL_WRITE)
  @Post() create(@Body() b: any) { return this.svc.create(b); }
  @Roles(...TPL_WRITE)
  @Put(':id') update(@Param('id') id: number, @Body() b: any) { return this.svc.update(+id, b); }
  @Roles(...TPL_WRITE)
  @Delete(':id') remove(@Param('id') id: number) { return this.svc.remove(+id); }
  @Roles(...TPL_WRITE)
  @Post(':id/copy') copy(@Param('id') id: number, @Body() b: any) { return this.svc.copy(+id, b?.name); }
  @Roles(...TPL_WRITE)
  @Post(':id/favorite') favorite(@Param('id') id: number, @Body() b: any) { return this.svc.favorite(+id, b?.value ?? true); }
  @Get(':id/versions') versions(@Param('id') id: number) { return this.svc.versions(+id); }
  @Get(':id/versions/:v') version(@Param('id') id: number, @Param('v') v: number) { return this.svc.version(+id, +v); }
  @Roles(...TPL_WRITE)
  @Post(':id/versions/:v/rollback') rollback(@Param('id') id: number, @Param('v') v: number) { return this.svc.rollback(+id, +v); }
  @Roles(...TPL_WRITE)
  @Post('import') importOne(@Body() b: any) { return this.svc.import(b); }
  @Get(':id/export') exportOne(@Param('id') id: number) { return this.svc.exportOne(+id); }
}
