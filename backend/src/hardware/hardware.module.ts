// =============================================================================
// HardwareModule —— P8.5 硬件层装配与 HTTP 入口
//
// 【关键闭环】onModuleInit 把 HardwareService 注册为 AgentEnqueuePort，
// 这样 PrinterProviderRegistry.get('windows_spooler') 才真正能入队；
// 不注册的话 Provider 会明确返回 ok:false（而不是静默丢任务）。
// 该静态桥接是「静态 Provider 注册表」与「Nest DI」之间唯一的一处适配。
// =============================================================================
import { Module, OnModuleInit, Controller, Get, Post, Body, Param, Headers, UseGuards } from '@nestjs/common';
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
