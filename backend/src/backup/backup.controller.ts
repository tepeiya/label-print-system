import { Controller, Get, Post, Delete, Param, Body, UseGuards, ForbiddenException, Res } from '@nestjs/common';
import { Response } from 'express';
import { TenantGuard } from '../common/tenant.guard';
import { Roles, RoleName } from '../common/roles.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenant } from '../common/tenant.context';
import { BackupService } from './backup.service';

const ADMIN: RoleName[] = ['admin'];

/**
 * Backup 模块属于 PRO 套餐以上
 * BASIC 租户访问会被 ModuleGuard 在全局层先挡（tenant_modules 无 backup）
 */
@Controller('backups')
@UseGuards(TenantGuard)
@RequireModule('backup')   // 订阅层检查：BASIC 没开 backup → 403
export class BackupController {
  constructor(private svc: BackupService) {}

  @RequirePermission('backup:read')
  @Get() list() { return this.svc.list(); }

  @Roles(...ADMIN)
  @RequirePermission('backup:write')
  @Post() create(@Body() body?: { name?: string }) { return this.svc.create(body?.name); }

  @Roles(...ADMIN)
  @RequirePermission('backup:restore')
  @Post(':id/restore') restore(@Param('id') id: number) { return this.svc.restore(+id); }

  @Roles(...ADMIN)
  @RequirePermission('backup:download')
  @Get(':id/download') async download(@Param('id') id: number, @Res() res: Response) {
    const rec = await this.svc.download(+id);
    const filename = encodeURIComponent(`${rec.name}.json.gz`);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(rec.data ?? Buffer.alloc(0));
  }

  // 原来是 @Post(':id')：① 和前端约定的 DELETE /backups/:id（docs/10 §10.3）不一致，
  // 前端点删除一直 404；② 用 POST 表达删除语义，容易被重放。改回 DELETE 并补权限点。
  @Roles(...ADMIN)
  @RequirePermission('backup:write')
  @Delete(':id') remove(@Param('id') id: number) { return this.svc.remove(+id); }
}
