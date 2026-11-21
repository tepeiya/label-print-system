// =============================================================================
// MCP Resources（P5，docs/11 §11.7.5）：labelflow://templates/{id} 与
// labelflow://inventory/stock/{ref}，正文由后端 GET /agent/v1/resources/:kind/:id 取。
// 为什么 ListResources 要「现调只读工具」：资源目录必须来自租户真实数据，
// 硬编码 id 列表在 SaaS 多租户下等于串租户；拿不到（scope 缺 / 后端异常）就返回空，
// 让模型改用 ReadResource 按 URI 精读——README 里也是这么写的。
// =============================================================================
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AgentApiClient, AgentApiError } from './client/agent-api.js';

/** 资源 URI 前缀（§11.7.5 原样 + §10.37 扩展） */
export const TEMPLATE_URI = (id: string | number) => `labelflow://templates/${encodeURIComponent(String(id))}`;
export const STOCK_URI = (ref: string) => `labelflow://inventory/stock/${encodeURIComponent(String(ref))}`;
export const JOB_URI = (id: string | number) => `labelflow://jobs/${encodeURIComponent(String(id))}`;
export const ALERTS_OPEN_URI = 'labelflow://alerts/open';
export const PRINTERS_URI = 'labelflow://printers';

export interface ResourceItem {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
}

/**
 * labelflow://templates/{id} | labelflow://inventory/stock/{ref} → { kind, id }
 * id 允许是数字或业务标识（§11.7.4「参数用业务标识」），后端两种都认。
 */
export function parseResourceUri(raw: string): { kind: 'template' | 'stock' | 'job' | 'alerts' | 'printers'; id: string } | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'labelflow:') return null;
  const host = url.hostname.toLowerCase();
  const seg = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));
  // id 既可能是数字也可能是模板名，两种后端都认
  if (host === 'templates' && seg) return { kind: 'template', id: seg };
  if (host === 'inventory' && seg.startsWith('stock/')) {
    const ref = seg.slice('stock/'.length);
    if (ref) return { kind: 'stock', id: ref };
  }
  // §10.37：任务 / 预警 / 打印机
  if (host === 'jobs' && seg) return { kind: 'job', id: seg };
  if (host === 'alerts' && (!seg || seg === 'open')) return { kind: 'alerts', id: seg || 'open' };
  if (host === 'printers' && !seg) return { kind: 'printers', id: '' };
  return null;
}

/** 从统一信封里取 data.data（工具/资源返回都是 {summary, data, warnings, next_actions}） */
function inner(res: any): any {
  return res?.data?.data ?? res?.data ?? {};
}

/**
 * 当前 token 可见的资源清单。两次只读工具调用（各取前 20 条），任一失败只丢该类，
 * 不让整个 list 报错——模型此时仍可按 URI 精读。
 * tools 是本会话已授权的工具清单：没有对应只读工具就跳过那一类，省掉一次注定 403 的调用
 * （也避免无谓地吃租户配额）。
 */
export async function listVisibleResources(
  api: AgentApiClient,
  log: (msg: string, ...rest: unknown[]) => void,
  tools: string[] = [],
): Promise<ResourceItem[]> {
  const has = (n: string) => !tools.length || tools.includes(n);
  const out: ResourceItem[] = [];
  try {
    const res = has('templates.search') ? await api.callTool('templates.search', { limit: 20 }) : null;
    for (const t of inner(res)?.items ?? []) {
      out.push({
        uri: TEMPLATE_URI(t.id),
        name: `template-${t.id}`,
        title: t.name,
        description: `标签模板「${t.name}」v${t.currentVersion ?? 1}${t.category ? `（分类：${t.category}）` : ''}`,
        mimeType: 'application/json',
      });
    }
  } catch (e) {
    log('templates.search 失败，跳过模板资源：', (e as Error).message);
  }
  try {
    const res = has('inventory.query_stock') ? await api.callTool('inventory.query_stock', { limit: 20, group_by: 'sku' }) : null;
    for (const m of inner(res)?.items ?? []) {
      out.push({
        uri: STOCK_URI(m.code),
        name: `stock-${m.code}`,
        title: m.name,
        description: `${m.name} 当前库存 ${m.qty} ${m.unit}${m.belowSafety ? `（低于安全库存 ${m.safetyStock}）` : ''}`,
        mimeType: 'application/json',
      });
    }
  } catch (e) {
    log('inventory.query_stock 失败，跳过库存资源：', (e as Error).message);
  }
  // §10.37：任务 / 未处理预警 / 打印机快照
  try {
    if (has('print.list_jobs')) {
      const res = await api.callTool('print.list_jobs', { limit: 20 });
      for (const j of inner(res)?.items ?? []) {
        out.push({
          uri: JOB_URI(j.jobId),
          name: `job-${j.jobId}`,
          title: `任务 #${j.jobId}`,
          description: `打印任务 #${j.jobId}：${j.status}，${j.done}/${j.total}`,
          mimeType: 'application/json',
        });
      }
    }
  } catch (e) {
    log('print.list_jobs 失败，跳过任务资源：', (e as Error).message);
  }
  if (has('alerts.list')) {
    try {
      const res = await api.callTool('alerts.list', { status: 'open', limit: 20 });
      const count = (inner(res)?.items ?? []).length;
      out.push({
        uri: ALERTS_OPEN_URI, name: 'alerts-open', title: '未处理预警',
        description: `当前未处理（open）预警 ${count} 条`,
        mimeType: 'application/json',
      });
    } catch (e) {
      log('alerts.list 失败，跳过预警资源：', (e as Error).message);
    }
  }
  if (has('printers.list')) {
    try {
      const res = await api.callTool('printers.list', {});
      const items = inner(res)?.items ?? [];
      out.push({
        uri: PRINTERS_URI, name: 'printers', title: '打印机列表',
        description: `当前租户 ${items.length} 台打印机`,
        mimeType: 'application/json',
      });
    } catch (e) {
      log('printers.list 失败，跳过打印机资源：', (e as Error).message);
    }
  }
  return out;
}

/** ReadResource → 后端资源端点；失败转 McpError（404 语义保持 404，便于模型换标识重试） */
export async function readResourceUri(api: AgentApiClient, uri: string): Promise<ResourceItem & { text: string }> {
  const parsed = parseResourceUri(uri);
  if (!parsed) {
    throw new McpError(ErrorCode.InvalidParams,
      `无法识别的资源 URI：${uri}（支持 labelflow://templates/{id}、labelflow://inventory/stock/{ref}、labelflow://jobs/{id}、labelflow://alerts/open、labelflow://printers）`);
  }
  let env: any;
  try {
    env = await api.getResource(parsed.kind, parsed.id);
  } catch (e) {
    if (e instanceof AgentApiError) {
      const code = e.httpStatus === 404 ? ErrorCode.InvalidParams : ErrorCode.InternalError;
      throw new McpError(code, `读取资源 ${uri} 失败（HTTP ${e.httpStatus}）：${e.message}`);
    }
    throw e;
  }
  return {
    uri,
    name: parsed.id,
    mimeType: 'application/json',
    text: JSON.stringify(env?.data ?? env, null, 2),
  };
}
