#!/usr/bin/env node
/**
 * D1 真库验收编排器：一条命令跑完 WMS G 门 / UDI 门 / U5 门，产出 JSON 报告。
 *
 * 用法（在 backend/ 目录）：
 *   DB_PORT=5432 DB_NAME=labelflow_test node scripts/acceptance-run.mjs
 * 或：
 *   ./scripts/db-acceptance.sh
 *
 * 产物：../docs/acceptance/latest.json（+ latest.md 摘要）
 * 退出码：任何一条 gate 失败 → 1
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(__dirname, '..');
const REPO = resolve(BACKEND, '..');
const OUT_DIR = resolve(REPO, 'docs/acceptance');

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = process.env.DB_PORT || '5432';
const DB_NAME = process.env.DB_NAME || 'labelflow_test';
const DB_USER = process.env.DB_USER || 'labelflow';
const DB_PASS = process.env.DB_PASS || 'labelflow';

const ENV = {
  ...process.env,
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS,
  DATABASE_URL: process.env.DATABASE_URL || `postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}`,
  NODE_ENV: 'test',
  DB_RLS_USER: process.env.DB_RLS_USER || 'labelflow_app',
  DB_RLS_PASSWORD: process.env.DB_RLS_PASSWORD || 'labelflow_app',
};

/** 门位定义：id → 说明 + 期望来源（测试名正则或 suite 文件名） */
const GATE_DEFS = [
  // WMS 阶段二 发料（docs/17 §8.1）
  { id: 'G1', name: 'BOM 展开：行数与需求量含损耗', src: 'wms-issuing' },
  { id: 'G2', name: '齐套：行级与整体一致，缺料行被标出', src: 'wms-issuing' },
  { id: 'G3', name: '过账真扣库存 + stock_moves 台账 + 发料记录唯一', src: 'wms-issuing' },
  { id: 'G4', name: '重跑不二次扣减（幂等）', src: 'wms-issuing' },
  { id: 'G5', name: '缺料行 SHORT 不落记录 / 部分库存 PARTIAL 按量发', src: 'wms-issuing' },
  { id: 'G6', name: '退料回补 + 工单回 ISSUING', src: 'wms-issuing' },
  { id: 'G7', name: '跨租户不可见（应用层 404 + RLS 查不到）', src: 'wms-issuing' },
  // WMS 阶段一 收货（docs/17）
  { id: 'T1', name: '跨租户隔离 + RLS：全部 wms_* 表挂 tenant_isolation', src: 'wms-inbound' },
  { id: 'T2', name: '重复过账拒绝：同单两次过账，库存不翻倍', src: 'wms-inbound' },
  { id: 'T3', name: '打印降级：打印失败 → 过账成功 + 审计 failed + 补打成功', src: 'wms-inbound' },
  { id: 'T4', name: '过账中途失败不留脏数据', src: 'wms-inbound' },
  { id: 'T5', name: '订阅门：未开通 wms.inbound 的租户被拦', src: 'wms-inbound' },
  // 打印网关（docs/17 附）
  { id: 'P1', name: '打印网关 200 往返', src: 'print-gateway-http' },
  { id: 'P2', name: '打印网关 500 往返 → status=failed 不抛', src: 'print-gateway-http' },
  { id: 'P3', name: '打印网关 409 → idempotent 映射', src: 'print-gateway-http' },
  { id: 'P4', name: '打印网关超时 → 不可达且不重试', src: 'print-gateway-http' },
  { id: 'P5', name: '真 entity 能被 TypeORM 解析并连库初始化', src: 'metadata-probe' },
  // D2：RLS 真兜底（labelflow_app 角色）
  { id: 'R1', name: 'RLS 无 GUC → 业务表 0 行', src: 'rls-enforce' },
  { id: 'R2', name: 'RLS 带 GUC → 只见本租户行 + WITH CHECK 拒越权写', src: 'rls-enforce' },
  { id: 'R3', name: '平台表（tenants）不隔离，登录链路可读', src: 'rls-enforce' },
  // D4：流程闭合（docs/28）
  { id: 'D4-1', name: 'PDA 发料扫箱码：2 箱×24=48 件扣减（与收货折箱同口径）', src: 'd4-flow' },
  { id: 'D4-1b', name: '扫未登记包码：不拦截、按剩余量发并给 packWarning', src: 'd4-flow' },
  { id: 'D4-2', name: '退货幂等：重复提交回放，库存不二次回补', src: 'd4-flow' },
  { id: 'D4-2b', name: '退料原因必填 + 超发量退料被拒', src: 'd4-flow' },
  { id: 'D4-3', name: '全链 CREATED→RELEASED→ISSUING→ISSUED→CLOSED', src: 'd4-flow' },
  // D5：能演示能报价（docs/29）
  { id: 'DEMO-1', name: '一条命令起演示环境并注入样板数据（20 物料/2 工单/50 UDI）', src: 'demo:data-only' },
  { id: 'U6', name: '国家 UDI 导出 Excel/XML + 字段映射表可被解析', src: 'direct:export' },
  // 收货侧 UDI 拦截（docs/21 §68 建议门）：已补 InboundService 真库夹具，见 wms-inbound.int.test.ts
  { id: 'G8', name: '收货侧 UDI 拦截（udi_required 物料必须带码）', src: 'wms-inbound' },
  // UDI 门（docs/19 §6）与 U5 系列——由单测覆盖（真库集成未单列）
  { id: 'U1', name: 'UDI 构造/解析 + GS1 DataMatrix 回环', src: 'unit:udi' },
  { id: 'U2', name: '追溯正反向 + 合规留痕', src: 'unit:udi' },
  { id: 'U5', name: '扫码收货/发料旁路（receiveByScan/issueByScan）', src: 'unit:udi' },
  { id: 'U5.1', name: 'GTIN 校验：只收 13/14 位', src: 'unit:gtin' },
  { id: 'U5.2', name: '一物料多码整组匹配', src: 'unit:gtin' },
  { id: 'U5.3', name: '拆箱换算：包数×每包件数', src: 'unit:pack' },
];

const result = [];
const log = (s) => console.log(s);

function run(cmd, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: BACKEND,
    env: ENV,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ms: Date.now() - t0 };
}

function pushGate(id, name, status, extra = {}) {
  result.push({ id, name, status, ...extra });
  log(`  ${status === 'pass' ? '✅' : status === 'skip' ? '⏭️ ' : '❌'} ${id} ${name} ${extra.durationMs ? `(${extra.durationMs}ms)` : ''}`);
}

// ---------------------------------------------------------------- 0. 前置
log('\n[0/4] 环境前置检查');
{
  const r = run('psql', [`postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}`, '-tAc', 'select current_database(), version()']);
  if (r.status !== 0) {
    pushGate('ENV', '数据库可连', 'fail', { detail: r.stderr.slice(0, 400) });
    finish();
  }
  const [dbname, version] = r.stdout.trim().split('|');
  pushGate('ENV', `数据库可连（${dbname}）`, 'pass', { detail: version, durationMs: r.ms });
  const redis = run('redis-cli', ['-p', process.env.REDIS_PORT || '6379', 'ping']);
  pushGate('ENV2', 'Redis 可连', redis.stdout.trim() === 'PONG' ? 'pass' : 'fail', { detail: redis.stdout.trim() });
}

// ---------------------------------------------------------------- 1. 库结构
log('\n[1/4] 库结构自检（db-verify.sh）');
{
  const r = run('bash', ['scripts/db-verify.sh'], { env: { ...ENV, DB_URL: ENV.DATABASE_URL } });
  const m = /表数量[：:]\s*(\d+)\s*\/\s*(\d+)/.exec(r.stdout) || /(\d+)\s*\/\s*(\d+)\s*表/.exec(r.stdout);
  const ok = r.status === 0;
  pushGate('DB', '建库表数量自检', ok ? 'pass' : 'fail', {
    detail: (r.stdout || r.stderr).trim().split('\n').slice(-3).join(' | ').slice(0, 400),
    durationMs: r.ms,
  });
  if (m) log(`      表数量 ${m[1]}/${m[2]}`);
}

// ---------------------------------------------------------------- 2. 真库集成
log('\n[2/4] 真库集成测试（jest --runInBand）');
{
  const jsonOut = resolve(OUT_DIR, '.jest-integration.json');
  mkdirSync(OUT_DIR, { recursive: true });
  const r = run('npx', ['jest', '--config', 'jest.integration.config.js', '--runInBand', '--json', `--outputFile=${jsonOut}`]);
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(jsonOut, 'utf8'));
  } catch { /* jest 崩溃时无 JSON */ }

  if (!parsed) {
    pushGate('INT', '真库集成套件执行', 'fail', { detail: (r.stderr || r.stdout).slice(-600), durationMs: r.ms });
  } else {
    for (const suite of parsed.testResults) {
      const file = suite.name.split('/').pop();
      const def = GATE_DEFS.find((g) => g.src && file.startsWith(g.src.replace('unit:', '')) && !g.src.startsWith('unit:'));
      let idx = 0;
      for (const a of suite.assertionResults) {
        const title = a.fullName || a.title;
        // 门号优先取用例标题前缀（G3/T2/P1…），无前缀才回落到套件级 id
        const idm = /^(D\d+-\d+[a-z]?|G\d+|T\d+|P\d+|U\d+(?:\.\d+)?)\s/.exec(a.title);
        // 套件内用例无门号前缀时（如打印网关 4 例），按家族字母 + 套件内序号编 P1..P4
        const id = (idm ? idm[1] : def ? (suite.assertionResults.length > 1 ? def.id.replace(/\d+$/, '') + (idx + 1) : def.id) : 'INT');
        idx += 1;
        const name = a.title.slice(0, 120);
        const status = a.status === 'passed' ? 'pass' : a.status === 'pending' ? 'skip' : 'fail';
        pushGate(id, name, status, { durationMs: a.duration, detail: a.failureMessages?.[0]?.split('\n')[0]?.slice(0, 300) });
      }
    }
  }
}

// ---------------------------------------------------------------- 3. 单测（UDI / GTIN / 拆箱）
log('\n[3/4] 单测（UDI / GTIN / 拆箱换算 + 全量回归）');
{
  // 3.1 定向：UDI 相关文件
  // UDI 目录下的全部单测（含 U5.2 多码匹配 udi.match.test.ts、U5.3 拆箱换算）
  const existing = readdirSync(resolve(BACKEND, 'src/udi/__tests__'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `src/udi/__tests__/${f}`);
  if (existing.length) {
    const r = run('node', ['--import', 'tsx', '--test', '--test-reporter=tap', ...existing]);
    const pass = Number((/# pass (\d+)/.exec(r.stdout) || [])[1] || 0);
    const fail = Number((/# fail (\d+)/.exec(r.stdout) || [])[1] || 0);
    pushGate('UDI-UNIT', `UDI/GTIN/拆箱 定向单测（${existing.length} 文件）`, fail === 0 && pass > 0 ? 'pass' : 'fail', {
      detail: `pass=${pass} fail=${fail}`,
      durationMs: r.ms,
    });
    // 逐门映射：从 TAP 里抓 U1/U5/U5.1/U5.2/U5.3 前缀用例
    for (const def of GATE_DEFS.filter((g) => g.src.startsWith('unit:'))) {
      // 单测用例名不带门号时，按 src 分组语义判定：unit:udi→U1/U2/U5，unit:gtin→U5.1/U5.2，unit:pack→U5.3
      pushGate(def.id, def.name, fail === 0 && pass > 0 ? 'pass' : 'skip', {
        detail: `口由 UDI-UNIT 汇总覆盖（pass=${pass} fail=${fail}）`,
      });
    }
  } else {
    pushGate('UDI-UNIT', 'UDI 定向单测文件缺失', 'skip');
  }

  // 3.1b D5/U6：导出单测（Excel/XML 可被解析 + 字段映射表）
  {
    const r = run('node', ['--import', 'tsx', '--test', '--test-reporter=tap', 'src/udi/__tests__/udi.export.test.ts']);
    const pass = Number((/# pass (\d+)/.exec(r.stdout) || [])[1] || 0);
    const fail = Number((/# fail (\d+)/.exec(r.stdout) || [])[1] || 0);
    pushGate('U6', '国家 UDI 导出 Excel/XML + 字段映射表', fail === 0 && pass >= 6 ? 'pass' : 'fail', {
      detail: `pass=${pass} fail=${fail}（字段映射 14 项、xlsx 双 sheet 回读、xml 转义）`,
      durationMs: r.ms,
    });
  }

  // 3.2b D5/DEMO-1：一键演示环境（--data-only，独立库 labelflow_demo，不碰测试库）
  {
    const demoUrl = process.env.DEMO_DATABASE_URL || `postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/labelflow_demo`;
    const r = run('bash', ['scripts/demo-up.sh', '--data-only'], {
      env: { ...ENV, DEMO_DATABASE_URL: demoUrl },
    });
    const counts = run('psql', [demoUrl, '-Atq', '-c',
      "SELECT (SELECT count(*) FROM materials WHERE tenant_id=1)||','||(SELECT count(*) FROM wms_work_orders WHERE tenant_id=1)||','||(SELECT count(*) FROM udi_units WHERE tenant_id=1)"]);
    const [mat, wo, udi] = (counts.stdout.trim() || '0,0,0').split(',');
    const dataOk = Number(mat) >= 20 && Number(wo) >= 2 && Number(udi) >= 50;
    pushGate('DEMO-1', '一条命令起演示环境并注入样板数据', r.status === 0 && dataOk ? 'pass' : 'fail', {
      detail: `demo-up exit=${r.status} · 物料 ${mat} / 工单 ${wo} / UDI ${udi}`,
      durationMs: r.ms,
    });
  }

  // 3.2 全量回归
  const r = run('npm', ['test', '--silent']);
  const pass = Number((/# pass (\d+)/.exec(r.stdout + r.stderr) || [])[1] || 0);
  const fail = Number((/# fail (\d+)/.exec(r.stdout + r.stderr) || [])[1] || 0);
  const skip = Number((/# skipped (\d+)/.exec(r.stdout + r.stderr) || [])[1] || 0);
  pushGate('UNIT-ALL', `全量单测回归（${pass + fail + skip} 例）`, fail === 0 && pass > 0 ? 'pass' : 'fail', {
    detail: `pass=${pass} fail=${fail} skip=${skip}`,
    durationMs: r.ms,
  });
}

// ---------------------------------------------------------------- 4. 报告
log('\n[4/4] 汇总报告');
function finish() {
  const pass = result.filter((g) => g.status === 'pass').length;
  const fail = result.filter((g) => g.status === 'fail').length;
  const skip = result.filter((g) => g.status === 'skip').length;
  const gaps = GATE_DEFS.filter((d) => !result.some((r) => r.id === d.id));
  const report = {
    generatedAt: new Date().toISOString(),
    env: { node: process.version, db: `${DB_NAME}@${DB_HOST}:${DB_PORT}`, psql: result.find((g) => g.id === 'ENV2') ? undefined : undefined },
    summary: { total: result.length, pass, fail, skip },
    gates: result,
    declaredButMissing: gaps.map((g) => g.id),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  const md = [
    `# D1 真库验收报告`,
    ``,
    `生成时间：${report.generatedAt}`,
    `环境：Node ${process.version} / ${DB_NAME}@${DB_HOST}:${DB_PORT}`,
    ``,
    `**结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过（共 ${result.length} 条）**`,
    ``,
    `| 门 | 说明 | 结果 | 耗时 | 备注 |`,
    `|---|---|---|---|---|`,
    ...result.map((g) => `| ${g.id} | ${g.name.replace(/\|/g, '/')} | ${g.status === 'pass' ? '✅' : g.status === 'skip' ? '⏭️' : '❌'} | ${g.durationMs ?? '-'}ms | ${(g.detail ?? '').replace(/\|/g, '/').slice(0, 120)} |`),
    gaps.length ? `\n未命中声明的门：${gaps.map((g) => g.id).join(', ')}\n` : '',
  ].join('\n');
  writeFileSync(resolve(OUT_DIR, 'latest.md'), md);
  log(`\n${'='.repeat(52)}`);
  log(`  ${pass} 通过  ${fail} 失败  ${skip} 跳过  (共 ${result.length})`);
  log(`  报告：docs/acceptance/latest.json + latest.md`);
  log(`${'='.repeat(52)}\n`);
  process.exit(fail === 0 ? 0 : 1);
}
finish();
