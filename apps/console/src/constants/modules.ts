// 模块码 → 中文名（前端展示用文案表，不是菜单/权限来源）
//
// 权威目录在后端 modules 表：已订阅的模块走 /auth/me.modules 与 /subscription.moduleDetails
// 拿到名称/图标/说明，不需要这张表。这里只覆盖「租户还没订阅、所以接口里查不到」的模块名，
// 用于 /blocked 的提示和订阅页的升级引导。/platform/modules 是 admin only，租户端拿不到全量目录。
// 新模块上线时补一行即可；漏了也不会报错，只是显示英文 code。
export const MODULE_LABELS: Record<string, string> = {
  print: '标签打印',
  templates: '模板管理',
  ai: 'AI 模板生成',
  users: '用户与角色',
  serial: '流水号',
  datasource: '数据源',
  backup: '备份恢复',
  audit: '审计日志',
  masterdata: '基础资料',
  inventory: '库存管理',
  bom: '齐套率',
  alert: '呆滞/效期预警',
  agent: '智能体接入',
};

export const moduleName = (code: string): string => MODULE_LABELS[code] ?? code;
