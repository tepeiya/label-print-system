// =============================================================================
// tool.catalog —— Agent 工具目录（docs/11 §11.7.2 工具矩阵）
// 纯数据 + 纯函数：whoami / list_modules / describe_capabilities 由此驱动，
// MCP server 启动时 GET /agent/v1/tools 直接拿它注册工具。
//
// ⚠️ 权限点用库内真实码（两段式 template:read/write），与文档 print:template:* 的
//    出入见 docs/10 §10.20 偏离说明。
// implemented=false 的行 = 已注册但无执行器（调用返回 400「后续版本开放」）：
//    当前无 implemented=false 的工具。P5 开放写工具/审批，P8.1 开 alerts/bom，
//    打印链已补全 submit/get_status/estimate/wait_for_job/cancel_job/list_jobs/retry_job/
//    preview/commands。2026-11-21 再补 printers.list/status、datasource.refresh（详见 §10.37）。
//    ai.* 仍属刻意不注册（图片入参 + 计费联动未就绪，避免 404/半残工具）。
//    反向 MCP（external_mcp_servers）表已有、实现未做，等明确客户需求再立项。
// P5 语义：risk==='high' → 必须 approval（§11.7.6）；risk!=='read' → 必须 idempotency_key（§11.7.4）。
// =============================================================================
import { matchPermission } from '../common/permission-match';

export type ToolRisk = 'read' | 'write' | 'high';

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** 所需权限点（scope）；null = 元工具，任何有效 token 可用 */
  permission: string | null;
  /** 所需订阅模块（满足其一）；空数组 = 不限 */
  modules: string[];
  risk: ToolRisk;
  /** 是否已有执行器（false = 调用返回 400「后续版本开放」） */
  implemented: boolean;
  inputSchema: Record<string, unknown>;
}

const S = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object', properties: props, required,
});

export const AGENT_TOOLS: ToolDef[] = [
  // ---------------- 元工具（permission=null，§11.7.2） ----------------
  {
    name: 'whoami', title: '我是谁', risk: 'read', permission: null, modules: [], implemented: true,
    description: '返回当前 Agent 身份、租户、scope 与可访问模块',
    inputSchema: S({}),
  },
  {
    name: 'list_modules', title: '列出已订阅模块', risk: 'read', permission: null, modules: [], implemented: true,
    description: '当前租户开通了哪些功能模块（print/templates/inventory/bom/agent…）',
    inputSchema: S({}),
  },
  {
    name: 'describe_capabilities', title: '能力自举', risk: 'read', permission: null, modules: [], implemented: true,
    description: '返回当前 token 可用的工具清单与用途，供模型自举规划',
    inputSchema: S({}),
  },

  // ---------------- 模板只读（P4「6 个业务只读工具」1/2） ----------------
  {
    name: 'templates.search', title: '搜模板', risk: 'read', permission: 'template:read', modules: ['templates'], implemented: true,
    description: '按名称/分类/标签模糊搜索标签模板，返回 id、名称、分类、标签、当前版本',
    inputSchema: S({
      keyword: { type: 'string', description: '名称/描述模糊匹配' },
      category: { type: 'string' },
      tag: { type: 'string' },
      limit: { type: 'integer', default: 20, maximum: 100 },
    }),
  },
  {
    name: 'templates.get', title: '取模板 JSON', risk: 'read', permission: 'template:read', modules: ['templates'], implemented: true,
    description: '按 id 或名称取模板完整设计 JSON（设计器产物）',
    inputSchema: S({
      id: { type: 'integer' },
      name: { type: 'string', description: 'id 缺失时按名称定位（精确优先，其次模糊）' },
    }),
  },

  // ---------------- 库存只读（3/4/5/6） ----------------
  {
    name: 'inventory.query_stock', title: '多维度查库存', risk: 'read', permission: 'inventory:stock:read', modules: ['inventory'], implemented: true,
    description: '按关键字/仓库/分组查库存；无数据返回空数组 + 友好摘要',
    inputSchema: S({
      keyword: { type: 'string', description: '物料名称/编码模糊匹配' },
      warehouse: { type: 'string', description: '仓库名称或 ID，缺省=全部可见仓库' },
      group_by: { type: 'string', enum: ['sku', 'batch', 'warehouse'], default: 'sku' },
      below_safety: { type: 'boolean', description: '只看低于安全库存的' },
      expiring_days: { type: 'integer', minimum: 1, maximum: 365, description: '只看 N 天内到期的批次' },
      limit: { type: 'integer', default: 20, maximum: 100 },
      cursor: { type: 'string' },
    }),
  },
  {
    name: 'inventory.list_low_stock', title: '低于安全库存', risk: 'read', permission: 'inventory:stock:read', modules: ['inventory'], implemented: true,
    description: '按物料汇总库存与缺口（safety_stock 对比），用于补货决策',
    inputSchema: S({
      keyword: { type: 'string' },
      limit: { type: 'integer', default: 20, maximum: 100 },
    }),
  },
  {
    name: 'inventory.list_batches', title: '批次列表', risk: 'read', permission: 'inventory:batch:read', modules: ['inventory'], implemented: true,
    description: '批次维度库存明细，按到期日升序',
    inputSchema: S({
      keyword: { type: 'string' },
      warehouse: { type: 'string' },
      limit: { type: 'integer', default: 20, maximum: 100 },
    }),
  },
  {
    name: 'inventory.list_expiring', title: '临期批次', risk: 'read', permission: 'inventory:batch:read', modules: ['inventory'], implemented: true,
    description: 'N 天内（默认 30）到期的批次清单',
    inputSchema: S({
      days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
      keyword: { type: 'string' },
      warehouse: { type: 'string' },
      limit: { type: 'integer', default: 20, maximum: 100 },
    }),
  },

  // ---------------- BOM 齐套（7/8） ----------------
  {
    name: 'bom.check_kit_rate', title: '齐套率', risk: 'read', permission: 'bom:kit:read', modules: ['bom'], implemented: true,
    description: '给定产品与需求量，按启用 BOM 与当前库存算可配套数/齐套率/缺料行',
    inputSchema: S({
      product: { type: 'string', description: '产品编码或名称' },
      demand: { type: 'integer', minimum: 1, description: '需求量' },
      warehouse: { type: 'string', description: '限定仓库，缺省全部' },
    }, ['product', 'demand']),
  },
  {
    name: 'bom.explain_shortage', title: '缺料明细', risk: 'read', permission: 'bom:shortage:read', modules: ['bom'], implemented: true,
    description: '输出缺料行（应耗/可用/缺口），无缺料时为空数组 + 友好摘要',
    inputSchema: S({
      product: { type: 'string' },
      demand: { type: 'integer', minimum: 1 },
      warehouse: { type: 'string' },
    }, ['product', 'demand']),
  },

  // ---------------- 呆滞/效期预警（alert 模块，docs/11 §11.16） ----------------
  {
    name: 'alerts.list', title: '预警列表', risk: 'read', permission: 'alert:event:read', modules: ['alert'], implemented: true,
    description: '查呆滞/效期预警事件；可先 scan 由租户后台扫描生成。支持按状态/级别/关键字过滤',
    inputSchema: S({
      keyword: { type: 'string', description: '物料编码/名称/批次模糊匹配' },
      status: { type: 'string', enum: ['open', 'ack', 'ignored'] },
      severity: { type: 'string', enum: ['warning', 'critical'] },
      type: { type: 'string', enum: ['dead_stock', 'expiring'] },
      limit: { type: 'integer', default: 20, maximum: 100 },
    }),
  },
  {
    name: 'alerts.ack', title: '处理预警', risk: 'write', permission: 'alert:event:ack', modules: ['alert'], implemented: true,
    description: '确认或忽略一条预警事件（ack=确认处理，ignored=忽略）；同 idempotency_key 重试只生效一次',
    inputSchema: S({
      id: { type: 'integer', description: '预警事件 id（先用 alerts.list 取）' },
      status: { type: 'string', enum: ['ack', 'ignored'] },
      note: { type: 'string', description: '处理备注' },
      idempotency_key: { type: 'string', description: '幂等键，重试安全' },
    }, ['id', 'status', 'idempotency_key']),
  },

  // ---------------- P5 写工具（§11.7.4 强制 idempotency_key；risk=high 需 approval） ----------------
  {
    name: 'templates.create', title: '创建模板', risk: 'write', permission: 'template:write', modules: ['templates'], implemented: true,
    description: '创建标签模板。content 必须是合法模板 JSON（会过 validateAiTemplate 清洗，护栏 8）；'
      + '同 idempotency_key 重试只创建一次',
    inputSchema: S({
      name: { type: 'string' },
      category: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      content: { type: 'object', description: '模板设计 JSON（page/variables/elements）' },
      idempotency_key: { type: 'string', description: '幂等键，重试安全' },
    }, ['name', 'content', 'idempotency_key']),
  },
  {
    name: 'templates.update', title: '更新模板', risk: 'write', permission: 'template:write', modules: ['templates'], implemented: true,
    description: '更新模板内容并生成新版本（currentVersion + 1，可回滚）；同 idempotency_key 重试只生效一次',
    inputSchema: S({
      id: { type: 'integer' },
      name: { type: 'string', description: 'id 缺失时按名称定位' },
      content: { type: 'object' },
      idempotency_key: { type: 'string' },
    }, ['content', 'idempotency_key']),
  },
  {
    name: 'inventory.adjust', title: '库存调整（高危）', risk: 'high', permission: 'inventory:stock:adjust', modules: ['inventory'], implemented: true,
    description: '按批次调整库存：delta 正数入库、负数出库（不足整笔拒绝）。'
      + '无 approval_id 时只建审批单不改动库存；dry_run=true 可先预演',
    inputSchema: S({
      sku: { type: 'string' },
      warehouse: { type: 'string' },
      batch_no: { type: 'string' },
      delta: { type: 'number', description: '正数入库，负数出库' },
      reason: { type: 'string', minLength: 2 },
      idempotency_key: { type: 'string' },
      approval_id: { type: 'string', description: '高危操作确认令牌' },
      dry_run: { type: 'boolean', default: false },
    }, ['sku', 'warehouse', 'delta', 'reason', 'idempotency_key']),
  },
  {
    name: 'inventory.transfer', title: '库存调拨（高危）', risk: 'high', permission: 'inventory:stock:transfer', modules: ['inventory'], implemented: true,
    description: '批次跨仓调拨（批次号原样带过去，目标仓无该批次则新建一行）。需 approval；dry_run 可预演',
    inputSchema: S({
      sku: { type: 'string' }, from_warehouse: { type: 'string' }, to_warehouse: { type: 'string' },
      qty: { type: 'number' }, batch_no: { type: 'string', description: '只调这个批次，缺省按 FIFO 跨批次凑' },
      idempotency_key: { type: 'string' }, approval_id: { type: 'string' },
      dry_run: { type: 'boolean', default: false },
    }, ['sku', 'from_warehouse', 'to_warehouse', 'qty', 'idempotency_key']),
  },
  {
    name: 'print.submit_job', title: '提交打印（高危）', risk: 'high', permission: 'print:job:submit', modules: ['print'], implemented: true,
    description: 'D7：默认关闭，需 feature_flags[agent.print.submit]=true + approval_id。'
      + '单次 copies×rows ≤ 500（§11.7.7 护栏 5），走 print_labels 配额',
    inputSchema: S({
      template: { type: 'string', description: '模板 id 或名称' },
      copies: { type: 'integer', minimum: 1, maximum: 500 },
      rows: { type: 'array', items: { type: 'object' }, description: '数据行，缺省 1 行空数据' },
      printer_id: { type: 'integer' },
      idempotency_key: { type: 'string' },
      approval_id: { type: 'string' },
    }, ['template', 'copies', 'idempotency_key']),
  },
  {
    name: 'print.get_status', title: '查打印任务', risk: 'read', permission: 'print:job:read', modules: ['print'], implemented: true,
    description: '查询打印任务进度（submit_job 之后的轮询）',
    inputSchema: S({ job_id: { type: 'integer' } }, ['job_id']),
  },
  {
    name: 'print.estimate', title: '预估打印量', risk: 'read', permission: 'print:job:read', modules: ['print'], implemented: true,
    description: '按模板+份数+数据行预估标签总数与批次上限校验，不落库、不提交真实打印',
    inputSchema: S({
      template: { type: 'string', description: '模板 id 或名称（可选：不传则只按 copies×rows 估算）' },
      copies: { type: 'integer', minimum: 1 },
      rows: { type: 'array', items: { type: 'object' } },
    }, []),
  },
  {
    name: 'print.wait_for_job', title: '等待打印完成', risk: 'read', permission: 'print:job:read', modules: ['print'], implemented: true,
    description: '轮询任务直到终态（done/failed/canceled）；timeout_ms 上限 60s，避免长时间占用',
    inputSchema: S({
      job_id: { type: 'integer' },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 60000, default: 10000 },
      poll_ms: { type: 'integer', minimum: 100, maximum: 5000, default: 500 },
    }, ['job_id']),
  },
  {
    name: 'print.cancel_job', title: '取消打印任务（写）', risk: 'write', permission: 'print:job:write', modules: ['print'], implemented: true,
    description: '取消尚未完成的任务；写操作必须带 idempotency_key，重复取消同一 job 安全',
    inputSchema: S({
      job_id: { type: 'integer' },
      idempotency_key: { type: 'string' },
    }, ['job_id', 'idempotency_key']),
  },

  // ---------------- 2026-11-21 补齐：体验闭环 + 业务扩展（§10.37） ----------------
  {
    name: 'print.list_jobs', title: '历史任务列表', risk: 'read', permission: 'print:job:read', modules: ['print'], implemented: true,
    description: '分页查询打印任务历史（可按状态/模板过滤），返回任务摘要列表与下一页游标。配合 get_status 定位具体任务',
    inputSchema: S({
      status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'canceled'] },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      cursor: { type: 'integer', minimum: 1, description: '页码（从 1 起），兼容前端分页口径' },
      template: { type: 'string', description: '按模板 id 或名称过滤' },
    }),
  },
  {
    name: 'print.retry_job', title: '补打/重打（写）', risk: 'write', permission: 'print:job:write', modules: ['print'], implemented: true,
    description: '复用原任务数据与流水号补打/重打，避免重打产生新号；指定 seq 只补打该序号。写操作必须带 idempotency_key，重复调用只补打一次',
    inputSchema: S({
      job_id: { type: 'integer', description: '原任务 id（先用 list_jobs/get_status 取）' },
      seq: { type: 'array', items: { type: 'integer', minimum: 1 }, description: '指定补打的标签序号（1-based），缺省整单重打' },
      idempotency_key: { type: 'string' },
    }, ['job_id', 'idempotency_key']),
  },
  {
    name: 'print.preview', title: '预览标签（只读）', risk: 'read', permission: 'print:job:read', modules: ['print'], implemented: true,
    description: '按模板+数据行渲染 HTML 预览（变量/公式/流水号已求值），不落库、不提交真实打印。返回完整 HTML 与预估张数',
    inputSchema: S({
      template: { type: 'string', description: '模板 id 或名称' },
      rows: { type: 'array', items: { type: 'object' }, description: '数据行，缺省 1 行空数据' },
      copies: { type: 'integer', minimum: 1, maximum: 500, default: 1 },
    }, ['template']),
  },
  {
    name: 'print.commands', title: '导出打印指令（只读）', risk: 'read', permission: 'print:job:read', modules: ['print'], implemented: true,
    description: '按模板+数据行导出 ZPL/TSPL/EPL 指令文本，供人工审核后再决定是否提交打印；不落库、不发送打印机',
    inputSchema: S({
      template: { type: 'string', description: '模板 id 或名称' },
      rows: { type: 'array', items: { type: 'object' } },
      copies: { type: 'integer', minimum: 1, maximum: 500, default: 1 },
      protocol: { type: 'string', enum: ['zpl', 'tspl', 'epl'], default: 'zpl' },
      dpi: { type: 'integer', minimum: 96, maximum: 1200 },
    }, ['template']),
  },
  {
    name: 'printers.list', title: '打印机列表', risk: 'read', permission: 'print:job:read', modules: ['print'], implemented: true,
    description: '列出当前租户可用打印机（id/名称/类型/协议/纸张规格/是否默认），供 Agent 选打印机',
    inputSchema: S({}),
  },
  {
    name: 'printers.status', title: '打印机连通性', risk: 'read', permission: 'print:job:read', modules: ['print'], implemented: true,
    description: '测试单台打印机连通性（raw_tcp 真实建连，其它通道只校验参数/标注由代理完成），只读不改配置',
    inputSchema: S({ id: { type: 'integer' } }, ['id']),
  },
  {
    name: 'datasource.refresh', title: '刷新数据源（写）', risk: 'write', permission: 'datasource:write', modules: ['datasource'], implemented: true,
    description: '手动触发 SQL 数据源刷新（真执行 SQL 落 data_rows），用于「数据到位→打印」链路。写操作必须带 idempotency_key，重复刷新同一 key 不重复执行',
    inputSchema: S({
      id: { type: 'integer', description: '数据源 id（用 datasource 列表页取）' },
      idempotency_key: { type: 'string' },
    }, ['id', 'idempotency_key']),
  },
];

export function findTool(name: string): ToolDef | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

/** describe_capabilities / GET tools：scope 覆盖 + 订阅模块命中、且有执行器的工具 */
export function visibleTools(scopes: string[], activeModules: string[]): ToolDef[] {
  return AGENT_TOOLS.filter((t) => t.implemented
    && (!t.permission || matchPermission(scopes, t.permission))
    && (!t.modules.length || t.modules.some((m) => activeModules.includes(m))));
}

/** 给 MCP / REST 用的精简清单（不泄露执行细节） */
export function catalogDto(tools: ToolDef[]) {
  return tools.map((t) => ({
    name: t.name, title: t.title, description: t.description,
    permission: t.permission, modules: t.modules, risk: t.risk, implemented: t.implemented,
    inputSchema: t.inputSchema,
  }));
}

/** 高危工具：无有效 approval 只能建审批单（§11.7.6） */
export function needsApproval(tool: ToolDef): boolean {
  return tool.risk === 'high';
}

/** 写/高危工具：强制幂等键（§11.7.4 / §11.7.7 护栏 4） */
export function isWriteTool(tool: ToolDef): boolean {
  return tool.risk !== 'read';
}
