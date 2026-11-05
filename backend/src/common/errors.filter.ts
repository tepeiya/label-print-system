import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

/**
 * 全局异常过滤：把异常归一化为 { code, message, data: null }
 * code 优先取业务码（BusinessException.bizCode，例如 4031 模块未订阅 / 4032 权限不足），
 * 没有业务码时退回 HTTP 状态码。detail 字段原样透出，供前端做「去升级 / 找管理员」按钮。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    console.error('[Unhandled Exception]', exception);
    const res = host.switchToHttp().getResponse();
    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const bizCode = (exception as any)?.bizCode;
    let message = isHttp ? exception.message : '服务器内部错误';

    const body: Record<string, any> = { code: bizCode ?? status, message, data: null };
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
    res.status(status).json(body);
  }
}
