// =============================================================================
// HardwareModule —— P8.5 硬件层装配与 HTTP 入口
//
// 【关键闭环】onModuleInit 把 HardwareService 注册为 AgentEnqueuePort，
// 这样 PrinterProviderRegistry.get('windows_spooler') 才真正能入队；
// 不注册的话 Provider 会明确返回 ok:false（而不是静默丢任务）。
// 该静态桥接是「静态 Provider 注册表」与「Nest DI」之间唯一的一处适配。
// =============================================================================
import {
  Module, OnModuleInit, Controller, Get, Post, Body, Param, Headers, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { Roles, RoleName } from '../common/roles.guard';
import { RequireModule } from '../common/module.guard';
import { Public } from '../common/public.decorator';
import { TenantGuard } from '../common/tenant.guard';
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { AuditModule } from '../audit/audit.module';
import { setAgentEnqueuePort } from '../../printer/printer-provider.interface';
import { HardwareAgent, HardwareAgentJob, RfidWriteLog } from './hardware.entity';
import { Printer } from '../entities/print.entity';
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

/**
 * 一行命令安装：GET /api/v1/agent/setup.ps1
 *
 * 为什么敢公开（@Public）：脚本本身不含任何秘密，只有"服务器地址 + 安装步骤"；
 * 租户要在客户机上跑它，那一刻还没有 token，也不该让客户手工复制 token。
 * 真正的门禁在脚本内部：它自己去 /auth/login 校验账号密码，下载发行包也带那个 token。
 * 地址取自请求 Host → 走 sanitizeBaseUrl 白名单，防止被伪造 Host 注入 PowerShell。
 */
@Controller('agent')
export class AgentSetupController {
  constructor(private svc: HardwareService) {}

  @Public()
  @Get('setup.ps1')
  setupScript(@Req() req: any, @Res() res: Response) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const base = `${proto}://${host}`;
    // 兜底：Host 缺失或非法时用 PUBLIC_BASE_URL；再没有就落到常驻地址，
    // 注意兜底值本身也必须合法，否则 sanitizeBaseUrl 会把非法值原样返回
    const fallback = process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3200';
    const text = this.svc.setupScript(base, fallback);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(text);
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([HardwareAgent, HardwareAgentJob, RfidWriteLog, Printer]),
    AuditModule,
  ],
  controllers: [HardwareController, AgentSetupController],
  providers: [HardwareService],
  exports: [HardwareService],
})
export class HardwareModule implements OnModuleInit {
  constructor(private svc: HardwareService) {}

  onModuleInit() {
    setAgentEnqueuePort(this.svc);
  }
}
