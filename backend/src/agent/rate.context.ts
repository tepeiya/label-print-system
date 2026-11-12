// =============================================================================
// rate.context.ts —— 请求级限流结果传递（B3 响应头）
//
// 【为什么不用「往 ToolResult 里塞字段」】X-RateLimit-* 是传输层元数据，不该混进
// 业务响应体（MCP server 会把 ToolResult 原样转成模型可读文本，多一个内部字段是噪音）。
// 【为什么不用 res/req 挂载】ToolsService 不接触 HTTP 层，硬塞 Response 会破坏分层。
// AsyncLocalStorage 是 Nest 里跨 async 边界传请求级上下文的标准手段：hit() 在调用链
// 中写入，Controller 在返回前读取并 setHeader，全程不改任何业务结构。
//
// 注意：enterWith 只影响当前 async 执行上下文及其派生资源，不会串到并发请求；
// 读取不到时 Controller 会静默跳过响应头（限流判定本身不受影响）。
// =============================================================================
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RateOutcome } from './rate.calc';

const storage = new AsyncLocalStorage<RateOutcome>();

/** 由 AgentRateService.hit() 在返回前调用 */
export function publishRateOutcome(o: RateOutcome): void {
  storage.enterWith(o);
}

/** 由 AgentV1Controller 在写响应头时读取 */
export function currentRateOutcome(): RateOutcome | undefined {
  return storage.getStore();
}

/** 单测/显式作用域用：把一段逻辑跑在指定限流结果上下文里 */
export function runWithRateOutcome<T>(o: RateOutcome, fn: () => T): T {
  return storage.run(o, fn);
}
