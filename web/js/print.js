// =============================================================================
// print.js —— 数据导入 / 字段映射 / 打印前校验 / 预览 / 队列打印 / 指令导出
//   · 数据源：Excel(.xlsx/.xls) / CSV / TSV / JSON
//   · 预览与打印共用 buildPrintHtml，杜绝「预览对、打印错」
//   · 队列打印走后端 BullMQ，支持真实打印机（ZPL / TSPL / 浏览器）
// =============================================================================

import { store } from './store.js';
import { buildPrintHtml, buildContext, interpolate, validateBarcodeText, barcodeNaturalWidth, serialValue } from './render.js';
import { api, ensureLogin } from './api.js';
import { toast, downloadFile, escapeHtml } from './util.js';
import { getCurrentTemplateId } from './templates.js';

let iframe = null;
let busy = false;
let lastPreviewHtml = '';
let printers = [];
let sourceRows = [];
let sourceHeaders = [];
let fieldMap = {};
let activeSourceId = null;
let validation = { errors: [], warnings: [] };

export function initPrint() {
  iframe = document.getElementById('print-frame');
  const dataInput = document.getElementById('print-data');

  dataInput.value = JSON.stringify([
    { sku: 'SKU-0001', productName: '经典红茶 250g', price: 39.9, qty: 12 },
    { sku: 'SKU-0002', productName: '手冲咖啡豆 200g', price: 68, qty: 6 },
  ], null, 2);

  bind('btn-gen-preview', () => generate());
  bind('btn-do-print', () => doPrint());
  bind('btn-clear-data', () => {
    dataInput.value = '[]';
    activeSourceId = null;
    generate();
  });
  bind('btn-printer-refresh', () => loadPrinters(true));
  bind('btn-printer-test', () => testPrinter());
  bind('btn-queue-print', () => queuePrint());
  bind('btn-dl-zpl', () => downloadCommands('zpl'));
  bind('btn-dl-tspl', () => downloadCommands('tspl'));
  bind('btn-save-source', () => saveDataSource());
  bind('btn-load-source', () => toggleSourceList());

  document.getElementById('print-file')?.addEventListener('change', onFile);
  document.getElementById('print-zoom')?.addEventListener('change', (e) => {
    const v = Number(e.target.value) || 100;
    iframe.style.width = `${v}%`;
  });
  document.getElementById('print-scan')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); verifyScan(); }
  });

  [dataInput, 'print-copies', 'print-serial-start', 'print-preview-rows'].forEach((x) => {
    const n = typeof x === 'string' ? document.getElementById(x) : x;
    n?.addEventListener('change', () => {
      if (store.state.activeTab === 'print') parseAndRefresh();
    });
  });

  parseAndRefresh();
  setPrintStat('待生成预览');
  loadPrinters(false);
}

function bind(id, fn) {
  document.getElementById(id)?.addEventListener('click', fn);
}

// ---------------------------------------------------------------------------
// 解析数据源
// ---------------------------------------------------------------------------
/** 解析文本数据（JSON / CSV / TSV / 分号分隔），返回 { rows, headers } */
export function parseData(text) {
  const src = String(text ?? '').trim();
  if (!src) return { rows: [], headers: [] };
  if (src.startsWith('[') || src.startsWith('{')) {
    const j = JSON.parse(src);
    const rows = (Array.isArray(j) ? j : [j]).map((r) => (r && typeof r === 'object' ? r : { value: r }));
    return { rows, headers: Object.keys(rows[0] ?? {}) };
  }
  const lines = src.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { rows: [], headers: [] };
  const first = lines[0];
  const delim = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  const cells = splitDelimited(src, delim);
  const header = (cells[0] ?? []).map((h) => String(h).trim());
  const rows = cells.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((h, i) => { obj[h || `列${i + 1}`] = r[i] ?? ''; });
      return obj;
    });
  return { rows, headers: header };
}

/** 支持引号、引号内分隔符/换行、"" 转义、BOM */
function splitDelimited(text, delim) {
  const out = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** 读取文件（Excel 用 SheetJS，其余按文本解析） */
async function readFileRows(file) {
  const name = (file.name || '').toLowerCase();
  if (/\.(xlsx|xls)$/.test(name)) {
    const XLSX = window.XLSX;
    if (!XLSX) throw new Error('Excel 解析库未加载（vendor/xlsx.js）');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    return { rows, headers: Object.keys(rows[0] ?? {}) };
  }
  const text = await file.text();
  return parseData(text);
}

async function onFile(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const { rows, headers } = await readFileRows(f);
    setRows(rows, headers);
    setPrintStat(`已导入 ${rows.length} 行 · ${headers.length} 列（${f.name}）`);
    generate();
  } catch (err) {
    toast('导入失败：' + err.message, 'error');
  }
  e.target.value = '';
}

function setRows(rows, headers) {
  sourceRows = rows;
  sourceHeaders = headers;
  fieldMap = autoMap(headers);
  document.getElementById('print-data').value = JSON.stringify(rows.slice(0, 200), null, 2);
  activeSourceId = null;
  renderMapping();
}

function autoMap(headers) {
  const vars = templateVarNames();
  const map = {};
  for (const h of headers) {
    if (vars.includes(h)) { map[h] = h; continue; }
    const norm = (s) => String(s).toLowerCase().replace(/[\s_\-.]/g, '');
    const hit = vars.find((v) => norm(v) === norm(h));
    if (hit) map[h] = hit;
  }
  return map;
}

/** 模板变量名 + 元素占位里出现过的字段 */
function templateVarNames() {
  const t = store.state.template;
  const out = new Set((t.variables ?? []).map((v) => v.name).filter(Boolean));
  const walk = (s) => {
    String(s ?? '').replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (_, n) => { out.add(n); return ''; });
  };
  for (const el of t.elements ?? []) {
    walk(el.text);
    walk(el.barcode?.content);
    walk(el.qrcode?.content);
    walk(el.formula?.expr);
    walk(el.src);
    (el.cells ?? []).forEach(walk);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// 字段映射 UI
// ---------------------------------------------------------------------------
function renderMapping() {
  const block = document.getElementById('mapping-block');
  const host = document.getElementById('print-mapping');
  if (!block || !host) return;
  const vars = templateVarNames();
  if (!sourceHeaders.length || !vars.length) { block.hidden = true; return; }
  block.hidden = false;
  host.innerHTML = '';
  for (const h of sourceHeaders) {
    const row = document.createElement('div');
    row.className = 'mapping-row';
    row.innerHTML = `<span class="mapping-src" title="${escapeHtml(h)}">${escapeHtml(h)}</span>
      <span class="mapping-arrow">→</span>`;
    const sel = document.createElement('select');
    sel.className = 'form-input mapping-sel';
    sel.innerHTML = `<option value="">（不映射）</option>` +
      vars.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    sel.value = fieldMap[h] ?? '';
    sel.addEventListener('change', () => {
      if (sel.value) fieldMap[h] = sel.value;
      else delete fieldMap[h];
      refreshValidation();
    });
    row.appendChild(sel);
    host.appendChild(row);
  }
}

/** 应用字段映射后的数据行 */
export function mappedRows() {
  if (!sourceRows.length) return [];
  if (!Object.keys(fieldMap).length) return sourceRows;
  return sourceRows.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) out[fieldMap[k] ?? k] = v;
    return out;
  });
}

function parseAndRefresh() {
  try {
    const { rows, headers } = parseData(document.getElementById('print-data').value);
    const changed = JSON.stringify(headers) !== JSON.stringify(sourceHeaders);
    sourceRows = rows;
    if (changed) {
      sourceHeaders = headers;
      fieldMap = autoMap(headers);
      renderMapping();
    }
  } catch {
    /* 输入过程中 JSON 可能不合法：保留上一次数据 */
  }
  refreshValidation();
}

function refreshValidation() {
  const rows = mappedRows();
  validation = validateRows(store.state.template, rows);
  renderValidation();
  renderMapping();
}

// ---------------------------------------------------------------------------
// 打印前校验
// ---------------------------------------------------------------------------
function validateRows(template, rows) {
  const errors = [];
  const warnings = [];
  if (!rows.length) return { errors, warnings };

  // 1) 变量级校验（必填 / 数字 / 整数 / 唯一 / 正则）
  for (const v of template.variables ?? []) {
    // 校验规则可来自 变量类型 / 必填 / 唯一 勾选 / 显式 validation
    const modes = new Set();
    if (v.required) modes.add('nonempty');
    if (v.validation) modes.add(v.validation);
    if (!v.validation) {
      if (v.type === 'integer') modes.add('integer');
      else if (v.type === 'number') modes.add('number');
    }
    if (v.unique) modes.add('unique');
    if (!modes.size) continue;
    const seen = new Map();
    rows.forEach((r, i) => {
      const raw = r[v.name];
      const val = raw == null ? '' : String(raw).trim();
      if (modes.has('nonempty') && !val) errors.push(`第 ${i + 1} 行：变量「${v.name}」必填为空`);
      if (val && modes.has('number') && !Number.isFinite(Number(val))) errors.push(`第 ${i + 1} 行：变量「${v.name}」不是数字（${val}）`);
      if (val && modes.has('integer') && !/^-?\d+$/.test(val)) errors.push(`第 ${i + 1} 行：变量「${v.name}」不是整数（${val}）`);
      if (modes.has('unique') && val) {
        if (seen.has(val)) errors.push(`第 ${i + 1} 行：变量「${v.name}」重复码「${val}」（首次出现在第 ${seen.get(val) + 1} 行）`);
        else seen.set(val, i);
      }
      if (val && modes.has('regex') && v.regex) {
        try {
          if (!new RegExp(v.regex).test(val)) errors.push(`第 ${i + 1} 行：变量「${v.name}」不符合正则 ${v.regex}`);
        } catch {
          warnings.push(`变量「${v.name}」的正则表达式无效：${v.regex}`);
        }
      }
    });
  }

  // 2) 条码 / 二维码内容校验
  for (const el of template.elements ?? []) {
    if (el.type !== 'barcode' && el.type !== 'qrcode') continue;
    const spec = el.type === 'barcode' ? el.barcode : el.qrcode;
    const label = el.name || (el.type === 'barcode' ? `一维码(${spec?.sym})` : `二维码(${spec?.sym})`);
    const unique = new Map();
    rows.forEach((r, i) => {
      const ctx = buildContext(template, r);
      const content = interpolate(spec?.content ?? '', ctx).trim();
      if (!content) {
        errors.push(`第 ${i + 1} 行：${label} 内容为空${/\{\{/.test(String(spec?.content ?? '')) ? '（变量无值）' : ''}`);
        return;
      }
      const vr = validateBarcodeText(spec?.sym, content);
      if (!vr.ok) errors.push(`第 ${i + 1} 行：${label} ${vr.error}`);
      if (spec?.sym && /^(EAN13|EAN8|UPC|UPC_E)$/.test(spec.sym) && /^\d{12,13}$/.test(content) && spec.checksum !== false) {
        // 交给渲染端计算校验位；此处只提示位数
      }
      if (el.type === 'barcode') {
        const w = barcodeNaturalWidth(spec, content);
        if (w && w > (el.w ?? 0) + 0.01) {
          warnings.push(`第 ${i + 1} 行：${label} 自然宽度 ${w.toFixed(1)}mm 超出元素宽度 ${el.w}mm`);
        }
      }
      if (el.type === 'barcode' || el.type === 'qrcode') {
        if (unique.has(content)) errors.push(`第 ${i + 1} 行：${label} 内容重复「${content}」（首次在第 ${unique.get(content) + 1} 行）`);
        else unique.set(content, i);
      }
    });
  }

  // 3) 变量未在数据里出现（仅提示）
  for (const v of template.variables ?? []) {
    if (v.required && !rows.some((r) => Object.prototype.hasOwnProperty.call(r, v.name))) {
      warnings.push(`数据中缺少必填变量列「${v.name}」`);
    }
  }

  return { errors: dedupe(errors).slice(0, 80), warnings: dedupe(warnings).slice(0, 60) };
}

function dedupe(list) {
  return [...new Set(list)];
}

function renderValidation() {
  const host = document.getElementById('print-validate');
  if (!host) return;
  const { errors, warnings } = validation;
  if (!errors.length && !warnings.length) {
    host.className = 'validate-box ok';
    host.innerHTML = '<span class="v-dot ok"></span>校验通过，可以打印';
    return;
  }
  host.className = 'validate-box' + (errors.length ? ' err' : ' warn');
  const lines = [
    ...errors.slice(0, 10).map((x) => `<div class="v-line err">✖ ${escapeHtml(x)}</div>`),
    ...warnings.slice(0, 8).map((x) => `<div class="v-line warn">⚠ ${escapeHtml(x)}</div>`),
  ];
  const more = errors.length + warnings.length - lines.length;
  host.innerHTML = lines.join('') + (more > 0 ? `<div class="v-more">还有 ${more} 条…</div>` : '');
}

// ---------------------------------------------------------------------------
// 预览 / 打印
// ---------------------------------------------------------------------------
function readOptions() {
  const copies = Math.max(1, Math.min(500, Number(document.getElementById('print-copies').value) || 1));
  const serialStart = Math.max(1, Number(document.getElementById('print-serial-start').value) || 1);
  const previewRows = Math.max(1, Math.min(200, Number(document.getElementById('print-preview-rows').value) || 10));
  return { copies, serialStart, previewRows };
}

export async function generate() {
  if (busy) return;
  busy = true;
  const btn = document.getElementById('btn-gen-preview');
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    parseAndRefresh();
    const rows = mappedRows();
    const opts = readOptions();
    const previewRows = rows.slice(0, opts.previewRows);
    const html = await buildPrintHtml(store.state.template, previewRows, {
      ...opts,
      title: document.getElementById('tpl-name')?.value || 'LabelFlow',
    });
    lastPreviewHtml = html;
    if (iframe) iframe.srcdoc = html;
    const total = Math.max(1, rows.length) * opts.copies;
    const previewed = Math.max(1, previewRows.length) * opts.copies;
    setPrintStat(`共 ${total} 张标签（${Math.max(rows.length, 1)} 行 × ${opts.copies} 份）`
      + (previewed < total ? ` · 预览前 ${previewRows.length} 行` : ''));
    const ok = validation.errors.length === 0;
    document.getElementById('btn-do-print').disabled = false;
    document.getElementById('btn-queue-print').disabled = !ok;
    if (!ok) setPrintStat(`校验未通过（${validation.errors.length} 项），已禁用队列打印`);
  } catch (e) {
    console.error(e);
    toast('预览生成失败：' + e.message, 'error');
    setPrintStat('生成失败');
  } finally {
    busy = false;
    if (btn) { btn.disabled = false; btn.textContent = '⟳ 生成预览'; }
  }
}

async function buildFullHtml() {
  const rows = mappedRows();
  const opts = readOptions();
  return buildPrintHtml(store.state.template, rows.length ? rows : [{}], {
    ...opts,
    title: document.getElementById('tpl-name')?.value || 'LabelFlow',
  });
}

export async function doPrint() {
  try {
    const html = await buildFullHtml();
    if (!iframe) return;
    iframe.srcdoc = html;
    await new Promise((resolve) => {
      const done = () => { iframe.removeEventListener('load', done); resolve(); };
      iframe.addEventListener('load', done);
      setTimeout(done, 1500);
    });
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
  } catch (e) {
    toast('调用打印失败：' + e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 队列打印（真实打印机 / 服务端渲染）
// ---------------------------------------------------------------------------
function selectedPrinterId() {
  const v = document.getElementById('print-printer')?.value;
  return v ? Number(v) : undefined;
}

async function queuePrint() {
  if (validation.errors.length) {
    toast(`校验未通过：${validation.errors[0]}`, 'error');
    return;
  }
  const ok = await ensureLogin();
  if (!ok) { toast('未登录，无法提交打印队列', 'error'); return; }
  const rows = mappedRows();
  if (rows.length > 2000) { toast('单次最多 2000 行，请拆分数据', 'error'); return; }
  const opts = readOptions();
  const protocol = document.getElementById('print-protocol')?.value || 'browser';
  try {
    const body = {
      templateId: getCurrentTemplateId() ?? 0,
      templateContent: store.state.template,
      printerId: selectedPrinterId(),
      rows: rows.length ? rows : [{}],
      copies: opts.copies,
      params: { copies: opts.copies, protocol, serialStart: opts.serialStart, serialMap: computeSerialMap(rows.length, opts) },
    };
    const r = await api.createPrintJob(body);
    toast(`已提交打印任务 #${r.jobId}（${r.total} 张）`, 'success');
    window.dispatchEvent(new CustomEvent('goto-tab', { detail: 'jobs' }));
  } catch (e) {
    toast('提交失败：' + e.message, 'error');
  }
}

/** 前端按当前模板计算流水号序列（供队列打印使用） */
function computeSerialMap(rowCount, opts) {
  const t = store.state.template;
  const map = {};
  const total = Math.max(1, rowCount) * opts.copies;
  for (const el of t.elements ?? []) {
    if (el.type !== 'serial') continue;
    map[el.id] = Array.from({ length: total }, (_, i) => serialValue(el.serial ?? {}, { serialNo: opts.serialStart + i }));
  }
  return map;
}

// ---------------------------------------------------------------------------
// 指令导出
// ---------------------------------------------------------------------------
async function downloadCommands(protocol) {
  const rows = mappedRows();
  const opts = readOptions();
  const page = store.state.template.page;
  const dpi = page.dpi ?? 300;
  try {
    const r = await api.printCommands({
      templateContent: store.state.template,
      rows: rows.length ? rows : [{}],
      copies: opts.copies,
      protocol,
      dpi,
      widthMm: page.widthMm,
      heightMm: page.heightMm,
      gapMm: page.gapMm ?? 2,
      offsetXMm: (page.offsetXMm ?? 0) + (page.calibrateXMm ?? 0),
      offsetYMm: (page.offsetYMm ?? 0) + (page.calibrateYMm ?? 0),
      serialMap: computeSerialMap(rows.length, opts),
    });
    const name = (document.getElementById('tpl-name')?.value || 'label').replace(/[\\/:*?"<>|]/g, '_');
    downloadFile(`${name}.${protocol}`, r.text, 'text/plain');
    if (r.warnings?.length) toast(`已导出，但：${r.warnings.join('；')}`, 'warn');
    else toast(`已导出 ${protocol.toUpperCase()}（${r.labelCount} 张 / ${r.bytes} 字节）`, 'success');
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 打印机
// ---------------------------------------------------------------------------
async function loadPrinters(notify = false) {
  const sel = document.getElementById('print-printer');
  if (!sel) return;
  try {
    const ok = await ensureLogin();
    if (!ok) throw new Error('未登录');
    printers = (await api.listPrinters()) ?? [];
    const keep = sel.value;
    sel.innerHTML = '<option value="">（不指定 / 浏览器打印）</option>' +
      printers.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} · ${p.type} · ${p.dpi}dpi</option>`).join('');
    if (keep) sel.value = keep;
    if (notify) toast(`已加载 ${printers.length} 台打印机`, 'success');
  } catch (e) {
    if (notify) toast('打印机加载失败：' + e.message, 'error');
  }
}

async function testPrinter() {
  const id = selectedPrinterId();
  if (!id) { toast('请先选择打印机', 'error'); return; }
  try {
    const r = await api.testPrinter(id);
    if (r?.skipped) toast(`打印机为 ${r.type || '浏览器/驱动'} 类型，无需网络测试`, 'info');
    else if (r?.ok) toast(`连接正常（${r.roundtripMs ?? r.latencyMs ?? '—'} ms）`, 'success');
    else toast('连接失败：' + (r?.error || '无法连接打印机'), 'error');
  } catch (e) {
    toast('测试失败：' + e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 数据源（服务端）
// ---------------------------------------------------------------------------
async function saveDataSource() {
  const rows = mappedRows();
  if (!rows.length) { toast('没有可保存的数据', 'error'); return; }
  const name = prompt('数据源名称', `打印数据 ${new Date().toLocaleString('zh-CN')}`);
  if (!name) return;
  try {
    const ok = await ensureLogin();
    if (!ok) throw new Error('未登录');
    const r = await api.saveDataSourceRows({
      name,
      type: 'json',
      headers: Object.keys(rows[0] ?? {}),
      rows,
      fieldMap: {},
    });
    toast(`数据源已保存（#${r.sourceId}，${r.rows} 行）`, 'success');
    activeSourceId = r.sourceId;
    await toggleSourceList(true);
  } catch (e) {
    toast('保存数据源失败：' + e.message, 'error');
  }
}

async function toggleSourceList(forceOpen = false) {
  const box = document.getElementById('print-source-list');
  if (!box) return;
  if (!box.hidden && !forceOpen) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '<div class="source-empty">加载中…</div>';
  try {
    const ok = await ensureLogin();
    if (!ok) throw new Error('未登录');
    const list = await api.listDataSources();
    if (!list?.length) { box.innerHTML = '<div class="source-empty">暂无已保存的数据源</div>'; return; }
    box.innerHTML = '';
    for (const s of list) {
      const row = document.createElement('div');
      row.className = 'source-item' + (activeSourceId === s.id ? ' active' : '');
      row.innerHTML = `<div class="source-name">${escapeHtml(s.name)}</div>
        <div class="source-meta">#${s.id} · ${escapeHtml(s.type || 'json')} · ${s.createdAt ? new Date(s.createdAt).toLocaleDateString('zh-CN') : ''}</div>`;
      const load = document.createElement('button');
      load.className = 'btn'; load.type = 'button'; load.textContent = '载入';
      load.addEventListener('click', async () => {
        try {
          const rows = await api.dataSourceRows(s.id, { limit: 1000 });
          const payloads = (rows ?? []).map((r) => r.payload ?? r);
          const headers = Object.keys(payloads[0] ?? {});
          setRows(payloads, headers);
          activeSourceId = s.id;
          toast(`已载入「${s.name}」（${payloads.length} 行）`, 'success');
          generate();
        } catch (e) { toast('载入失败：' + e.message, 'error'); }
      });
      const del = document.createElement('button');
      del.className = 'btn btn-danger'; del.type = 'button'; del.textContent = '删除';
      del.addEventListener('click', async () => {
        if (!confirm(`删除数据源「${s.name}」？`)) return;
        try {
          await api.deleteDataSource(s.id);
          if (activeSourceId === s.id) activeSourceId = null;
          toggleSourceList(true);
        } catch (e) { toast('删除失败：' + e.message, 'error'); }
      });
      const ops = document.createElement('div');
      ops.className = 'source-ops';
      ops.append(load, del);
      row.appendChild(ops);
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<div class="source-empty err">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// 扫码回读校验
// ---------------------------------------------------------------------------
function verifyScan() {
  const input = document.getElementById('print-scan');
  const out = document.getElementById('print-scan-result');
  if (!input || !out) return;
  const code = input.value.trim();
  if (!code) { out.textContent = ''; return; }
  const rows = mappedRows();
  const t = store.state.template;
  const expected = [];
  rows.forEach((r, i) => {
    const ctx = buildContext(t, r);
    for (const el of t.elements ?? []) {
      if (el.type !== 'barcode' && el.type !== 'qrcode') continue;
      const content = interpolate((el.type === 'barcode' ? el.barcode?.content : el.qrcode?.content) ?? '', ctx).trim();
      if (content) expected.push({ value: content, row: i + 1, label: el.name || el.type });
    }
  });
  const hit = expected.find((e) => e.value === code);
  if (hit) {
    out.className = 'scan-result ok';
    out.innerHTML = `✔ 匹配成功：第 ${hit.row} 行「${escapeHtml(hit.label)}」`;
    toast('扫码回读匹配成功', 'success');
  } else {
    out.className = 'scan-result err';
    out.innerHTML = `✖ 未匹配：${escapeHtml(code)}<br><span>共 ${expected.length} 个预期码</span>`;
    toast('扫码内容与数据不匹配', 'error');
  }
  input.select();
}

function setPrintStat(text) {
  const n = document.getElementById('print-stat');
  if (n) n.textContent = text;
}

/** 兼容旧接口 */
export function parseRows(text) {
  return parseData(text).rows;
}

export function detectedFields(text) {
  return parseData(text).headers;
}

export function currentPrintHtml() {
  return lastPreviewHtml;
}
