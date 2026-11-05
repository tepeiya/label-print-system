// SaaS 订阅/权限拦截的业务错误码（docs/11 §11.11.1 验收标准）
// code 用 4031/4032/4033 区分「没订这个模块」和「有这个模块但没这个权限」和「配额打满」，
// 前端据此决定是弹「升级订阅」还是「联系管理员」。
// P5 扩展（§11.7.6 / §11.7.7）：4034 审批无效（403）、4035 功能开关未开（403，D7）、
// 4036 幂等键冲突（409）、4037 限流（429）。
// ⚠️ 状态码不再固定 403：基类改为 HttpException 并带 httpStatus（默认 403，
//    对 4031/4032/4033 三个既有子类完全等价，AllExceptionsFilter 仍按 bizCode 出 code 字段）。
import { HttpException, HttpStatus } from '@nestjs/common';

export const BizCode = {
  MODULE_NOT_SUBSCRIBED: 4031,
  PERMISSION_DENIED: 4032,
  QUOTA_EXCEEDED: 4033,
  APPROVAL_INVALID: 4034,
  FEATURE_DISABLED: 4035,
  IDEMPOTENCY_CONFLICT: 4036,
  RATE_LIMITED: 4037,
} as const;

/** 带业务码的异常；默认 403（4031/4032/4033 语义不变），限流等场景显式传状态码 */
export class BusinessException extends HttpException {
  readonly bizCode: number;
  readonly detail: Record<string, any>;

  constructor(
    bizCode: number, message: string, detail: Record<string, any> = {},
    httpStatus: number = HttpStatus.FORBIDDEN,
  ) {
    super({ code: bizCode, message, ...detail }, httpStatus);
    this.bizCode = bizCode;
    this.detail = detail;
  }
}

/** L2 模块订阅未通过 */
export class ModuleNotSubscribedException extends BusinessException {
  constructor(moduleCodes: string[], plan?: string | null) {
    super(
      BizCode.MODULE_NOT_SUBSCRIBED,
      `当前订阅未开通模块: ${moduleCodes.join(' / ')}`,
      { modules: moduleCodes, plan: plan ?? null, action: 'upgrade' },
    );
  }
}

/** L1 权限点不足 */
export class PermissionDeniedException extends BusinessException {
  constructor(permissionCodes: string[]) {
    super(
      BizCode.PERMISSION_DENIED,
      `缺少权限: ${permissionCodes.join(' / ')}`,
      { permissions: permissionCodes, action: 'contact_admin' },
    );
  }
}

/**
 * 配额硬上限（P3，docs/11 §11.7）：
 * hard_limit 命中时拒绝业务请求并返回升级引导（action='upgrade'，与 4031 同一前端动作语义）。
 * used/limit 为数字（单位随 meter：张 / 次），period 是配额窗口。
 */
export class QuotaExceededException extends BusinessException {
  constructor(meter: string, used: number, hardLimit: number, period: 'month' | 'day') {
    super(
      BizCode.QUOTA_EXCEEDED,
      `用量已达上限（${meter}：本${period === 'day' ? '日' : '月'} ${used}/${hardLimit}），请升级套餐或联系管理员调整配额`,
      { meter, used, limit: hardLimit, period, action: 'upgrade', suggestion: '升级套餐，或联系平台运营调整配额' },
    );
  }
}

/**
 * 审批无效（P5，§11.7.6）：approval_id 缺失/过期/已用/参数不一致。
 * pending 与 rejected 语义不同，但都归 4034（HTTP 403），用 status 字段区分。
 */
export class ApprovalInvalidException extends BusinessException {
  constructor(status: string, message: string, detail: Record<string, any> = {}) {
    super(
      BizCode.APPROVAL_INVALID, message,
      { approval_status: status, action: 'need_approval', ...detail },
    );
  }
}

/** 功能开关未开（D7：print.submit_job 需 feature_flags['agent.print.submit']=true） */
export class FeatureDisabledException extends BusinessException {
  constructor(key: string, message: string, detail: Record<string, any> = {}) {
    super(
      BizCode.FEATURE_DISABLED, message,
      { feature: key, action: 'contact_admin', ...detail },
    );
  }
}

/** 幂等键冲突（§11.7.4「写操作幂等」）：同 key 不同 args_hash，HTTP 409 */
export class IdempotencyConflictException extends BusinessException {
  constructor(idemKey: string, message: string, detail: Record<string, any> = {}) {
    super(BizCode.IDEMPOTENCY_CONFLICT, message, { idempotency_key: idemKey, ...detail }, 409);
  }
}

/** Agent 限流（§11.7.7 护栏 5）：HTTP 429，Retry-After 由响应头给出 */
export class RateLimitedException extends BusinessException {
  constructor(rpm: number, retryAfterSec: number) {
    super(
      BizCode.RATE_LIMITED,
      `调用过于频繁（限流 ${rpm} 次/分钟），请 ${retryAfterSec} 秒后重试`,
      { limit: rpm, window: 'minute', retry_after: retryAfterSec, action: 'retry_later' },
      429,
    );
  }
}
