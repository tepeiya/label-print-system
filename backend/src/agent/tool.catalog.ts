// =============================================================================
// tool.catalog —— Agent 工具目录（docs/11 §11.7.2 工具矩阵）
// 纯数据 + 纯函数：whoami / list_modules / describe_capabilities 由此驱动，
// MCP server 启动时 GET /agent/v1/tools 直接拿它注册工具。
//
// ⚠️ 权限点用库内真实码（两段式 template:read/write），与文档 print:template:* 的
//    出入见 docs/10 §10.20 偏离说明。
// implemented=false 的行 = 已注册但 P4 无执行器（调用返回 400「后续版本开放」；
//    只读 token 打高危工具会先在 scope 检查处 403，满足 §11.11.2 验收）。
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
  /** P4 是否有执行器 */
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
    name: 'bom.check_kit_rate', title: '齐套率', risk: 'read', permission: 'bom:kit:read', modules: ['inventory', 'bom'], implemented: true,
    description: '给定产品与需求量，按启用 BOM 与当前库存算可配套数/齐套率/缺料行',
    inputSchema: S({
      product: { type: 'string', description: '产品编码或名称' },
      demand: { type: 'integer', minimum: 1, description: '需求量' },
      warehouse: { type: 'string', description: '限定仓库，缺省全部' },
    }, ['product', 'demand']),
  },
  {
    name: 'bom.explain_shortage', title: '缺料明细', risk: 'read', permission: 'bom:shortage:read', modules: ['inventory', 'bom'], implemented: true,
    description: '输出缺料行（应耗/可用/缺口），无缺料时为空数组 + 友好摘要',
    inputSchema: S({
      product: { type: 'string' },
      demand: { type: 'integer', minimum: 1 },
      warehouse: { type: 'string' },
    }, ['product', 'demand']),
  },

  // ---------------- 已注册、P4 无执行器（P5 接线） ----------------
  {
    name: 'templates.create', title: '创建模板', risk: 'write', permission: 'template:write', modules: ['templates'], implemented: false,
    description: '（P5 开放）创建标签模板',
    inputSchema: S({ name: { type: 'string' }, content: { type: 'object' } }, ['name', 'content']),
  },
  {
    name: 'templates.update', title: '更新模板', risk: 'write', permission: 'template:write', modules: ['templates'], implemented: false,
    description: '（P5 开放）更新模板内容',
    inputSchema: S({ id: { type: 'integer' }, content: { type: 'object' } }, ['id', 'content']),
  },
  {
    name: 'inventory.adjust', title: '库存调整（高危）', risk: 'high', permission: 'inventory:stock:adjust', modules: ['inventory'], implemented: false,
    description: '（P5 开放，需 approval）按 idempotency_key 幂等调整批次库存',
    inputSchema: S({
      sku: { type: 'string' },
      warehouse: { type: 'string' },
      batch_no: { type: 'string' },
      delta: { type: 'number', description: '正数入库，负数出库' },
      reason: { type: 'string', minLength: 2 },
      idempotency_key: { type: 'string' },
      approval_id: { type: 'string' },
      dry_run: { type: 'boolean', default: false },
    }, ['sku', 'warehouse', 'delta', 'reason', 'idempotency_key']),
  },
  {
    name: 'inventory.transfer', title: '库存调拨（高危）', risk: 'high', permission: 'inventory:stock:transfer', modules: ['inventory'], implemented: false,
    description: '（P5 开放，需 approval）批次跨仓调拨',
    inputSchema: S({
      sku: { type: 'string' }, from_warehouse: { type: 'string' }, to_warehouse: { type: 'string' },
      qty: { type: 'number' }, idempotency_key: { type: 'string' }, approval_id: { type: 'string' },
    }, ['sku', 'from_warehouse', 'to_warehouse', 'qty', 'idempotency_key']),
  },
  {
    name: 'print.submit_job', title: '提交打印（高危）', risk: 'high', permission: 'print:job:submit', modules: ['print'], implemented: false,
    description: '（P5 开放）D7：默认关闭，需 feature_flags[agent.print.submit]=true + approval_id',
    inputSchema: S({
      template: { type: 'string', description: '模板 id 或名称' },
      copies: { type: 'integer', minimum: 1 },
      idempotency_key: { type: 'string' },
      approval_id: { type: 'string' },
    }, ['template', 'copies', 'idempotency_key']),
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
