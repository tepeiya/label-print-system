#!/usr/bin/env node
// =============================================================================
// labelctl.mjs —— LabelFlow 命令行工具（无依赖，Node 18+）
//
// 用法：
//   node tools/labelctl.mjs login
//   node tools/labelctl.mjs templates [--keyword 关键] [--category 分类]
//   node tools/labelctl.mjs template <id>
//   node tools/labelctl.mjs printers
//   node tools/labelctl.mjs print --template 3 --rows data.csv [--copies 2] [--printer 1]
//   node tools/labelctl.mjs commands --template 3 [--protocol zpl|tspl] [--rows data.csv] [-o out.zpl]
//   node tools/labelctl.mjs jobs [--status queued] [--limit 10]
//   node tools/labelctl.mjs retry <jobId> [--seq 1,3]
//   node tools/labelctl.mjs audit [--limit 10]
//
// 环境变量：
//   LABELFLOW_API   后端地址，默认 http://localhost:3200/api/v1
//   LABELFLOW_USER  用户名，默认 admin
//   LABELFLOW_PASS  密码，默认 admin123
//   LABELFLOW_TOKEN 直接指定 JWT（优先于账号密码）
// =============================================================================

import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = (process.env.LABELFLOW_API || 'http://localhost:3200/api/v1').replace(/\/$/, '');
const USER = process.env.LABELFLOW_USER || 'admin';
const PASS = process.env.LABELFLOW_PASS || 'admin123';
const TOKEN_FILE = join(homedir(), '.labelflow-token.json');

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function cachedToken() {
  if (process.env.LABELFLOW_TOKEN) return process.env.LABELFLOW_TOKEN;
  try {
    const j = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    // 预留 60s 余量，避免临界过期
    if (j.token && j.exp * 1000 > Date.now() + 60000) return j.token;
  } catch { /* 未登录 */ }
  return null;
}

async function login() {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const j = await r.json().catch(() => ({}));
  const token = j?.data?.accessToken || j?.data?.token || j?.accessToken;
  if (!r.ok || !token) throw new Error(`登录失败：${j?.message ?? r.status}`);
  const exp = decodeExp(token) || Date.now() / 1000 + 3600;
  writeFileSync(TOKEN_FILE, JSON.stringify({ token, exp }, null, 0), { mode: 0o600 });
  return token;
}

function decodeExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp;
  } catch { return null; }
}

async function req(method, path, body) {
  let token = cachedToken();
  if (!token) token = await login();
  const doReq = (tk) => fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let r = await doReq(token);
  if (r.status === 401) {
    token = await login();       // token 过期：重新登录一次
    r = await doReq(token);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code !== undefined && j.code !== 0)) {
    throw new Error(`${method} ${path} 失败：${j?.message ?? r.status}`);
  }
  return j.data ?? j;
}

// ---------------------------------------------------------------------------
// CSV / JSON 数据行
// ---------------------------------------------------------------------------
function parseCsv(text, delimiter) {
  const raw = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const delim = delimiter ?? (raw.split('\n')[0].includes('\t') ? '\t' : ',');
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const cleaned = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!cleaned.length) return [];
  const header = cleaned[0].map((s) => s.trim());
  return cleaned.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

async function loadRows(file) {
  if (!file) return [{}];
  const text = await readFile(file, 'utf8');
  if (/\.[jt]son$/i.test(file)) {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : (j.rows ?? []);
    return arr.length ? arr : [{}];
  }
  const rows = parseCsv(text);
  return rows.length ? rows : [{}];
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const printJson = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

/** 兼容两种返回：[[rows,total]]（TypeORM findAndCount）与 [row,...] */
function toRows(data) {
  if (Array.isArray(data)) return Array.isArray(data[0]) ? data[0] : data;
  return data?.rows ?? data?.list ?? [];
}

function table(rows, cols) {
  if (!rows.length) { console.log('(空)'); return; }
  const widths = cols.map((c) => Math.max(String(c.label).length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (cells) => cells.map((s, i) => String(s ?? '').padEnd(widths[i])).join('  ');
  console.log(line(cols.map((c) => c.label)));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => r[c.key])));
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------
async function cmdTemplates(opts) {
  const q = new URLSearchParams();
  if (opts.keyword) q.set('keyword', opts.keyword);
  if (opts.category) q.set('category', opts.category);
  if (opts.limit) q.set('pageSize', String(opts.limit));
  const data = await req('GET', `/templates?${q}`);
  const rows = toRows(data);
  if (opts.json) return printJson(rows);
  table(rows, [
    { label: 'ID', key: 'id' },
    { label: '名称', key: 'name' },
    { label: '分类', key: 'category' },
    { label: '版本', key: 'currentVersion' },
    { label: '更新于', key: 'updatedAt' },
  ]);
}

async function cmdTemplate(opts) {
  const t = await req('GET', `/templates/${opts.id}`);
  printJson(t);
}

async function cmdPrinters() {
  const data = await req('GET', '/printers');
  const list = toRows(data);
  table(list, [
    { label: 'ID', key: 'id' },
    { label: '名称', key: 'name' },
    { label: '型号', key: 'model' },
    { label: '状态', key: 'status' },
  ]);
  return list;
}

async function resolvePrinterId(explicit) {
  if (explicit) return Number(explicit);
  const data = await req('GET', '/printers');
  const list = toRows(data);
  const online = list.find((p) => String(p.status).toLowerCase() === 'online') ?? list[0];
  return online?.id;
}

async function cmdPrint(opts) {
  if (!opts.template) throw new Error('缺少 --template <id>');
  const templateId = Number(opts.template);
  const rows = await loadRows(opts.rows);
  const copies = Math.max(1, Number(opts.copies ?? 1));
  const printerId = await resolvePrinterId(opts.printer);
  const job = await req('POST', '/print/jobs', { templateId, printerId, rows, copies });
  console.log(`已入队 job #${job.jobId}：${rows.length} 行 × ${copies} 份 = ${job.total} 张（${job.status}）`);
  return job;
}

async function cmdCommands(opts) {
  if (!opts.template) throw new Error('缺少 --template <id>');
  const tpl = await req('GET', `/templates/${opts.template}`);
  const rows = await loadRows(opts.rows);
  const page = tpl.content?.page ?? {};
  const out = await req('POST', '/print/commands', {
    templateContent: tpl.content,
    rows,
    copies: Math.max(1, Number(opts.copies ?? 1)),
    protocol: (opts.protocol === 'tspl' ? 'tspl' : 'zpl'),
    dpi: page.dpi ?? 300,
    widthMm: page.widthMm,
    heightMm: page.heightMm,
    gapMm: page.gapMm ?? 2,
    offsetXMm: page.offsetXMm ?? 0,
    offsetYMm: page.offsetYMm ?? 0,
  });
  if (opts.out) await writeFile(opts.out, out.text, 'utf8');
  else process.stdout.write(out.text + '\n');
  if (out.warnings?.length) console.error('提示：' + out.warnings.join('；'));
  return out;
}

async function cmdJobs(opts) {
  const q = new URLSearchParams();
  if (opts.status) q.set('status', opts.status);
  if (opts.limit) q.set('pageSize', String(opts.limit));
  const data = await req('GET', `/print/jobs?${q}`);
  const rows = toRows(data);
  table(rows, [
    { label: 'ID', key: 'id' },
    { label: '模板', key: 'templateId' },
    { label: '打印机', key: 'printerId' },
    { label: '张数', key: 'total' },
    { label: '状态', key: 'status' },
    { label: '创建于', key: 'createdAt' },
  ]);
}

async function cmdRetry(opts) {
  if (!opts.id) throw new Error('缺少任务 ID');
  const seqNos = opts.seq ? String(opts.seq).split(',').map((s) => Number(s.trim())).filter((n) => n > 0) : undefined;
  const r = await req('POST', `/print/jobs/${opts.id}/retry`, seqNos ? { seqNos } : {});
  printJson(r);
}

async function cmdAudit(opts) {
  const data = await req('GET', `/audit/logs?pageSize=${Number(opts.limit ?? 10)}`);
  const rows = toRows(data);
  table(rows, [
    { label: '时间', key: 'createdAt' },
    { label: '动作', key: 'action' },
    { label: '对象', key: 'targetType' },
    { label: 'ID', key: 'targetId' },
  ]);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const HELP = `labelctl —— LabelFlow 命令行

  login                              登录并缓存 token
  templates [--keyword k] [--category c] [--limit n] [--json]
  template <id>                      输出模板 JSON
  printers                           打印机列表
  print --template <id> [--rows f.csv|f.json] [--copies n] [--printer id]
  commands --template <id> [--protocol zpl|tspl] [--rows f] [--copies n] [-o file]
  jobs [--status s] [--limit n]
  retry <jobId> [--seq 1,3]          整单/按序号补打
  audit [--limit n]
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      template: { type: 'string' },
      rows: { type: 'string' },
      copies: { type: 'string' },
      printer: { type: 'string' },
      protocol: { type: 'string' },
      keyword: { type: 'string' },
      category: { type: 'string' },
      status: { type: 'string' },
      limit: { type: 'string' },
      seq: { type: 'string' },
      out: { type: 'string', short: 'o' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const cmd = positionals[0];
  if (!cmd || values.help || cmd === 'help') { console.log(HELP); return; }
  const opts = { ...values, id: positionals[1] };

  switch (cmd) {
    case 'login': {
      const token = await login();
      console.log(`已登录 ${API}（token 有效期至 ${new Date((decodeExp(token) ?? 0) * 1000).toLocaleString()}）`);
      break;
    }
    case 'templates': await cmdTemplates(opts); break;
    case 'template': await cmdTemplate(opts); break;
    case 'printers': await cmdPrinters(); break;
    case 'print': await cmdPrint(opts); break;
    case 'commands': await cmdCommands(opts); break;
    case 'jobs': await cmdJobs(opts); break;
    case 'retry': await cmdRetry(opts); break;
    case 'audit': await cmdAudit(opts); break;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('错误：' + (e?.message ?? e));
  if (/ECONNREFUSED/.test(String(e?.cause?.code ?? e))) console.error(`后端未启动？请检查 ${API}`);
  process.exitCode = 1;
});
