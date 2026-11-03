// =============================================================================
// app.js —— 应用入口：标签页 / 工具栏 / 画布渲染 / 键盘快捷键
// =============================================================================

import { store } from './store.js';
import { TOOLS, createElement, defaultTemplate } from './model.js';
import { renderElement, buildContext } from './render.js';
import { initInteractions, drawOverlay } from './interactions.js';
import { renderInspector, setInspectorTab, getInspectorTab } from './inspector.js';
import { initPrint, generate } from './print.js';
import { initTemplates, loadList, resetCurrentTemplateId } from './templates.js';
import { initJobs, refreshJobs, loadAudit } from './jobs.js';
import { initPrinters, subscribePrintEvents } from './printers.js';
import { initGuides, refreshRulers } from './guides.js';
import { ensureLogin, api } from './api.js';
import { MM2PX, deepClone, uid, r2, toast, downloadFile, clamp } from './util.js';

const PXMM = MM2PX;
const AUTOSAVE_KEY = 'labelflow.autosave.v1';

const els = {};

function $(id) { return document.getElementById(id); }

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function boot() {
  els.page = $('page');
  els.elements = $('page-elements');
  els.overlay = $('page-overlay');
  els.viewport = $('viewport');
  els.inspector = $('inspector');
  els.status = $('statusbar');

  buildToolbox();
  bindTabs();
  bindToolbar();
  bindInspectorTabs();
  bindKeyboard();
  bindImportExport();
  initPrint();
  initTemplates();
  initJobs();
  initPrinters();

  restoreAutosave();

  initInteractions({
    viewport: els.viewport,
    page: els.page,
    overlay: els.overlay,
    onChange: () => { renderStatus(); },
    onPointerMm: (mm) => setCursorMm(mm),
    onZoom: (z, e) => applyZoom(z, e),
  });

  initGuides({
    canvasArea: document.querySelector('.canvas-area'),
    viewport: els.viewport,
    page: els.page,
    overlay: els.overlay,
    onChange: () => renderStatus(),
  });

  store.subscribe(render);

  document.addEventListener('add-element', (e) => addElement(e.detail));

  render();
  document.getElementById('view-design').classList.add('active');
  switchTab('design');

  // 后台登录（失败不影响本地设计与打印预览）
  ensureLogin().then(async (ok) => {
    const badge = $('auth-badge');
    if (badge) {
      badge.textContent = ok ? '● 已连接服务器' : '○ 离线模式';
      badge.classList.toggle('offline', !ok);
    }
    if (ok) {
      try {
        const me = await api.me();
        window.LABEFLOW_CURRENT_USER = me;
        applyRoleConstraints(me);
        renderUserBadge(me);
      } catch (e) {
        console.warn('[auth] 拉取用户信息失败：', e);
        window.LABEFLOW_CURRENT_USER = null;
      }
      loadList();
      subscribePrintEvents();
      bindAuditExport();
    } else {
      applyRoleConstraints(null);
    }
  });

  registerServiceWorker();
}

/** PWA：离线壳缓存（仅 https / localhost 生效） */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[pwa] 注册失败', e?.message));
}

// ---------------------------------------------------------------------------
// 画布渲染
// ---------------------------------------------------------------------------
function render() {
  renderCanvas();
  renderInspectorSafe();
  renderStatus();
  renderToolbarState();
  autosave();
}

function renderCanvas() {
  const t = store.state.template;
  const p = t.page;
  const z = store.state.zoom;
  const pageWpx = p.widthMm * PXMM * z;
  const pageHpx = p.heightMm * PXMM * z;

  els.page.style.width = `${pageWpx}px`;
  els.page.style.height = `${pageHpx}px`;
  els.overlay.style.width = `${pageWpx}px`;
  els.overlay.style.height = `${pageHpx}px`;

  const ctx = buildContext(t, selectSampleRow(t), {
    pageNo: 1, pageTotal: 1, serialNo: store.state.serialStart,
  });

  const sorted = [...t.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  const frag = document.createDocumentFragment();
  for (const el of sorted) {
    try {
      frag.appendChild(renderElement(el, { zoom: z, ctx }));
    } catch (e) {
      console.error('[render] 元素渲染失败', el.id, e);
    }
  }
  els.elements.innerHTML = '';
  els.elements.appendChild(frag);

  drawOverlay();
  refreshRulers();
}

function selectSampleRow(t) {
  const rows = store.state.rows;
  if (Array.isArray(rows) && rows.length) return rows[0];
  const row = {};
  for (const v of t.variables ?? []) row[v.name] = v.defaultValue ?? '';
  return row;
}

function renderInspectorSafe() {
  const key = inspectorKey();
  const active = document.activeElement;
  const insideInspector = active && els.inspector && els.inspector.contains(active);
  const editing = insideInspector && isFormField(active);
  // 用户正在输入且选中对象没变：只刷新画布，不重建表单（避免焦点丢失）
  if (editing && key === lastInspectorKey) return;
  // 选中的元素/检查器页签变了：即使焦点还在旧表单里也要重建
  if (insideInspector && typeof active.blur === 'function') active.blur();
  lastInspectorKey = key;
  renderInspector();
}

function isFormField(n) {
  return n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT');
}

let lastInspectorKey = '';

function inspectorKey() {
  return `${store.state.selectedIds.join(',')}|${getInspectorTab()}|${store.state.template.elements.length}`;
}

function renderStatus() {
  const t = store.state.template;
  const sel = store.selectedElements();
  let selText = '无';
  if (sel.length === 1) {
    const e = sel[0];
    selText = `${typeLabel(e.type)}  ${r2(e.w)} × ${r2(e.h)} mm  @ (${r2(e.x)}, ${r2(e.y)})`;
  } else if (sel.length > 1) {
    selText = `${sel.length} 个元素`;
  }
  $('st-selection').textContent = selText;
  $('st-count').textContent = `${t.elements.length} 个元素`;
  $('st-page').textContent = `${t.page.widthMm} × ${t.page.heightMm} mm · ${t.page.dpi} dpi`;
  $('st-zoom').textContent = `${Math.round(store.state.zoom * 100)}%`;
}

function setCursorMm(mm) {
  const n = $('st-cursor');
  if (n) n.textContent = `${mm.x.toFixed(1)}, ${mm.y.toFixed(1)} mm`;
}

function typeLabel(t) {
  return ({ text: '文本', rect: '矩形', ellipse: '椭圆', line: '直线', table: '表格', image: '图片', barcode: '一维码', qrcode: '二维码', formula: '公式', serial: '流水号', datetime: '日期', sysvar: '系统变量' })[t] || t;
}

function renderToolbarState() {
  setDisabled('btn-undo', !store.canUndo());
  setDisabled('btn-redo', !store.canRedo());
  setDisabled('btn-del', store.state.selectedIds.length === 0);
  setDisabled('btn-dup', store.state.selectedIds.length === 0);
  $('tpl-name').value = $('tpl-name').value; // 保持
}

function setDisabled(id, v) {
  const b = $(id);
  if (b) b.disabled = !!v;
}

// ---------------------------------------------------------------------------
// 工具箱
// ---------------------------------------------------------------------------
function buildToolbox() {
  const host = $('toolbox');
  for (const g of TOOLS) {
    const title = document.createElement('div');
    title.className = 'tool-group-title';
    title.textContent = g.group;
    host.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'tool-grid';
    for (const it of g.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool-btn';
      b.dataset.type = it.type;
      b.innerHTML = `<span class="tool-ico">${it.icon}</span><span class="tool-label">${it.label}</span>`;
      b.addEventListener('click', () => addElement(it.type));
      grid.appendChild(b);
    }
    host.appendChild(grid);
  }
}

function addElement(type) {
  const el = createElement(type, store.state.template);
  // 放在可见区域中央附近
  const p = store.state.template.page;
  el.x = r2(clamp(p.widthMm / 2 - el.w / 2, 0, Math.max(0, p.widthMm - el.w)));
  el.y = r2(clamp(p.heightMm / 2 - el.h / 2, 0, Math.max(0, p.heightMm - el.h)));
  store.addElement(el);
  switchTab('design');
  setInspectorTab('properties');
}

// ---------------------------------------------------------------------------
// 主标签页
// ---------------------------------------------------------------------------
function bindTabs() {
  document.querySelectorAll('#main-tabs .tab').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  window.addEventListener('goto-tab', (e) => switchTab(e.detail));
}

export function switchTab(name) {
  store.state.activeTab = name;
  document.querySelectorAll('#main-tabs .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === `view-${name}`);
  });
  if (name === 'print') generate();
  if (name === 'templates') loadList($('tpl-search')?.value || '');
  if (name === 'jobs') refreshJobs();
  if (name === 'audit') loadAudit();
  if (name === 'printers') window.dispatchEvent(new CustomEvent('printers-refresh'));
}

// ---------------------------------------------------------------------------
// 工具栏
// ---------------------------------------------------------------------------
function bindToolbar() {
  const on = (id, fn) => $(id)?.addEventListener('click', fn);

  on('btn-undo', () => { if (!store.undo()) toast('没有可撤销的操作'); });
  on('btn-redo', () => { if (!store.redo()) toast('没有可重做的操作'); });
  on('btn-zoom-out', () => applyZoom(store.state.zoom - 0.1));
  on('btn-zoom-in', () => applyZoom(store.state.zoom + 0.1));
  on('btn-zoom-100', () => applyZoom(1));
  on('btn-zoom-fit', () => zoomFit());

  on('btn-front', () => store.bringToFront());
  on('btn-up', () => store.bringForward());
  on('btn-down', () => store.sendBackward());
  on('btn-back', () => store.sendToBack());
  on('btn-dup', () => store.duplicateSelected());
  on('btn-del', () => store.removeElements());

  on('btn-save', () => $('btn-tpl-save')?.click() || window.dispatchEvent(new CustomEvent('save-request')));
  on('btn-new', () => {
    if (!confirm('新建模板会清空当前画布，是否继续？')) return;
    store.newTemplate();
    resetCurrentTemplateId();
    $('tpl-name').value = '未命名标签';
    toast('已新建空白模板');
  });
}

function applyZoom(next, e) {
  const old = store.state.zoom;
  const z = clamp(r2(next), 0.2, 4);
  if (Math.abs(z - old) < 0.001) return;
  store.state.zoom = z;
  renderCanvas();
  renderStatus();
  renderToolbarState();

  // 以鼠标位置为锚点保持视觉位置
  if (e) {
    const r = els.viewport.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const ratio = z / old;
    els.viewport.scrollLeft = (els.viewport.scrollLeft + dx) * ratio - dx;
    els.viewport.scrollTop = (els.viewport.scrollTop + dy) * ratio - dy;
  }
}

function zoomFit() {
  const p = store.state.template.page;
  const vp = els.viewport;
  const availW = vp.clientWidth - 48;
  const availH = vp.clientHeight - 48;
  const z = Math.min(availW / (p.widthMm * PXMM), availH / (p.heightMm * PXMM));
  applyZoom(z);
}

// ---------------------------------------------------------------------------
// 检查器标签
// ---------------------------------------------------------------------------
function bindInspectorTabs() {
  document.querySelectorAll('#inspector-tabs .itab').forEach((b) => {
    b.addEventListener('click', () => {
      lastInspectorKey = '';
      setInspectorTab(b.dataset.tab);
    });
  });
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------
function isTyping(target) {
  return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); store.redo(); return; }
    if (mod && key === 'a') { e.preventDefault(); store.selectAll(); return; }
    if (mod && key === 'd') { e.preventDefault(); store.duplicateSelected(); return; }
    if (mod && key === 'c') { e.preventDefault(); copySelection(); return; }
    if (mod && key === 'v') { e.preventDefault(); pasteClipboard(); return; }
    if (mod && key === 'x') { e.preventDefault(); copySelection(); store.removeElements(); return; }
    if (mod && (key === 's')) { e.preventDefault(); $('btn-tpl-save')?.click(); return; }
    if (mod && key === 'g') {
      e.preventDefault();
      if (e.shiftKey) store.ungroupSelected();
      else store.groupSelected();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      store.removeElements();
      return;
    }
    if (e.key === 'Escape') { store.clearSelection(); return; }

    const step = e.shiftKey ? 1 : 0.1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!store.state.selectedIds.length) return;
      e.preventDefault();
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      store.pushHistory();
      for (const el of store.selectedElements()) {
        el.x = r2(Math.max(0, el.x + dx));
        el.y = r2(Math.max(0, el.y + dy));
      }
      store.emit();
    }
  });
}

function copySelection() {
  store.state.clipboard = deepClone(store.selectedElements());
}

function pasteClipboard() {
  const clip = store.state.clipboard;
  if (!clip?.length) return;
  const maxZ = store.state.template.elements.reduce((m, e) => Math.max(m, e.zIndex ?? 0), 0);
  const copies = clip.map((e, i) => ({ ...deepClone(e), id: uid(), x: r2(e.x + 3), y: r2(e.y + 3), zIndex: maxZ + i + 1 }));
  store.tx((t) => { t.elements.push(...copies); });
  store.select(copies.map((c) => c.id));
}

// ---------------------------------------------------------------------------
// 导入导出
// ---------------------------------------------------------------------------
function bindImportExport() {
  $('btn-export')?.addEventListener('click', () => {
    const name = ($('tpl-name')?.value || 'label').replace(/[\\/:*?"<>|]/g, '_');
    downloadFile(`${name}.json`, JSON.stringify(store.state.template, null, 2));
    toast('已导出模板 JSON');
  });

  const fileInput = $('import-file');
  $('btn-import')?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const t = JSON.parse(String(reader.result));
        if (!t.page || !Array.isArray(t.elements)) throw new Error('不是合法的模板文件');
        store.loadTemplate(t);
        $('tpl-name').value = f.name.replace(/\.json$/i, '');
        resetCurrentTemplateId();
        toast('模板已导入', 'success');
      } catch (err) {
        toast('导入失败：' + err.message, 'error');
      }
      fileInput.value = '';
    };
    reader.readAsText(f);
  });

  $('tpl-name')?.addEventListener('change', () => autosave());
}

// ---------------------------------------------------------------------------
// 自动保存
// ---------------------------------------------------------------------------
let saveTimer = 0;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(store.state.template));
    } catch (e) { /* 忽略配额错误 */ }
  }, 400);
}

function restoreAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return;
    const t = JSON.parse(raw);
    if (t?.page && Array.isArray(t.elements)) store.loadTemplate(t);
  } catch (e) {
    store.loadTemplate(defaultTemplate());
  }
}

// ---------------------------------------------------------------------------
// 审计导出
// ---------------------------------------------------------------------------
function bindAuditExport() {
  const action = document.getElementById('audit-action');
  const mk = (format) => () => {
    const url = api.auditExportUrl(format, {
      action: action?.value?.trim() || '',
      limit: 20000,
    });
    const a = document.createElement('a');
    a.href = url; a.download = `audit-${format}-${Date.now()}.${format}`;
    a.click();
  };
  document.getElementById('btn-audit-export-csv')?.addEventListener('click', mk('csv'));
  document.getElementById('btn-audit-export-json')?.addEventListener('click', mk('json'));
}

// ---------------------------------------------------------------------------
// RBAC：按角色约束按钮可用性
// ---------------------------------------------------------------------------

/** 判断当前用户是否命中任一角色（admin 视为万能） */
function hasAnyRole(user, ...roles) {
  if (!user || !Array.isArray(user.roles)) return false;
  if (user.roles.includes('admin')) return true;
  return roles.some((r) => user.roles.includes(r));
}

const WRITE_ROLES = ['admin', 'operator'];
const ADMIN_ONLY = ['admin'];

/** 一次性 UI 约束：隐藏/禁用危险按钮 */
function applyRoleConstraints(user) {
  // 模板写操作：保存/新建/导出/导入
  const canTplWrite = hasAnyRole(user, ...WRITE_ROLES);
  disableById('btn-save', !canTplWrite);
  disableById('btn-new', !canTplWrite);
  // 导入导出：viewer 也能导出自己看，不让保存/新建足够
  // 数据源写操作
  const canDsWrite = hasAnyRole(user, ...WRITE_ROLES);
  disableById('btn-save-source', !canDsWrite);
  // 打印机写操作
  const canPrinterWrite = hasAnyRole(user, ...WRITE_ROLES);
  disableById('btn-printer-add', !canPrinterWrite);
  // 打印提交
  const canPrint = hasAnyRole(user, ...WRITE_ROLES);
  disableById('btn-queue-print', !canPrint);
  // admin 专属
  const isAdmin = hasAnyRole(user, ...ADMIN_ONLY);
  const hideIf = (id, v) => { const el = document.getElementById(id); if (el) el.hidden = v; };
  hideIf('btn-audit-export-csv', !isAdmin);
  hideIf('btn-audit-export-json', !isAdmin);

  // 打印机详情卡片的危险按钮（JS 动态渲染）：post-process 委托
  document.body.dataset.roles = (user?.roles ?? []).join(',');
}

function disableById(id, v) {
  const el = document.getElementById(id);
  if (el) el.disabled = !!v;
}

/** 在顶栏 auth-badge 右侧渲染当前用户信息 */
function renderUserBadge(user) {
  const host = document.getElementById('auth-badge');
  if (!host) return;
  let badge = document.getElementById('user-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'user-badge';
    badge.className = 'user-badge';
    host.parentElement?.insertBefore(badge, host.nextSibling);
  }
  if (!user) { badge.textContent = ''; badge.hidden = true; return; }
  const label = user.displayName || user.username || '';
  const roles = (user.roles || []).map(roleLabel).join('·');
  badge.hidden = false;
  badge.textContent = `${label} · ${roles}`;
}

/** 小工具：把 r 映射成中文角色名，命中不到则原样返回 */
function roleLabel(r) {
  return { admin: '管理员', operator: '操作员', sql: 'SQL', viewer: '只读' }[r] || r;
}

// ---------------------------------------------------------------------------
boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:24px;font-family:sans-serif">
    <h2>启动失败</h2><pre>${String(e && e.stack || e)}</pre></div>`;
});
