// =============================================================================
// templates.js —— 模板库：列表 / 保存 / 打开 / 复制 / 删除 / 版本 / 模板包
// =============================================================================

import { api, ensureLogin, apiBase } from './api.js';
import { store } from './store.js';
import { renderElement, buildContext } from './render.js';
import { toast, escapeHtml, downloadFile, MM2PX } from './util.js';

let currentId = null;

export function getCurrentTemplateId() {
  return currentId;
}

export function resetCurrentTemplateId() {
  currentId = null;
}

export function initTemplates() {
  document.getElementById('btn-tpl-save')?.addEventListener('click', () => saveCurrent());
  document.getElementById('btn-tpl-refresh')?.addEventListener('click', () => loadList());
  document.getElementById('btn-tpl-saveas')?.addEventListener('click', () => saveCurrent(true));
  document.getElementById('tpl-search')?.addEventListener('input', (e) => loadList(e.target.value));
  document.getElementById('tpl-category')?.addEventListener('change', () => loadList());
  document.getElementById('tpl-fav-only')?.addEventListener('change', () => loadList());
  document.getElementById('btn-tpl-export-pkg')?.addEventListener('click', exportPackage);
  document.getElementById('tpl-package-file')?.addEventListener('change', importPackage);
}

export async function saveCurrent(asNew = false) {
  const name = document.getElementById('tpl-name')?.value?.trim() || '未命名标签';
  const ok = await ensureLogin();
  if (!ok) { toast('未登录，无法保存到服务器', 'error'); return; }
  const content = store.state.template;
  try {
    if (currentId && !asNew) {
      await api.updateTemplate(currentId, { name, content });
      toast('模板已保存（新版本）', 'success');
    } else {
      const t = await api.createTemplate({ name, category: document.getElementById('tpl-category')?.value || '默认', tags: [], content });
      currentId = t.id;
      toast('模板已创建', 'success');
    }
    loadList();
  } catch (e) {
    toast('保存失败：' + friendlyError(e), 'error');
  }
}

/** 把网络层错误翻译成更可读的提示 */
function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '无法连接后端服务';
  return msg;
}

export async function loadList(keyword = '') {
  const body = document.getElementById('tpl-list-body');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6" class="tpl-empty">加载中…</td></tr>';
  try {
    const ok = await ensureLogin();
    if (!ok) throw new Error('未登录');
    const page = await api.listTemplates({ page: 1, pageSize: 50, ...(keyword ? { keyword } : {}) });
    const all = Array.isArray(page) ? page[0] : (page?.rows ?? []);
    fillCategoryOptions(all);
    const favOnly = !!document.getElementById('tpl-fav-only')?.checked;
    const category = document.getElementById('tpl-category')?.value || '';
    const rows = all.filter((t) => (!favOnly || t.isFavorite)
      && (!category || (t.category || '默认') === category));
    if (!all.length) {
      body.innerHTML = '<tr><td colspan="6" class="tpl-empty">还没有保存过模板<br><span>在「标签设计」里点 💾 保存模板</span></td></tr>';
      return;
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="tpl-empty">当前筛选条件下没有模板<br><span>换个分类或取消「仅收藏」试试</span></td></tr>';
      return;
    }
    body.innerHTML = '';
    for (const t of rows) {
      const tr = document.createElement('tr');
      const when = t.updatedAt ? new Date(t.updatedAt).toLocaleString('zh-CN') : '—';
      tr.innerHTML = `
        <td class="tpl-thumb-cell"><div class="tpl-thumb">${thumbHtml(t.content)}</div></td>
        <td class="tpl-name"><b>${escapeHtml(t.name)}</b>
          <span class="tpl-id">#${t.id}</span>
          ${t.isFavorite ? '<span class="fav">★</span>' : ''}</td>
        <td>${escapeHtml(t.category || '—')}</td>
        <td>v${t.currentVersion ?? 1}</td>
        <td>${when}</td>
        <td class="tpl-ops"></td>`;
      const ops = tr.querySelector('.tpl-ops');
      ops.appendChild(mkBtn(t.isFavorite ? '★' : '☆', async () => {
        try {
          await api.favoriteTemplate(t.id, !t.isFavorite);
          toast(t.isFavorite ? '已取消收藏' : '已收藏', 'success');
          loadList(keyword);
        } catch (e) {
          toast('操作失败：' + friendlyError(e), 'error');
        }
      }, 'fav-btn'));
      ops.appendChild(mkBtn('打开', async () => {
        try {
          const full = await api.getTemplate(t.id);
          store.loadTemplate(full.content);
          currentId = t.id;
          document.getElementById('tpl-name').value = t.name;
          toast(`已打开模板「${t.name}」`, 'success');
          window.dispatchEvent(new CustomEvent('goto-tab', { detail: 'design' }));
        } catch (e) {
          toast('打开失败：' + friendlyError(e), 'error');
        }
      }));
      ops.appendChild(mkBtn('版本', () => openVersions(t)));
      ops.appendChild(mkBtn('复制', async () => {
        try {
          await api.copyTemplate(t.id, t.name + '-副本');
          toast('已复制', 'success');
          loadList(keyword);
        } catch (e) {
          toast('复制失败：' + friendlyError(e), 'error');
        }
      }));
      ops.appendChild(mkBtn('导出', () => exportTemplatePackage(t)));
      ops.appendChild(mkBtn('删除', async () => {
        if (!confirm(`确认删除模板「${t.name}」？`)) return;
        try {
          await api.deleteTemplate(t.id);
          toast('已删除', 'success');
          if (currentId === t.id) currentId = null;
          loadList(keyword);
        } catch (e) {
          toast('删除失败：' + friendlyError(e), 'error');
        }
      }, 'danger'));
      body.appendChild(tr);
    }
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="tpl-empty err">加载失败：${escapeHtml(friendlyError(e))}
      <br><span>确认后端 ${escapeHtml(apiBase())} 已启动</span></td></tr>`;
  }
}

/** 用已有模板回填分类下拉（保留当前选中项与自定义分类） */
function fillCategoryOptions(rows) {
  const sel = document.getElementById('tpl-category');
  if (!sel) return;
  const current = sel.value;
  const cats = [...new Set(rows.map((t) => t.category || '默认'))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  sel.innerHTML = '<option value="">全部分类</option>';
  for (const c of cats) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  }
  if (current && cats.includes(current)) sel.value = current;
}

function mkBtn(text, onClick, kind = '') {
  const b = document.createElement('button');
  b.className = 'btn' + (kind ? ' btn-' + kind : '');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

// ---------------------------------------------------------------------------
// 模板缩略图（用同一渲染引擎，所见即所得）
// ---------------------------------------------------------------------------
function thumbHtml(content) {
  try {
    const page = content?.page;
    if (!page?.widthMm || !page?.heightMm) return '<span class="thumb-none">空</span>';
    const wPx = page.widthMm * MM2PX;
    const hPx = page.heightMm * MM2PX;
    const scale = Math.min(64 / wPx, 44 / hPx);
    const ctx = buildContext(content, {});
    const parts = (content.elements ?? [])
      .filter((e) => e.visible !== false)
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
      .map((el) => {
        try { return renderElement(el, { zoom: scale, ctx }).outerHTML; } catch { return ''; }
      }).join('');
    return `<div class="thumb-paper" style="width:${Math.round(wPx * scale)}px;height:${Math.round(hPx * scale)}px">${parts}</div>`;
  } catch {
    return '<span class="thumb-none">—</span>';
  }
}

// ---------------------------------------------------------------------------
// 版本历史 / 对比 / 回滚
// ---------------------------------------------------------------------------
async function openVersions(tpl) {
  let versions = [];
  try {
    const ok = await ensureLogin();
    if (!ok) throw new Error('未登录');
    versions = (await api.templateVersions(tpl.id)) ?? [];
  } catch (e) {
    toast('版本加载失败：' + friendlyError(e), 'error');
    return;
  }
  const mask = modal(`模板「${tpl.name}」· 版本历史`, `
    <div class="version-list">
      ${versions.length ? versions.map((v) => `<div class="version-item" data-v="${v.version}">
        <div class="version-head">
          <b>v${v.version}</b>
          <span class="version-time">${v.createdAt ? new Date(v.createdAt).toLocaleString('zh-CN') : ''}</span>
          <span class="st-spacer"></span>
          <button class="btn" data-act="diff">对比当前</button>
          <button class="btn" data-act="load">载入画布</button>
          <button class="btn btn-primary" data-act="rollback">回滚到此版本</button>
        </div>
        <div class="version-diff" hidden></div>
      </div>`).join('') : '<div class="tpl-empty">暂无版本记录</div>'}
    </div>`);

  mask.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const item = btn.closest('.version-item');
    const v = Number(item.dataset.v);
    const ver = versions.find((x) => x.version === v);
    if (!ver) return;
    if (btn.dataset.act === 'diff') {
      const box = item.querySelector('.version-diff');
      box.hidden = !box.hidden;
      if (!box.hidden) box.innerHTML = diffHtml(ver.content, store.state.template);
    } else if (btn.dataset.act === 'load') {
      store.loadTemplate(ver.content);
      mask.remove();
      toast(`已载入 v${v}（未保存）`, 'success');
    } else if (btn.dataset.act === 'rollback') {
      if (!confirm(`回滚模板到 v${v}？当前内容会生成一个新版本。`)) return;
      try {
        await api.rollbackTemplate(tpl.id, v);
        toast(`已回滚到 v${v}`, 'success');
        mask.remove();
        loadList();
        const full = await api.getTemplate(tpl.id);
        store.loadTemplate(full.content);
        currentId = tpl.id;
      } catch (err) {
        toast('回滚失败：' + friendlyError(err), 'error');
      }
    }
  });
}

function diffHtml(a, b) {
  const ea = a?.elements ?? [];
  const eb = b?.elements ?? [];
  const idsA = new Set(ea.map((x) => x.id));
  const idsB = new Set(eb.map((x) => x.id));
  const added = eb.filter((x) => !idsA.has(x.id));
  const removed = ea.filter((x) => !idsB.has(x.id));
  const changed = eb.filter((x) => {
    const old = ea.find((y) => y.id === x.id);
    return old && JSON.stringify(old) !== JSON.stringify(x);
  });
  const pa = a?.page ?? {};
  const pb = b?.page ?? {};
  const pageChanged = pa.widthMm !== pb.widthMm || pa.heightMm !== pb.heightMm || pa.dpi !== pb.dpi;
  const lines = [
    pageChanged ? `页面：${pa.widthMm}×${pa.heightMm}mm → ${pb.widthMm}×${pb.heightMm}mm` : '页面尺寸未变',
    `元素：旧 ${ea.length} 个 → 当前 ${eb.length} 个`,
    added.length ? `新增 ${added.length} 个（${added.map((x) => x.name || x.type).join('、')}）` : '',
    removed.length ? `删除 ${removed.length} 个（${removed.map((x) => x.name || x.type).join('、')}）` : '',
    changed.length ? `修改 ${changed.length} 个（${changed.map((x) => x.name || x.type).join('、')}）` : '',
  ].filter(Boolean);
  return `<div class="diff-lines">${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// 模板包（.ziptpl：fflate 打包 template.json）
// ---------------------------------------------------------------------------
async function exportPackage() {
  const name = document.getElementById('tpl-name')?.value?.trim() || '未命名标签';
  let tpl = null;
  if (currentId) {
    try { tpl = await api.getTemplate(currentId); } catch { /* 用当前画布 */ }
  }
  const payload = {
    schemaVersion: 1,
    name: tpl?.name || name,
    category: tpl?.category || '默认',
    tags: tpl?.tags || [],
    exportedAt: new Date().toISOString(),
    content: tpl?.content || store.state.template,
  };
  exportTemplatePackage(payload);
}

function exportTemplatePackage(tpl) {
  const payload = {
    schemaVersion: 1,
    name: tpl.name,
    category: tpl.category || '默认',
    tags: tpl.tags || [],
    exportedAt: new Date().toISOString(),
    content: tpl.content,
  };
  const fflate = window.fflate;
  const safeName = String(payload.name || 'template').replace(/[\\/:*?"<>|]/g, '_');
  if (fflate) {
    const bytes = fflate.zipSync({ 'template.json': fflate.strToU8(JSON.stringify(payload, null, 2)) }, { level: 6 });
    downloadBlob(`${safeName}.ziptpl`, new Blob([bytes], { type: 'application/zip' }));
  } else {
    downloadFile(`${safeName}.json`, JSON.stringify(payload, null, 2));
  }
  toast('模板包已导出', 'success');
}

async function importPackage(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    let payload = null;
    const fflate = window.fflate;
    if (fflate) {
      try {
        const unzipped = fflate.unzipSync(new Uint8Array(buf));
        const entry = unzipped['template.json'] || Object.values(unzipped)[0];
        if (entry) payload = JSON.parse(fflate.strFromU8(entry));
      } catch { /* 不是 zip，按 JSON 处理 */ }
    }
    if (!payload) payload = JSON.parse(new TextDecoder().decode(buf));
    const raw = payload.template ?? payload;
    const content = raw.content ?? payload.content;
    if (!content?.page || !Array.isArray(content.elements)) throw new Error('模板包缺少有效 content');
    const ok = await ensureLogin();
    if (!ok) throw new Error('未登录');
    const created = await api.importTemplate({
      schemaVersion: payload.schemaVersion ?? 1,
      name: raw.name || payload.name || f.name.replace(/\.(ziptpl|zip|json)$/i, ''),
      category: raw.category || payload.category || '默认',
      tags: raw.tags || payload.tags || [],
      content,
    });
    toast(`模板已导入（#${created.id}）`, 'success');
    loadList();
  } catch (err) {
    toast('导入模板包失败：' + friendlyError(err), 'error');
  }
  e.target.value = '';
}

function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------------------
// 轻量弹窗
// ---------------------------------------------------------------------------
function modal(title, bodyHtml) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">
    <div class="modal-head"><span class="modal-title">${escapeHtml(title)}</span>
      <button class="icon-btn modal-close" type="button" title="关闭">✕</button></div>
    <div class="modal-body">${bodyHtml}</div>
  </div>`;
  mask.querySelector('.modal-close').addEventListener('click', () => mask.remove());
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);
  return mask;
}
