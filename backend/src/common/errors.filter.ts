import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { currentTraceId, log } from './trace.middleware';

/**
 * 全局异常过滤：把异常归一化为 { code, message, data: null }
 * code 优先取业务码（BusinessException.bizCode，例如 4031 模块未订阅 / 4032 权限不足），
 * 没有业务码时退回 HTTP 状态码。detail 字段原样透出，供前端做「去升级 / 找管理员」按钮。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // D2：结构化日志 + traceId，替代 console.error（多行堆栈拆成单行字段，容器里可 grep）。
    // 4xx 是客户端错，用 warn 且不打堆栈 —— 否则正常业务拒绝（401/403/429）会把日志冲成 error 墙。
    const traceId = currentTraceId();
    const err = exception as any;
    const logFn = status >= 500 ? log.error : log.warn;
    logFn('exception', {
      traceId,
      name: err?.name,
      message: err?.message,
      status,
      stack: status >= 500 ? String(err?.stack || '').split('\n').slice(0, 4).join(' | ') : undefined,
    });
    const bizCode = (exception as any)?.bizCode;
    let message = isHttp ? exception.message : '服务器内部错误';

    const body: Record<string, any> = { code: bizCode ?? status, message, data: null };
    // 400 及以上把 traceId 透给前端：用户截图报错时运维能直接定位
    if (traceId && status >= 400) body.requestId = traceId;
    // class-validator 的报错是 string[]（每条一个字段的中文说明），
    // 原样返回 message: ["name ...","content ..."] 前端不好展示，拼成一句并把明细放进 errors
    const resp = isHttp && typeof (exception as any).getResponse === 'function'
      ? (exception as any).getResponse()
      : null;
    if (resp && typeof resp === 'object' && Array.isArray(resp.message)) {
      message = '参数校验失败：' + resp.message.join('；');
      body.message = message;
      body.errors = resp.message;
    }
    const detail = (exception as any)?.detail;
    if (detail && typeof detail === 'object') {
      for (const [k, v] of Object.entries(detail)) if (!(k in body)) body[k] = v;
    }
    // B3：异常自带的响应头（目前只有 RateLimitedException 的 X-RateLimit-* / Retry-After）。
    // 放在这里而不是 Controller 里，是因为 429 在 Controller 拿到结果之前就抛出了。
    // 用通用字段而非 instanceof 判定，后续别的异常要带头不用再改过滤器。
    const headers = (exception as any)?.headers;
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === 'string' || typeof v === 'number') res.setHeader(k, String(v));
      }
    }
    res.status(status).json(body);
  }
}
