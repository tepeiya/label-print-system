// =============================================================================
// HardwareService —— P8.5 本地打印代理 / RFID / 喷码的真实接入层
//
// 【职责】协议判定全部在 hardware/*.calc.ts，本文件只做 IO：
//   注册/心跳/拉取/回执 → 数据库；打印任务入队 → 生成脱敏信封；
//   RFID 写后读回 → 校验并留痕；喷码 → 生成厂商中立作业载荷。
//
// 【多租户红线】所有查询显式带 tenant_id（Repository 代理再叠加 RLS 兜底）。
//   agentId 只在「同租户内」唯一，拉取/回执都必须先按 (tenant_id, agent_id) 定位代理，
//   再按 (tenant_id, job_key) 定位任务，防止跨租户伪造回执。
//
// 【签名】默认关闭（HARDWARE_AGENT_SIGNATURE_REQUIRED=1 开启），与 WP2 限流同款：
//   新增强制维度默认不影响存量租户。开启后代理需按 JSON.stringify(payload) 构造
//   签名串，服务端复用 P8.1 Webhook 的 HMAC 真源校验，见 verifyAgentSignature。
// =============================================================================
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { useTenantId } from '../common/tenant.context';
import { AuditService } from '../audit/audit.module';
import { encrypt, decrypt } from '../datasource/sql-crypto';
import type { AgentEnqueuePort, PrintJobInput } from '../../printer/printer-provider.interface';
import { generateZpl } from '../../core/zpl-generator';
import { buildJob as buildTsplJob } from '../../core/tspl-generator';
import { HardwareAgent, HardwareAgentJob, RfidWriteLog } from './hardware.entity';
import {
  AGENT_JOB_MAX_ATTEMPTS, AGENT_MAX_PULL, agentJobEnvelope, agentOnline,
  agentStatus, claimExpired, normalizeAgentRegistration, normalizeHeartbeat,
  verifyAgentSignature, verifyReceipt, type AgentJobSource, type AgentJobStatus,
} from './agent-protocol.calc';
import { encodeSgtin96, decodeSgtin96, rfidWriteJob, verifyEpcWrite } from './epc.calc';
import {
  INKJET_MAX_CHARS_PER_LINE, INKJET_MAX_ITEMS, INKJET_MAX_LINES, TRIGGER_MODES,
  inkjetJob, inkjetPayload, validateInkjetJob,
} from './inkjet.calc';

@Injectable()
export class HardwareService implements AgentEnqueuePort {
  private logger = new Logger('HardwareService');

  constructor(
    @InjectRepository(HardwareAgent) private agents: Repository<HardwareAgent>,
    @InjectRepository(HardwareAgentJob) private jobs: Repository<HardwareAgentJob>,
    @InjectRepository(RfidWriteLog) private rfidLogs: Repository<RfidWriteLog>,
    private audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- 签名

  /**
   * 可选签名校验：secret 以 AES-256-GCM 密文存库，验证时解密取明文。
   * 只存 hash 是不够的 —— HMAC 需要双方持有同一明文；不落明文是为了库泄漏不直接失守。
   */
  private assertSigned(agent: HardwareAgent, body: any, ts?: string, sig?: string): void {
    if (String(process.env.HARDWARE_AGENT_SIGNATURE_REQUIRED ?? '0') !== '1') return;
    let secret = '';
    try { secret = decrypt(agent.secretEnc); } catch { /* 解密失败按校验失败处理 */ }
    if (!secret || !verifyAgentSignature(JSON.stringify(body), secret, ts ?? '', sig ?? '', Date.now())) {
      throw new ForbiddenException('代理签名校验失败或时间戳超出容差');
    }
  }

  private async agentOrThrow(agentId: string): Promise<HardwareAgent> {
    const a = await this.agents.findOne({ where: { agentId: String(agentId ?? ''), tenantId: useTenantId() } });
    if (!a) throw new NotFoundException('本地代理未注册');
    return a;
  }

  // ---------------------------------------------------------------- 代理生命周期

  /** 注册 / 重新注册（重新注册会轮换签名密钥，旧密钥立即失效） */
  async register(dto: any) {
    const v = normalizeAgentRegistration({ tenantId: useTenantId(), ...dto });
    if (!v.ok || !v.registration) throw new BadRequestException(v.errors.join('；'));
    const r = v.registration;
    const existing = await this.agents.findOne({ where: { tenantId: r.tenantId, agentId: r.agentId } });
    const secret = crypto.randomBytes(32).toString('hex');
    const saved = await this.agents.save({
      ...(existing ?? {}),
      tenantId: r.tenantId, agentId: r.agentId, name: r.name,
      capabilities: r.capabilities, driverNames: r.driverNames,
      secretEnc: encrypt(secret),
      secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
      status: 'active', load: 0, draining: false,
      metadata: { ...(existing?.metadata ?? {}), ...r.metadata },
    } as any);
    await this.audit.write(r.tenantId, 'hardware.agent.register', {
      agentId: r.agentId, capabilities: r.capabilities, rotated: !!existing,
    }, undefined, 'hardware_agent', saved.id);
    return {
      agentId: r.agentId, protocolVersion: '1.0',
      // 明文密钥只在这一次返回，服务端仅存密文 + 指纹
      secret, secretHint: '请立即保存，重新注册或轮换后旧密钥立即失效',
      warnings: v.warnings,
    };
  }

  /** 心跳：更新在线状态与负载，返回待办数量（代理据此决定是否立即拉取） */
  async heartbeat(agentId: string, dto: any, ts?: string, sig?: string) {
    const agent = await this.agentOrThrow(agentId);
    this.assertSigned(agent, dto, ts, sig);
    const now = new Date();
    const v = normalizeHeartbeat({ ...dto, agentId }, now);
    if (!v.ok || !v.heartbeat) throw new BadRequestException(v.errors.join('；'));
    await this.agents.update({ id: agent.id, tenantId: useTenantId() }, {
      lastHeartbeatAt: now, load: v.heartbeat.load, draining: v.heartbeat.draining,
      ...(v.heartbeat.capabilities.length ? { capabilities: v.heartbeat.capabilities } : {}),
    } as any);
    const pending = await this.jobs.count({ where: { tenantId: useTenantId(), status: 'pending' } });
    return { ok: true, serverTime: now.toISOString(), pending };
  }

  /** 运维列表：用判定层统一算在线状态，不在 SQL 里另写一套时间判断 */
  async listAgents() {
    const now = new Date();
    const rows = await this.agents.find({ where: { tenantId: useTenantId() }, order: { id: 'ASC' } });
    return rows.map((a) => ({
      id: a.id, agentId: a.agentId, name: a.name,
      capabilities: a.capabilities, driverNames: a.driverNames,
      status: agentStatus(a.lastHeartbeatAt, now, a.draining),
      load: a.load, lastHeartbeatAt: a.lastHeartbeatAt, createdAt: a.createdAt,
      secretHash: a.secretHash,   // 只给指纹，绝不给 secret_enc / 明文
    }));
  }

  /** 拉取待办：能力匹配 + 在线校验 + 单次上限 + 原子认领（claimed） */
  async pull(agentId: string, dto: any = {}, ts?: string, sig?: string) {
    const agent = await this.agentOrThrow(agentId);
    this.assertSigned(agent, dto, ts, sig);
    const now = new Date();
    if (!agentOnline(agent.lastHeartbeatAt, now)) {
      return { ok: false, reason: '代理离线，请先上报心跳', jobs: [] };
    }
    const caps = agent.capabilities ?? [];
    if (!caps.length) return { ok: true, jobs: [], reason: '代理未声明能力' };
    const take = Math.max(1, Math.min(AGENT_MAX_PULL, Math.floor(Number(dto?.limit) || AGENT_MAX_PULL)));
    // 能力匹配用内存过滤：caps 数组来自 jsonb，跨驱动 SQL 写法不一致，量级很小
    const candidates = await this.jobs.find({
      where: { tenantId: useTenantId(), status: 'pending' },
      order: { createdAt: 'ASC' },
      take: take * 4,
    });
    const picked = candidates.filter((j) => caps.includes(j.capability)).slice(0, take);
    const out: any[] = [];
    for (const j of picked) {
      await this.jobs.update({ id: j.id, tenantId: useTenantId() }, {
        status: 'claimed', agentId, claimedAt: now, attempts: (j.attempts ?? 0) + 1,
      } as any);
      out.push({ jobKey: j.jobKey, status: 'claimed', envelope: j.envelope });
    }
    return { ok: true, serverTime: now.toISOString(), jobs: out };
  }

  /** 回执：三重匹配 + 状态机迁移，终态不可改写 */
  async receipt(agentId: string, dto: any, ts?: string, sig?: string) {
    const agent = await this.agentOrThrow(agentId);
    this.assertSigned(agent, dto, ts, sig);
    const j = await this.jobs.findOne({ where: { jobKey: String(dto?.jobKey ?? ''), tenantId: useTenantId() } });
    if (!j) throw new NotFoundException('任务不存在');
    const v = verifyReceipt(dto, {
      jobKey: j.jobKey, agentId, tenantId: useTenantId(), currentStatus: j.status as AgentJobStatus,
    });
    if (!v.ok || !v.normalized) throw new BadRequestException(v.errors.join('；'));
    const terminal = ['succeeded', 'failed', 'expired'].includes(v.normalized.status);
    await this.jobs.update({ id: j.id, tenantId: useTenantId() }, {
      status: v.normalized.status,
      ...(terminal ? { finishedAt: new Date() } : {}),
      lastError: v.normalized.error ?? null,
    } as any);
    if (terminal) {
      await this.audit.write(useTenantId(), 'hardware.agent.receipt', {
        jobKey: j.jobKey, agentId, status: v.normalized.status, printedCount: v.normalized.printedCount ?? null,
      }, undefined, 'hardware_agent_job', j.id);
    }
    return { ok: true, jobKey: j.jobKey, status: v.normalized.status };
  }

  /** 回收超时认领的任务（代理进程崩溃后任务不会永久卡住），可由运维端点或定时任务触发 */
  async sweepExpired() {
    const now = new Date();
    const rows = await this.jobs.find({
      where: [{ tenantId: useTenantId(), status: 'claimed' }, { tenantId: useTenantId(), status: 'printing' }],
      take: 200,
    });
    let released = 0, expired = 0;
    for (const j of rows) {
      if (!claimExpired(j.claimedAt, j.status as AgentJobStatus, j.attempts, now)) continue;
      const next = (j.attempts ?? 0) + 1 >= AGENT_JOB_MAX_ATTEMPTS ? 'expired' : 'pending';
      await this.jobs.update({ id: j.id, tenantId: useTenantId() }, {
        status: next, agentId: null, claimedAt: null,
        lastError: next === 'expired' ? '超过最大重试次数' : '认领超时，已回收重派',
      } as any);
      if (next === 'expired') expired += 1; else released += 1;
    }
    return { ok: true, scanned: rows.length, released, expired };
  }

  // ---------------------------------------------------------------- AgentEnqueuePort

  /** PrintJobInput（渲染后的元素数组）→ 协议层输入（指令字符串），再统一过脱敏信封 */
  private toJobSource(job: PrintJobInput): AgentJobSource {
    const p = job.printer;
    const protocol = String(p.protocol ?? p.connection?.protocol ?? 'zpl');
    const labels = (job.labels ?? []).map((f) => {
      if (f.pngBuffer) return { pngBase64: f.pngBuffer.toString('base64'), copies: job.copies };
      if (protocol === 'tspl') {
        const out = buildTsplJob(f.tspl ?? [], p.dpi, {
          widthMm: p.widthMm, heightMm: p.heightMm, gapMm: p.gapMm ?? 2, copies: Math.max(1, job.copies),
        }, p.orientation);
        return { tspl: out.buffer.toString('ascii'), copies: job.copies };
      }
      const { text } = generateZpl(f.zpl ?? [], p.dpi);
      return { zpl: text, copies: job.copies };
    });
    return {
      tenantId: job.tenantId, jobId: job.jobId, templateId: job.templateId,
      capability: 'windows_spooler', labels,
      settings: {
        dpi: p.dpi, widthMm: p.widthMm, heightMm: p.heightMm,
        offsetXMm: p.offsetXMm, offsetYMm: p.offsetYMm, orientation: p.orientation,
        density: p.density, speed: p.speed, gapMm: p.gapMm,
      },
      connection: p.connection ?? {},
    };
  }

  /**
   * 打印 Worker 的入队口：jobKey 稳定幂等 + 唯一索引兜并发。
   * 不抛异常给 Worker（由 Provider 转 ok:false 记失败日志），但错误要明确。
   */
  async enqueue(job: PrintJobInput): Promise<{ queued: boolean; agentJobId: string; error?: string }> {
    const src = this.toJobSource(job);
    if (!src.labels.length) return { queued: false, agentJobId: '', error: '没有可下发的标签帧' };
    const envelope = agentJobEnvelope(src, new Date());
    if (!envelope.labels.length) return { queued: false, agentJobId: '', error: '标签帧没有可用格式' };
    const tenantId = job.tenantId;
    try {
      const exists = await this.jobs.findOne({ where: { tenantId, jobKey: envelope.jobKey } });
      if (exists) return { queued: true, agentJobId: envelope.jobKey, error: undefined };
      await this.jobs.save({
        tenantId, jobKey: envelope.jobKey, jobId: job.jobId,
        printerId: envelope.printerId, templateId: envelope.templateId,
        status: 'pending', capability: envelope.capability, envelope: envelope as any,
      });
      return { queued: true, agentJobId: envelope.jobKey };
    } catch (e: any) {
      // 23505 = 并发下另一个 worker 抢先入队，视为幂等成功
      if (String(e?.code) === '23505') return { queued: true, agentJobId: envelope.jobKey };
      this.logger.warn(`本地代理任务入队失败 job=${job.jobId}：${e?.message ?? e}`);
      return { queued: false, agentJobId: envelope.jobKey, error: String(e?.message ?? e) };
    }
  }

  // ---------------------------------------------------------------- RFID

  encodeEpc(dto: any) {
    const r = encodeSgtin96({
      gtin: String(dto?.gtin ?? ''), companyPrefixLen: Number(dto?.companyPrefixLen),
      serial: dto?.serial ?? 0, filter: dto?.filter ?? 0,
    });
    if (!r.ok) throw new BadRequestException(r.errors.join('；'));
    return { epcHex: r.epcHex, tagUri: r.tagUri, decoded: decodeSgtin96(r.epcHex!) };
  }

  /** 只生成写操作信封，不宣称已经写入；真写由本地代理 + 读写器完成 */
  rfidWrite(dto: any) {
    const j = rfidWriteJob(useTenantId(), Number(dto?.jobId) || 0, String(dto?.epc ?? ''));
    if (!j) throw new BadRequestException('EPC 必须是 96-bit hex（24 位）');
    return j;
  }

  /** 写后读回校验：只有读回一致才算 verified，结果落表可追溯 */
  async rfidVerifyRead(dto: any) {
    const v = verifyEpcWrite(String(dto?.epc ?? ''), dto?.readBack);
    await this.rfidLogs.save({
      tenantId: useTenantId(),
      epc: v.normalizedReadBack ?? String(dto?.epc ?? '').toUpperCase().slice(0, 24),
      readBack: v.normalizedReadBack, verified: v.verified,
      jobId: dto?.jobId ?? null, detail: v.reason,
    });
    return v;
  }

  // ---------------------------------------------------------------- 喷码

  inkjetCapabilities() {
    return {
      maxLines: INKJET_MAX_LINES, maxCharsPerLine: INKJET_MAX_CHARS_PER_LINE,
      maxItems: INKJET_MAX_ITEMS, triggerModes: TRIGGER_MODES,
      placeholderSyntax: '{{varName}}',
      disclaimer: '厂商私有指令集（Videojet / Domino / Markem-Imaje 等）由本地代理适配，服务端只产出厂商中立作业载荷',
    };
  }

  inkjetBuild(dto: any) {
    const j = inkjetJob(useTenantId(), Number(dto?.jobId) || 0, Array.isArray(dto?.rows) ? dto.rows : [], dto?.config ?? {});
    const v = validateInkjetJob(j);
    if (!v.ok) throw new BadRequestException(v.errors.join('；'));
    return {
      jobKey: j.jobKey, dpi: j.dpi, direction: j.direction, trigger: j.trigger,
      itemCount: j.items.length, warnings: j.warnings,
      ...(dto?.includePayload === true ? { payload: inkjetPayload(j) } : {}),
    };
  }
}
