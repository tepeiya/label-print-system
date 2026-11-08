// =============================================================================
// printers.js —— 打印机管理：列表 / 新增 / 编辑 / 删除 / 测试连通 / 指令生成
// =============================================================================
import { api, getToken } from './api.js';

let rows = [];
let current = null;

const FIELD_IDS = ['name', 'channel', 'host', 'port', 'protocol', 'default', 'dpi', 'density', 'speed', 'offsetX', 'widthMm', 'heightMm', 'gapMm', 'mediaType'];

const CHANNEL_LABEL = {
  raw_tcp: 'TCP/IP', browser: '浏览器', image: '图像输出', windows_spooler: 'Win 代理',
};

export function initPrinters() {
  const tbody = document.getElementById('printers-list-body');
  const stat = document.getElementById('printers-stat');

  // 列表操作
  document.getElementById('btn-printer-add')?.addEventListener('click', () => openModal());
  document.getElementById('btn-printer-refresh-list')?.addEventListener('click', loadList);
  window.addEventListener('printers-refresh', loadList);

  // Modal
  const mask = document.getElementById('printer-modal-mask');
  document.getElementById('printer-modal-close')?.addEventListener('click', () => (mask.hidden = true));
  document.getElementById('printer-modal-cancel')?.addEventListener('click', () => (mask.hidden = true));
  mask?.addEventListener('click', (e) => { if (e.target === mask) mask.hidden = true; });
  document.getElementById('printer-modal-save')?.addEventListener('click', saveFromModal);
  document.getElementById('printer-modal-test')?.addEventListener('click', async () => {
    const draft = readModal();
    try {
      const r = await api.testPrinter(draft.id || await tempCreate(draft));
      toast(r?.ok ? '✅ 连通成功' : '⚠ 连通失败', r?.ok ? 'ok' : 'warn');
    } catch (e) { toast('❌ ' + e.message, 'err'); }
  });

  // 通道切换时显示 TCP 字段
  const ch = document.getElementById('printer-f-channel');
  const tcpBlock = document.getElementById('printer-f-tcp-block');
  ch?.addEventListener('change', () => {
    tcpBlock.style.display = ch.value === 'raw_tcp' ? '' : 'none';
  });

  loadList();
}

async function tempCreate(draft) {
  const saved = await api.createPrinter({ ...draft, name: (draft.name || '测试打印机') + '_tmp', default: false });
  toast('已临时创建用于测试（保存时将更新此条）');
  openModal(saved);
  return saved.id;
}

async function loadList() {
  const tbody = document.getElementById('printers-list-body');
  const stat = document.getElementById('printers-stat');
  tbody.innerHTML = '<tr><td colspan="7" class="tpl-empty">加载中…</td></tr>';
  try {
    rows = await api.listPrinters();
    renderList();
    stat.textContent = `${rows.length} 台打印机`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="tpl-empty err">加载失败：${e.message}</td></tr>`;
  }
}

function renderList() {
  const tbody = document.getElementById('printers-list-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tpl-empty">还没有打印机，点击「＋ 新增打印机」添加</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr data-id="${r.id}" class="${current?.id === r.id ? 'selected' : ''}">
      <td><b>${r.name}</b></td>
      <td>${CHANNEL_LABEL[r.channel] || r.channel}</td>
      <td>${renderConn(r)}</td>
      <td>${r.dpi || 300}</td>
      <td>${r.widthMm || 0} × ${r.heightMm || 0} mm</td>
      <td>${r.isDefault ? '⭐' : ''}</td>
      <td>
        <button class="btn mini" data-act="edit">✎ 编辑</button>
        <button class="btn mini" data-act="test">🔌 测试</button>
        <button class="btn mini" data-act="cmds">Ⓟ 指令</button>
        <button class="btn mini danger" data-act="del">🗑</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach((tr) => {
    const id = +tr.dataset.id;
    tr.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act) { e.stopPropagation(); return doAction(act, id); }
      select(id);
    });
  });
}

function renderConn(r) {
  if (r.channel === 'raw_tcp') {
    const h = r.connection?.host || r.host || '';
    const p = r.connection?.port || r.port || 9100;
    return `<code>${h}:${p}</code>`;
  }
  return '—';
}

function select(id) {
  current = rows.find((r) => r.id === id) || null;
  renderList();
  renderDetail();
}

function renderDetail() {
  const aside = document.getElementById('printer-detail');
  if (!current) {
    aside.innerHTML = '<div class="printer-detail-empty">选择左侧打印机查看详情 / 连接测试 / 校准</div>';
    return;
  }
  const c = current.connection || {};
  aside.innerHTML = `
    <div class="pd-card">
      <div class="pd-title">${current.name}</div>
      <div class="pd-sub">通道：${CHANNEL_LABEL[current.channel] || current.channel} · 协议：${current.protocol || 'ZPL'}</div>
      <div class="pd-grid">
        <span>连接</span><b>${c.host || current.host || '—'}:${c.port || current.port || '—'}</b>
        <span>DPI</span><b>${current.dpi || 300}</b>
        <span>标签尺寸</span><b>${current.widthMm || 0} × ${current.heightMm || 0} mm</b>
        <span>间隙 / 模式</span><b>${current.gapMm ?? 2}mm · ${current.mediaType || 'gap'}</b>
        <span>偏移 / 浓度 / 速度</span><b>X=${current.offsetX ?? 0}mm · D=${current.density ?? '—'} · S=${current.speed ?? '—'}</b>
      </div>
      <div class="pd-actions">
        <button class="btn" id="pd-test">🔌 连通测试</button>
        <button class="btn" id="pd-testprint">🖨 测试打印</button>
        <button class="btn" id="pd-calibrate">⚙ 校准</button>
        <button class="btn" id="pd-cmds">Ⓟ 生成指令</button>
      </div>
      <div id="pd-result" class="pd-result"></div>
    </div>
  `;
  document.getElementById('pd-test')?.addEventListener('click', async () => {
    const out = document.getElementById('pd-result');
    out.textContent = '连通中…';
    try { const r = await api.testPrinter(current.id); out.textContent = r?.ok ? '✅ 连通成功' : '⚠ ' + JSON.stringify(r); }
    catch (e) { out.textContent = '❌ ' + e.message; }
  });
  document.getElementById('pd-testprint')?.addEventListener('click', async () => {
    const out = document.getElementById('pd-result');
    out.textContent = '发送测试打印…';
    try { const r = await api.testPrintPrinter(current.id); out.textContent = r?.ok ? '✅ 已发送测试打印' : '⚠ ' + JSON.stringify(r); }
    catch (e) { out.textContent = '❌ ' + e.message; }
  });
  document.getElementById('pd-calibrate')?.addEventListener('click', () => openModal(current));
  document.getElementById('pd-cmds')?.addEventListener('click', async () => {
    try {
      const r = await api.printerCommands(current.id, current.protocol || 'zpl');
      downloadBlob(new Blob([r.text], { type: 'text/plain' }), `test-${current.id}.${current.protocol || 'zpl'}`);
    } catch (e) { toast('❌ ' + e.message, 'err'); }
  });
}

async function doAction(act, id) {
  const r = rows.find((x) => x.id === id);
  if (act === 'edit') return openModal(r);
  if (act === 'del') {
    if (!confirm(`确定删除「${r.name}」？`)) return;
    try { await api.deletePrinter(id); toast('已删除'); await loadList(); } catch (e) { toast('❌ ' + e.message, 'err'); }
    return;
  }
  if (act === 'test') {
    try { const ok = await api.testPrinter(id); toast(ok?.ok ? '✅ 连通成功' : '⚠ 连通失败', ok?.ok ? 'ok' : 'warn'); }
    catch (e) { toast('❌ ' + e.message, 'err'); }
    return;
  }
  if (act === 'cmds') {
    try {
      // 原来这里写成 `const r = await api.printerCommands(id, r.protocol || 'zpl')`：
      // 新的 const 在初始化表达式里就引用了自己的名字（TDZ），从列表行点「下载指令」
      // 必抛 "Cannot access 'r' before initialization"。协议取外层的行数据 r。
      const cmdProtocol = r.protocol || 'zpl';
      const res = await api.printerCommands(id, cmdProtocol);
      downloadBlob(new Blob([res.text], { type: 'text/plain' }), `test-${id}.${cmdProtocol}`);
    } catch (e) { toast('❌ ' + e.message, 'err'); }
    return;
  }
}

function openModal(pr = null) {
  const mask = document.getElementById('printer-modal-mask');
  document.getElementById('printer-modal-title').textContent = pr ? `编辑打印机 #${pr.id}` : '新增打印机';
  document.getElementById('printer-f-name').value = pr?.name || '';
  document.getElementById('printer-f-channel').value = pr?.channel || 'raw_tcp';
  document.getElementById('printer-f-host').value = pr?.connection?.host || pr?.host || '';
  document.getElementById('printer-f-port').value = pr?.connection?.port || pr?.port || 9100;
  document.getElementById('printer-f-protocol').value = pr?.protocol || 'zpl';
  document.getElementById('printer-f-default').checked = !!pr?.isDefault;
  document.getElementById('printer-f-dpi').value = pr?.dpi || 300;
  document.getElementById('printer-f-density').value = pr?.density ?? '';
  document.getElementById('printer-f-speed').value = pr?.speed ?? '';
  document.getElementById('printer-f-offsetx').value = pr?.offsetX ?? pr?.offsetXMm ?? 0;
  document.getElementById('printer-f-width').value = pr?.widthMm ?? 80;
  document.getElementById('printer-f-height').value = pr?.heightMm ?? 50;
  document.getElementById('printer-f-gap').value = pr?.gapMm ?? 2;
  document.getElementById('printer-f-media').value = pr?.mediaType || 'gap';
  document.getElementById('printer-f-tcp-block').style.display = (pr?.channel || 'raw_tcp') === 'raw_tcp' ? '' : 'none';
  mask.hidden = false;
  mask.dataset.mode = pr ? 'edit' : 'add';
  mask.dataset.id = pr?.id || '';
}

function readModal() {
  const id = +document.getElementById('printer-modal-mask').dataset.id;
  const connection = {
    host: document.getElementById('printer-f-host').value.trim(),
    port: +document.getElementById('printer-f-port').value || 9100,
  };
  return {
    ...(id ? { id } : {}),
    name: document.getElementById('printer-f-name').value.trim(),
    channel: document.getElementById('printer-f-channel').value,
    connection,
    protocol: document.getElementById('printer-f-protocol').value,
    isDefault: document.getElementById('printer-f-default').checked,
    dpi: +document.getElementById('printer-f-dpi').value || 300,
    density: document.getElementById('printer-f-density').value ? +document.getElementById('printer-f-density').value : null,
    speed: document.getElementById('printer-f-speed').value ? +document.getElementById('printer-f-speed').value : null,
    offsetXMm: +document.getElementById('printer-f-offsetx').value || 0,
    widthMm: +document.getElementById('printer-f-width').value || 80,
    heightMm: +document.getElementById('printer-f-height').value || 50,
    gapMm: +document.getElementById('printer-f-gap').value || 2,
    mediaType: document.getElementById('printer-f-media').value,
  };
}

async function saveFromModal() {
  const body = readModal();
  if (!body.name) { toast('请填写打印机名称', 'warn'); return; }
  const mask = document.getElementById('printer-modal-mask');
  try {
    const saved = mask.dataset.mode === 'edit' ? await api.updatePrinter(body.id, body) : await api.createPrinter(body);
    mask.hidden = true;
    toast('💾 已保存');
    await loadList();
    select(saved.id);
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

function downloadBlob(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

function toast(msg, kind = 'info') {
  let t = document.getElementById('global-toast');
  if (!t) {
    t = document.createElement('div'); t.id = 'global-toast'; t.className = 'global-toast';
    document.body.appendChild(t);
  }
  t.className = `global-toast toast-${kind}`;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._tm);
  t._tm = setTimeout(() => { t.hidden = true; }, 2200);
}

export function subscribePrintEvents() {
  const base = api.base.replace('/api/v1', '/api/v1').replace('http://', location.protocol + '//');
  const url = `${base.replace(/\/$/, '')}/print-stream/events?token=${encodeURIComponent(getToken())}`;
  const es = new EventSource(url);
  es.addEventListener('event', (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === 'progress') {
        const row = document.querySelector(`#jobs-list-body tr[data-id="${ev.jobId}"] .job-progress`);
        if (row) row.textContent = `${ev.done}/${ev.total}`;
      } else if (ev.type === 'completed') {
        toast(`🖨 任务 #${ev.jobId} ${ev.status === 'success' ? '✅ 成功' : ev.status === 'failed' ? '❌ 失败' : '⚠ 部分成功'}`, ev.status === 'success' ? 'ok' : 'warn');
        // 触发 jobs 页签自动刷新（如果在该页）
        const activeTab = document.querySelector('#main-tabs .tab.active')?.dataset.tab;
        if (activeTab === 'jobs') {
          document.getElementById('btn-jobs-refresh')?.click();
        }
      }
    } catch {}
  });
  es.onerror = () => { try { es.close(); } catch {} setTimeout(subscribePrintEvents, 10_000); };
  return es;
}
