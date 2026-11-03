import { EventEmitter } from 'events';
import { Injectable } from '@nestjs/common';

/** 单进程事件总线：Processor 发布打印进度事件，SSE Controller 订阅推送给前端。
 * 多 worker 场景可替换为 Redis pubsub。 */
@Injectable()
export class PrintEvents {
  private emitter = new EventEmitter();

  /** 订阅指定租户的事件；listener 返回 false 取消订阅；超时自动取消 */
  subscribe(tenantId: number, listener: (ev: any) => boolean | void, timeoutMs = 60_000) {
    const channel = `print:tenant:${tenantId}`;
    const wrapper = (ev: any) => {
      // 让 SSE 层能直接拿到 event 做 res.write
      if (listener(ev) === false) this.emitter.removeListener(channel, wrapper);
    };
    this.emitter.on(channel, wrapper);
    const t = setTimeout(() => this.emitter.removeListener(channel, wrapper), timeoutMs);
    return () => { clearTimeout(t); this.emitter.removeListener(channel, wrapper); };
  }

  publish(tenantId: number, event: any) {
    this.emitter.emit(`print:tenant:${tenantId}`, { ...event, at: Date.now() });
  }
}
