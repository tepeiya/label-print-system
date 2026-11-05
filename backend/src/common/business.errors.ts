// SaaS 订阅/权限拦截的业务错误码（docs/11 §11.11.1 验收标准）
// HTTP 状态仍是 403，但响应体的 code 用 4031/4032 区分「没订这个模块」和「有这个模块但没这个权限」，
// 前端据此决定是弹「升级订阅」还是「联系管理员」。
import { ForbiddenException } from '@nestjs/common';

export const BizCode = {
  MODULE_NOT_SUBSCRIBED: 4031,
  PERMISSION_DENIED: 4032,
  QUOTA_EXCEEDED: 4033,
} as const;

/** 带业务码的 403；AllExceptionsFilter 会把 bizCode 放进响应体 code 字段 */
export class BusinessException extends ForbiddenException {
  readonly bizCode: number;
  readonly detail: Record<string, any>;

  constructor(bizCode: number, message: string, detail: Record<string, any> = {}) {
    super({ code: bizCode, message, ...detail });
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
