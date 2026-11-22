// =============================================================================
// PrintGateway —— WMS 侧唯一打印调用入口（方向 A 逻辑边界）
//
// 硬性约束：
//   · WMS 的 Service/Controller 禁止 import backend/src/print/** 下任何文件；
//     本 Gateway 通过 HTTP 调 /internal/print-jobs，是唯一的打印出口。
//   · 租户由 service token 注入，Gateway 只透传 templateCode/variables/idempotencyKey 等，
//     绝不传 tenantId（传了也会被打印侧忽略并告警）。
//   · 3 秒超时；超时视为未知结果，不重试（由打印侧幂等兜底）。
// =============================================================================
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export interface PrintJobRequest {
  templateCode: string;
  printerRoute?: string;
  idempotencyKey: string;
  variables: Record<string, any>;
  source: string;
  copies?: number;
}

export interface PrintJobResult {
  jobId: string | number;
  status: string;
  idempotent?: boolean;
  errorCode?: string;
  message?: string;
}

@Injectable()
export class PrintGateway {
  private logger = new Logger('PrintGateway');
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs = 3000;

  constructor() {
    const port = process.env.PORT || '3200';
    this.baseUrl = (process.env.PRINT_INTERNAL_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
    this.token = process.env.WMS_SERVICE_TOKEN || '';
  }

  /**
   * 提交打印任务。返回 jobId/status；打印侧 409 幂等命中映射为 idempotent=true。
   * 超时/网络错误抛 ServiceUnavailableException，由调用方（过账服务）旁路处理，不阻塞主链路。
   */
  async createJob(req: PrintJobRequest): Promise<PrintJobResult> {
    if (!this.token) {
      // 未配置 token：明确报错，避免静默打成"成功"却无鉴权
      throw new ServiceUnavailableException('WMS_SERVICE_TOKEN 未配置，无法调用打印服务');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/internal/print-jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok) {
        return { ...data, idempotent: data.idempotent === true } as PrintJobResult;
      }
      // 4xx/5xx：带 errorCode 返回，交给调用方记 failed 审计
      return {
        jobId: data?.jobId ?? '',
        status: 'failed',
        errorCode: data?.errorCode || data?.code || `HTTP_${resp.status}`,
        message: data?.message ?? '打印服务返回错误',
      };
    } catch (e: any) {
      const timedOut = e?.name === 'AbortError';
      this.logger.warn(`调用打印服务失败（${timedOut ? '超时' : e?.message}），按未知结果处理，不重试`);
      // 超时/网络错误视为未知结果：不重试，抛给调用方记 failed（由幂等兜底，补打走新 key）
      throw new ServiceUnavailableException(
        timedOut ? '打印服务调用超时（结果未知，不重试）' : `打印服务不可达：${e?.message ?? e}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
