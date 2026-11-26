#!/usr/bin/env node
// =============================================================================
// scripts/check-entity-registration.mjs
//
// 背景（真实事故）：2026-11-26 建物料接口 500 —— MaterialFieldDefinition 被
//   @InjectRepository 注入，却没在 src/entities/index.ts 导出，主 DataSource 没有它的
//   元数据，Repository.find() 直接 throw "No metadata for ... was found"。
//   同类漏注册还有 AlertRule / AlertEvent / AiQuota。这类错在编译期不报、启动也不报，
//   只在第一次调用该接口时炸，属于"上线才炸"的坑。
//
// 用法：node scripts/check-entity-registration.mjs   （在 backend 目录执行）
// 退出码：0 全部已注册；1 有缺失（CI 应拦）
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const INDEX = path.join(SRC, 'entities', 'index.ts');

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) {
      if (f === '__tests__' || f === 'node_modules' || f === 'dist') continue;
      walk(p, out);
    } else if (f.endsWith('.ts') && !f.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function resolveModule(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/** 递归收集 index.ts 最终能对外导出的类名 */
function collectExported(indexFile, seen = new Set(), classes = new Set()) {
  if (seen.has(indexFile) || !fs.existsSync(indexFile)) return classes;
  seen.add(indexFile);
  const src = fs.readFileSync(indexFile, 'utf8');

  for (const m of src.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveModule(indexFile, m[1]);
    if (target) collectExported(target, seen, classes);
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const item of m[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/).pop().trim();
      if (name) classes.add(name);
    }
  }
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?class\s+(\w+)/g)) {
    classes.add(m[1]);
  }
  return classes;
}

const injected = new Map(); // entity name -> [files]
for (const file of walk(SRC)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/@InjectRepository\(\s*(\w+)/g)) {
    const name = m[1];
    if (!injected.has(name)) injected.set(name, []);
    injected.get(name).push(path.relative(ROOT, file));
  }
}

const exported = collectExported(INDEX);

// `DataSource as DS` 这类别名不是类名，按"名字里带 DataSource"放过；其余缺失必须报
const missing = [...injected.keys()].filter((n) => !exported.has(n) && n !== 'DataSource' && !/^DS$/.test(n));

console.log(`注入实体 ${injected.size} 个，entities/index.ts 可导出 ${exported.size} 个类`);
if (!missing.length) {
  console.log('✓ 所有 @InjectRepository 的实体都已注册到主 DataSource');
  process.exit(0);
}
console.error(`✗ ${missing.length} 个实体被注入但未注册（第一次调用会 throw No metadata）：`);
for (const n of missing) console.error(`  · ${n}  ← ${injected.get(n).join(', ')}`);
console.error('修法：在 src/entities/index.ts 里 export 它（注意 export * 只管到该文件的所有 export class）');
process.exit(1);
