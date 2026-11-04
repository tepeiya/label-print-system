import { Controller, Get, Post, Delete, Param, Body, UseGuards, ForbiddenException, Res } from '@nestjs/common';
import { Response } from 'express';
import { TenantGuard } from '../common/tenant.guard';
import { Roles, RoleName } from '../common/roles.guard';
import { useTenant } from '../common/tenant.context';
import { BackupService } from './backup.service';

const ADMIN: RoleName[] = ['admin'];

@Controller('backups')
@UseGuards(TenantGuard)
export class BackupController {
  constructor(private svc: BackupService) {}

  @Get() list() { return this.svc.list(); }

  @Roles(...ADMIN)
  @Post() create(@Body() body?: { name?: string }) { return this.svc.create(body?.name); }

  @Roles(...ADMIN)
  @Post(':id/restore') restore(@Param('id') id: number) { return this.svc.restore(+id); }

  @Roles(...ADMIN)
  @Get(':id/download') async download(@Param('id') id: number, @Res() res: Response) {
    const rec = await this.svc.download(+id);
    const filename = encodeURIComponent(`${rec.name}.json.gz`);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(rec.data ?? Buffer.alloc(0));
  }

  @Roles(...ADMIN)
  @Delete(':id') remove(@Param('id') id: number) { return this.svc.remove(+id); }
}
