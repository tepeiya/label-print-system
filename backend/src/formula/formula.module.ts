import { Module } from '@nestjs/common';
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { safeEval, detectCircularDeps } from '../../core/formula-engine';

@Controller('formula')
@UseGuards(TenantGuard)
export class FormulaController {
  @Post('eval') evalExpr(@Body() b: { expr: string; vars?: Record<string, any> }) {
    return safeEval(b.expr, b.vars ?? {}); // { ok, value?, error? }
  }
  @Post('validate') validate(@Body() b: { expr: string }) {
    const r = safeEval(b.expr, {});
    return { ok: r.ok, error: r.error, deps: [] };
  }
}

@Module({ controllers: [FormulaController] })
export class FormulaModule {}
