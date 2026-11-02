// =============================================================================
// jobs.js —— 打印任务队列 / 逐张日志 / 重打补打 / 审计日志
//   · 任务列表自动轮询（仅在本页签可见时）
//   · 重打复用原数据与流水号，补打失败序号不产生新号
// =============================================================================

import { api, ensureLogin } from './api.js';
import { toast, escapeHtml } from './util.js';
import { store } from './store.js';

const STATUS_LABEL = {
  queued: '排队中', running: '打印中', success: '成功',
  partial: '部分成功', failed: '失败', canceled: '已取消',
};
const STATUS_KIND = {
  queued: 'wait', running: 'run', success: 'ok', partial: 'warn', failed: 'err', canceled: 'muted',
};

let selectedJobId = null;
let pollTimer = 0;

export function initJobs() {
  document.getElementById('btn-jobs-refresh')?.addEventListener('click', () => refreshJobs(true));
  document.getElementById('jobs-status')?.addEventListener('change', () => refreshJobs());
  document.getElementById('btn-audit-refresh')?.addEventListener('click', () => loadAudit());
  document.getElementById('audit-action')?.addEventListener('change', () => loadAudit());
  document.getElementById('audit-action')?.addEventListener('input', debounce(() => loadAudit(), 400));
  document.getElementById('jobs-auto')?.addEventListener('change', startPolling);
  startPolling();
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function startPolling() {
  clearInterval(pollTimer);
  const auto = document.getElementById('jobs-auto')?.checked !== false;
  if (!auto) return;
  pollTimer = setInterval(() => {
    if (store.state.activeTab === 'jobs') refreshJobs();
  }, 5000);
}

export function refreshJobs(notify = false) {
  loadJobs(notify);
}

async function loadJobs(notify = false) {
  const body = document.getElementById('jobs-list-body');
  if (!body) return;
  const status = document.getElementById('jobs-status')?.value || '';
  try {
    const ok = await ensureLogin();
    if (!ok) throw new Error('未登录');
    const page = await api.listPrintJobs({ page: 1, pageSize: 50, ...(status ? { status } : {}) });
    const rows = Array.isArray(page) ? page[0] : (page?.rows ?? []);
    const total = Array.isArray(page) ? page[1] : (page?.total ?? rows.length);
    document.getElementById('jobs-stat').textContent = `共 ${total} 个任务`;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9" class="tpl-empty">暂无打印任务<br><span>在「打印输出」页提交打印队列后出现在这里</span></td></tr>';
      return;
    }
    body.innerHTML = '';
    for (const j of rows) {
      const tr = document.createElement('tr');
      tr.className = selectedJobId === j.id ? 'row-active' : '';
      const pct = j.total ? Math.min(100, Math.round(((j.done + j.failed) / j.total) * 100)) : 0;
      tr.innerHTML = `
        <td><b>#${j.id}</b></td>
        <td>${j.templateId ? '#' + j.templateId : '—'}</td>
        <td>${j.printerId ? '#' + j.printerId : '浏览器'}</td>
        <td>${j.total}</td>
        <td>${j.done}</td>
        <td>${j.failed}</td>
        <td><span class="status-pill ${STATUS_KIND[j.status] || ''}">${STATUS_LABEL[j.status] || j.status}</span>
          <div class="mini-progress"><i style="width:${pct}%"></i></div></td>
        <td>${j.createdAt ? new Date(j.createdAt).toLocaleString('zh-CN') : '—'}</td>
        <td class="tpl-ops"></td>`;
      const ops = tr.querySelector('.tpl-ops');
      ops.appendChild(mkBtn('明细', () => selectJob(j.id)));
      if (j.status === 'queued' || j.status === 'running') {
        ops.appendChild(mkBtn('取消', () => cancelJob(j.id), 'danger'));
      }
      ops.appendChild(mkBtn('重打', () => retryJob(j.id, null)));
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        selectJob(j.id);
      });
      body.appendChild(tr);
    }
    if (selectedJobId) loadJobDetail(selectedJobId);
    if (notify) toast('任务列表已刷新', 'success');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" class="tpl-empty err">加载失败：${escapeHtml(e.message)}</td></tr>`;
  }
}

function mkBtn(text, onClick, kind = '') {
  const b = document.createElement('button');
  b.className = 'btn' + (kind ? ' btn-' + kind : '');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function selectJob(id) {
  selectedJobId = id;
  document.querySelectorAll('#jobs-list-body tr').forEach((tr) => {
    tr.classList.toggle('row-active', tr.querySelector('b')?.textContent === `#${id}`);
  });
  loadJobDetail(id);
}

async function loadJobDetail(id) {
  const host = document.getElementById('job-detail');
  if (!host) return;
  host.innerHTML = '<div class="job-detail-empty">加载中…</div>';
  try {
    const [job, logs] = await Promise.all([
      api.getPrintJob(id),
      api.printJobLogs(id, { page: 1, pageSize: 200 }),
    ]);
    const logRows = Array.isArray(logs) ? logs[0] : (logs?.rows ?? []);
    const total = Array.isArray(logs) ? logs[1] : (logs?.total ?? logRows.length);
    const failedSeqs = logRows.filter((l) => l.status !== 'success').map((l) => l.seqNo);
    host.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'job-head';
    head.innerHTML = `<div class="job-title">任务 #${job.id}
      <span class="status-pill ${STATUS_KIND[job.status] || ''}">${STATUS_LABEL[job.status] || job.status}</span></div>
      <div class="job-meta">
        模板 #${job.templateId || '—'} · 打印机 ${job.printerId ? '#' + job.printerId : '浏览器'} ·
        完成 ${job.done}/${job.total} · 失败 ${job.failed}<br>
        创建 ${job.createdAt ? new Date(job.createdAt).toLocaleString('zh-CN') : '—'}
        ${job.finishedAt ? ' · 结束 ' + new Date(job.finishedAt).toLocaleString('zh-CN') : ''}
      </div>`;
    host.appendChild(head);

    const ops = document.createElement('div');
    ops.className = 'job-ops';
    ops.appendChild(mkBtn('整单重打', () => retryJob(job.id, null)));
    if (failedSeqs.length) {
      ops.appendChild(mkBtn(`补打失败项（${failedSeqs.length}）`, () => retryJob(job.id, failedSeqs), 'primary'));
    }
    if (job.status === 'queued' || job.status === 'running') {
      ops.appendChild(mkBtn('取消任务', () => cancelJob(job.id), 'danger'));
    }
    const seq = document.createElement('input');
    seq.className = 'form-input job-seq';
    seq.placeholder = '补打序号，如 3,7';
    ops.appendChild(seq);
    ops.appendChild(mkBtn('按序号补打', () => {
      const list = seq.value.split(/[,\s]+/).map(Number).filter((n) => n > 0);
      if (!list.length) { toast('请输入有效的标签序号', 'error'); return; }
      retryJob(job.id, list);
    }, 'primary'));
    host.appendChild(ops);

    const listTitle = document.createElement('div');
    listTitle.className = 'job-log-title';
    listTitle.textContent = `逐张打印日志（${logRows.length}/${total}）`;
    host.appendChild(listTitle);

    const wrap = document.createElement('div');
    wrap.className = 'job-log-wrap';
    if (!logRows.length) {
      wrap.innerHTML = '<div class="job-detail-empty">暂无日志（任务可能仍在排队）</div>';
    } else {
      wrap.innerHTML = `<table class="tpl-table job-log-table">
        <thead><tr><th>序号</th><th>状态</th><th>流水号</th><th>数据</th><th>时间</th><th></th></tr></thead>
        <tbody>${logRows.map((l) => `<tr>
          <td>${l.seqNo}</td>
          <td><span class="status-pill ${l.status === 'success' ? 'ok' : 'err'}">${l.status === 'success' ? '成功' : '失败'}</span>
            ${l.errorMsg ? `<div class="log-err">${escapeHtml(l.errorMsg)}</div>` : ''}</td>
          <td class="mono">${escapeHtml(flatten(l.serialValues) || '—')}</td>
          <td class="mono">${escapeHtml(truncate(flatten(l.dataSnapshot)) || '—')}</td>
          <td>${l.createdAt ? new Date(l.createdAt).toLocaleTimeString('zh-CN') : '—'}</td>
          <td>${l.reprintOf ? `<span class="tag">补打</span>` : ''}</td>
        </tr>`).join('')}</tbody></table>`;
    }
    host.appendChild(wrap);
  } catch (e) {
    host.innerHTML = `<div class="job-detail-empty err">明细加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function flatten(obj) {
  if (!obj) return '';
  if (typeof obj !== 'object') return String(obj);
  const parts = Object.entries(obj).map(([k, v]) => `${k}=${v}`);
  return parts.join(', ');
}

function truncate(s, n = 60) {
  const x = String(s ?? '');
  return x.length > n ? x.slice(0, n) + '…' : x;
}

async function cancelJob(id) {
  if (!confirm(`取消打印任务 #${id}？`)) return;
  try {
    await api.cancelPrintJob(id);
    toast(`任务 #${id} 已取消`, 'success');
    loadJobs();
  } catch (e) {
    toast('取消失败：' + e.message, 'error');
  }
}

async function retryJob(id, seqNos) {
  const msg = seqNos?.length ? `补打任务 #${id} 的 ${seqNos.length} 个标签？` : `重打任务 #${id} 全部标签？`;
  if (!confirm(msg)) return;
  try {
    const r = await api.retryPrintJob(id, seqNos);
    toast(`已创建重打任务 #${r.jobId}`, 'success');
    loadJobs();
  } catch (e) {
    toast('重打失败：' + e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------
export function loadAudit() {
  const body = document.getElementById('audit-list-body');
  if (!body) return;
  const action = document.getElementById('audit-action')?.value?.trim() || '';
  body.innerHTML = '<tr><td colspan="5" class="tpl-empty">加载中…</td></tr>';
  ensureLogin()
    .then((ok) => {
      if (!ok) throw new Error('未登录');
      return api.auditLogs({ pageSize: 100, ...(action ? { action } : {}) });
    })
    .then((list) => {
      const rows = list ?? [];
      document.getElementById('audit-stat').textContent = `共 ${rows.length} 条`;
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" class="tpl-empty">暂无审计记录</td></tr>';
        return;
      }
      body.innerHTML = rows.map((r) => `<tr>
        <td>${r.createdAt ? new Date(r.createdAt).toLocaleString('zh-CN') : '—'}</td>
        <td><span class="audit-action">${escapeHtml(r.action)}</span></td>
        <td>${r.targetType ? `${escapeHtml(r.targetType)}${r.targetId ? ' #' + r.targetId : ''}` : '—'}</td>
        <td>${r.actorId ?? '—'}</td>
        <td class="mono audit-detail">${escapeHtml(truncate(JSON.stringify(r.detail ?? {}), 120))}</td>
      </tr>`).join('');
    })
    .catch((e) => {
      body.innerHTML = `<tr><td colspan="5" class="tpl-empty err">加载失败：${escapeHtml(e.message)}</td></tr>`;
    });
}
