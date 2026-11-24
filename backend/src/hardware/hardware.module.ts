// =============================================================================
// HardwareModule —— P8.5 硬件层装配与 HTTP 入口
//
// 【关键闭环】onModuleInit 把 HardwareService 注册为 AgentEnqueuePort，
// 这样 PrinterProviderRegistry.get('windows_spooler') 才真正能入队；
// 不注册的话 Provider 会明确返回 ok:false（而不是静默丢任务）。
// 该静态桥接是「静态 Provider 注册表」与「Nest DI」之间唯一的一处适配。
// =============================================================================
import {
  Module, OnModuleInit, Controller, Get, Post, Body, Param, Headers, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { Roles, RoleName } from '../common/roles.guard';
import { RequireModule } from '../common/module.guard';
import { TenantGuard } from '../common/tenant.guard';
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { AuditModule } from '../audit/audit.module';
import { setAgentEnqueuePort } from '../../printer/printer-provider.interface';
import { HardwareAgent, HardwareAgentJob, RfidWriteLog } from './hardware.entity';
import { HardwareService } from './hardware.service';

const HW_WRITE: RoleName[] = ['admin', 'operator'];

@Controller('hardware')
@UseGuards(TenantGuard)
@RequireModule('print')
export class HardwareController {
  constructor(private svc: HardwareService) {}

  // ------------------------------ 本地代理 ------------------------------
  @Roles(...HW_WRITE)
  @Post('agents/register')
  register(@Body() b: any) { return this.svc.register(b); }

  @Roles(...HW_WRITE)
  @Get('agents')
  listAgents() { return this.svc.listAgents(); }

  /**
   * 租户自助下载：发行包清单（版本/大小/sha256）。
   * 前端打印页用它渲染「下载本地代理 v1.0（29MB）」而不是硬编码版本号。
   */
  @Roles(...HW_WRITE)
  @Get('agents/release')
  agentRelease() { return this.svc.printAgentRelease(); }

  /**
   * 发行包本体（zip）。用 @Res 自己 pipe：29MB 不塞进内存也不走 ResponseInterceptor。
   * 鉴权仍是 TenantGuard + print 模块 + admin/operator —— 不设 @Public，避免白拿。
   */
  @Roles(...HW_WRITE)
  @Get('agents/release/download')
  downloadAgent(@Res() res: Response) {
    const { path: filePath, release } = this.svc.printAgentReleaseFile();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(release.sizeBytes));
    res.setHeader('Content-Disposition', `attachment; filename="${release.fileName}"`);
    res.setHeader('X-LabelFlow-Release-Version', release.version);
    res.setHeader('X-LabelFlow-Release-Sha256', release.sha256);
    const stream = createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end('发行包读取失败'); else res.end(); });
    stream.pipe(res);
  }

  @Roles(...HW_WRITE)
  @Post('agents/:agentId/heartbeat')
  heartbeat(
    @Param('agentId') agentId: string, @Body() b: any = {},
    @Headers('x-labelflow-timestamp') ts?: string,
    @Headers('x-labelflow-signature') sig?: string,
  ) { return this.svc.heartbeat(agentId, b, ts, sig); }

  @Roles(...HW_WRITE)
  @Post('agents/:agentId/jobs/pull')
  pull(
    @Param('agentId') agentId: string, @Body() b: any = {},
    @Headers('x-labelflow-timestamp') ts?: string,
    @Headers('x-labelflow-signature') sig?: string,
  ) { return this.svc.pull(agentId, b, ts, sig); }

  @Roles(...HW_WRITE)
  @Post('agents/:agentId/receipts')
  receipt(
    @Param('agentId') agentId: string, @Body() b: any,
    @Headers('x-labelflow-timestamp') ts?: string,
    @Headers('x-labelflow-signature') sig?: string,
  ) { return this.svc.receipt(agentId, b, ts, sig); }

  @Roles('admin')
  @Post('agents/sweep')
  sweep() { return this.svc.sweepExpired(); }

  // ------------------------------ RFID / EPC ------------------------------
  /** SGTIN-96 编码（纯计算，可前端直接调，不需要读写器） */
  @Roles(...HW_WRITE)
  @Post('rfid/encode')
  encodeEpc(@Body() b: any) { return this.svc.encodeEpc(b); }

  /** 生成写操作信封；不宣称已经写入设备 */
  @Roles(...HW_WRITE)
  @Post('rfid/write-job')
  rfidWrite(@Body() b: any) { return this.svc.rfidWrite(b); }

  /** 写后读回校验（verified=false 留痕） */
  @Roles(...HW_WRITE)
  @Post('rfid/verify-read')
  rfidVerifyRead(@Body() b: any) { return this.svc.rfidVerifyRead(b); }

  // ------------------------------ 喷码 ------------------------------
  @Roles(...HW_WRITE)
  @Get('inkjet/capabilities')
  inkjetCapabilities() { return this.svc.inkjetCapabilities(); }

  @Roles(...HW_WRITE)
  @Post('inkjet/job')
  inkjetBuild(@Body() b: any) { return this.svc.inkjetBuild(b); }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([HardwareAgent, HardwareAgentJob, RfidWriteLog]),
    AuditModule,
  ],
  controllers: [HardwareController],
  providers: [HardwareService],
  exports: [HardwareService],
})
export class HardwareModule implements OnModuleInit {
  constructor(private svc: HardwareService) {}

  onModuleInit() {
    setAgentEnqueuePort(this.svc);
  }
}
