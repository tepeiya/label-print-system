// 模块依赖展开（docs/11 §11.3.4）——纯函数，开通/停用/展开套餐都要用
// 规则：开通时自动补齐前置模块；停用时若被其它已开通模块依赖则拒绝。
export interface ModuleDef {
  code: string;
  dependsOn?: string[];
  isCore?: boolean;
}

/** 目录里查依赖；目录里没有的 code 视为无依赖（容忍历史脏数据，不让开通整体失败） */
function depsOf(code: string, catalog: ModuleDef[]): string[] {
  return catalog.find((m) => m.code === code)?.dependsOn ?? [];
}

/**
 * 传递闭包展开：输入 ['bom'] + 目录 bom→inventory→masterdata，输出 ['bom','inventory','masterdata']
 * 保序：先原顺序，再按依赖发现顺序追加；自带环检测（重复访问直接跳过）。
 */
export function expandWithDependencies(codes: string[], catalog: ModuleDef[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (code: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    out.push(code);
    for (const dep of depsOf(code, catalog)) walk(dep);
  };
  for (const c of codes ?? []) walk(c);
  return out;
}

/**
 * 停用前检查：返回依赖它的模块 code 列表，非空则应拒绝并提示「请先停用 X」。
 */
export function blockedByOnDisable(code: string, activeCodes: string[], catalog: ModuleDef[]): string[] {
  return (activeCodes ?? []).filter(
    (c) => c !== code && depsOf(c, catalog).includes(code),
  );
}

/** 依赖是否存在于目录中（平台配置套餐时的校验，缺依赖说明目录没配全） */
export function missingDependencies(codes: string[], catalog: ModuleDef[]): string[] {
  const known = new Set(catalog.map((m) => m.code));
  const missing: string[] = [];
  for (const c of codes ?? []) {
    for (const dep of depsOf(c, catalog)) {
      if (!known.has(dep) && !missing.includes(dep)) missing.push(dep);
    }
  }
  return missing;
}
