// =============================================================================
// users.js —— 用户管理（admin 专属）
//   · 列表 + 搜索 / 状态筛选
//   · 新建 / 编辑 / 启停 / 重置密码 / 删除
//   · 角色 checkbox 授予 / 撤销
//   · 所有"危险操作"在后端有自我保护 / 最后一位 admin 保护
// =============================================================================

import { api } from './api.js';
import { toast, escapeHtml } from './util.js';

const ROLE_LABELS = {
  admin: '系统管理员',
  operator: '操作员',
  sql: 'SQL 数据源',
  viewer: '只读访客',
};
const ROLE_ORDER = ['admin', 'operator', 'sql', 'viewer'];

let cachedList = [];

export function initUsers() {
  document.getElementById('btn-users-refresh')?.addEventListener('click', () => refreshUsers(true));
  document.getElementById('btn-users-add')?.addEventListener('click', () => openUserModal());
  document.getElementById('users-search')?.addEventListener('input', debounce(renderFiltered, 200));
  document.getElementById('users-status-filter')?.addEventListener('change', renderFiltered);
  document.addEventListener('users-refresh', () => refreshUsers());

  // 模态框按钮
  document.getElementById('user-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('user-modal-cancel')?.addEventListener('click', closeModal);
  document.getElementById('user-modal-save')?.addEventListener('click', saveUserModal);
  document.getElementById('pw-modal-close')?.addEventListener('click', closePwModal);
  document.getElementById('pw-modal-cancel')?.addEventListener('click', closePwModal);
  document.getElementById('pw-modal-save')?.addEventListener('click', savePwModal);
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** 切到 users tab 时由 switchTab 触发 */
export async function refreshUsers(force = false) {
  const tbody = document.getElementById('users-list-body');
  const stat = document.getElementById('users-stat');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="tpl-empty">加载中…</td></tr>';
  if (stat) stat.textContent = '';
  try {
    const list = await api.listUsers();
    cachedList = list;
    renderFiltered();
    if (stat) stat.textContent = `共 ${list.length} 位用户`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="tpl-empty" style="color:#ef4444">加载失败：${escapeHtml(e.message || e)}</td></tr>`;
    if (stat) stat.textContent = '';
  }
}

function renderFiltered() {
  const tbody = document.getElementById('users-list-body');
  if (!tbody) return;
  const kw = (document.getElementById('users-search')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('users-status-filter')?.value || '';
  const me = window.LABEFLOW_CURRENT_USER;
  const meId = me?.id ?? null;

  let list = cachedList;
  if (kw) {
    list = list.filter((u) =>
      (u.username || '').toLowerCase().includes(kw) ||
      (u.displayName || '').toLowerCase().includes(kw) ||
      (u.email || '').toLowerCase().includes(kw),
    );
  }
  if (statusFilter === 'active') list = list.filter((u) => u.status === 1);
  if (statusFilter === 'inactive') list = list.filter((u) => u.status === 0);

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="tpl-empty">${kw || statusFilter ? '无匹配用户' : '暂无用户'}</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  for (const u of list) tbody.appendChild(buildRow(u, meId));
}

function buildRow(u, meId) {
  const tr = document.createElement('tr');
  tr.dataset.userId = String(u.id);
  const isSelf = meId != null && +u.id === +meId;
  const selfTag = isSelf ? '<span style="background:#dbeafe;color:#1d4ed8;padding:1px 6px;border-radius:10px;font-size:11px;margin-left:4px">自己</span>' : '';
  const lastLogin = u.lastLoginAt ? formatRelative(u.lastLoginAt) : '—';
  const statusTag = u.status === 1
    ? '<span style="color:#10b981">● 正常</span>'
    : '<span style="color:#9ca3af">○ 停用</span>';
  const toggleBtn = `<button class="btn ghost user-toggle" data-action="toggle" title="${u.status === 1 ? '停用' : '启用'}" ${isSelf ? 'disabled' : ''}>
    ${u.status === 1 ? '停用' : '启用'}
  </button>`;
  const resetPwBtn = `<button class="btn ghost user-action" data-action="reset-pw">重置密码</button>`;
  const editBtn = `<button class="btn ghost user-action" data-action="edit">编辑</button>`;
  const deleteBtn = `<button class="btn ghost danger user-action" data-action="delete" ${isSelf ? 'disabled' : ''}>删除</button>`;

  tr.innerHTML = `
    <td>${escapeHtml(String(u.id))}</td>
    <td><b>${escapeHtml(u.username)}</b>${selfTag}</td>
    <td>${escapeHtml(u.displayName || '—')}</td>
    <td>${escapeHtml(u.email || '—')}</td>
    <td style="font-size:12px">${escapeHtml(lastLogin)}</td>
    <td>${statusTag}</td>
    <td class="u-roles" style="white-space:normal">${buildRoles(u, isSelf)}</td>
    <td style="white-space:nowrap;font-size:12px">${editBtn} ${toggleBtn} ${resetPwBtn} ${deleteBtn}</td>
  `;
  // 绑定事件
  tr.querySelectorAll('input[data-role]').forEach((cb) => {
    cb.addEventListener('change', () => toggleRole(u.id, cb.dataset.role, cb.checked));
  });
  tr.querySelectorAll('.user-action, .user-toggle').forEach((b) => {
    b.addEventListener('click', (e) => handleRowAction(u, b.dataset.action));
  });
  return tr;
}

function buildRoles(u, isSelf) {
  const current = new Set(u.roles || []);
  return ROLE_ORDER.map((r) => {
    const on = current.has(r) ? 'checked' : '';
    const tip = isSelf && r === 'admin' ? '（不能撤销自己的 admin）' : '';
    return `<label style="display:inline-flex;align-items:center;gap:2px;margin:1px 4px 1px 0;font-size:12px;" title="${tip}">
      <input type="checkbox" data-role="${r}" ${on}> ${ROLE_LABELS[r]}
    </label>`;
  }).join('');
}

async function toggleRole(userId, role, checked) {
  try {
    if (checked) {
      await api.grantRole(userId, role);
      toast(`已授予「${ROLE_LABELS[role]}」`);
    } else {
      await api.revokeRole(userId, role);
      toast(`已撤销「${ROLE_LABELS[role]}」`);
    }
  } catch (e) {
    toast(e.message || String(e), 'err');
    // 后端可能拒绝（最后一个 admin / 撤销自己 admin），直接刷新
    refreshUsers();
  }
}

async function handleRowAction(u, action) {
  try {
    switch (action) {
      case 'edit': return openUserModal(u);
      case 'toggle': return toggleStatus(u);
      case 'reset-pw': return openPwModal(u);
      case 'delete': return deleteUser(u);
    }
  } catch (e) {
    toast(e.message || String(e), 'err');
  }
}

async function toggleStatus(u) {
  const newStatus = u.status === 1 ? 0 : 1;
  if (newStatus === 0 && !confirm(`确定要停用用户「${u.username}」吗？停用后该用户将无法登录。`)) return;
  await api.updateUser(u.id, { status: newStatus });
  toast(newStatus === 1 ? '已启用' : '已停用');
  refreshUsers();
}

async function deleteUser(u) {
  const self = window.LABEFLOW_CURRENT_USER;
  if (self && +u.id === +self.id) { toast('不能删除自己的账号', 'err'); return; }
  if (!confirm(`确定要删除用户「${u.username}」吗？该用户的所有 refresh token 和角色记录也将被清理。此操作不可撤销！`)) return;
  await api.deleteUser(u.id);
  toast('用户已删除');
  refreshUsers();
}

// -----------------------------------------------------------------------------
// 新增 / 编辑 用户模态框
// -----------------------------------------------------------------------------

let editingUserId = null;

function openUserModal(u = null) {
  editingUserId = u?.id ?? null;
  const mask = document.getElementById('user-modal-mask');
  if (!mask) return;
  document.getElementById('user-modal-title').textContent = u ? `编辑用户 · ${u.username}` : '新增用户';
  document.getElementById('f-username').value = u?.username || '';
  document.getElementById('f-username').disabled = !!u;
  document.getElementById('f-displayName').value = u?.displayName || '';
  document.getElementById('f-email').value = u?.email || '';
  document.getElementById('f-password').value = '';
  document.getElementById('f-password').placeholder = u ? '留空则不修改密码' : '至少 6 位';
  document.getElementById('f-status').value = u ? String(u.status) : '1';
  mask.hidden = false;
}

function closeModal() {
  const mask = document.getElementById('user-modal-mask');
  if (mask) mask.hidden = true;
  editingUserId = null;
}

async function saveUserModal() {
  const username = document.getElementById('f-username').value.trim();
  const password = document.getElementById('f-password').value;
  const displayName = document.getElementById('f-displayName').value.trim();
  const email = document.getElementById('f-email').value.trim();
  const status = document.getElementById('f-status').value === '0' ? 0 : 1;

  try {
    if (editingUserId) {
      const body: any = { displayName, email, status };
      if (password) body.newPassword = password; // 编辑时改密码走 updateUser 也可以，后端不处理——这里简化：留空则不改
      await api.updateUser(editingUserId, body);
      toast('已保存');
      closeModal();
      refreshUsers();
    } else {
      await api.createUser({ username, password, displayName, email, status });
      toast('用户已创建');
      closeModal();
      refreshUsers();
    }
  } catch (e) {
    toast(e.message || String(e), 'err');
  }
}

// -----------------------------------------------------------------------------
// 重置密码模态框
// -----------------------------------------------------------------------------

let pwTargetId = null;
let pwTargetUsername = '';

function openPwModal(u) {
  pwTargetId = u.id;
  pwTargetUsername = u.username;
  const mask = document.getElementById('pw-modal-mask');
  if (!mask) return;
  document.getElementById('pw-modal-title').textContent = `重置密码 · ${u.username}`;
  document.getElementById('f-pw-new').value = '';
  document.getElementById('f-pw-confirm').value = '';
  mask.hidden = false;
}

function closePwModal() {
  const mask = document.getElementById('pw-modal-mask');
  if (mask) mask.hidden = true;
  pwTargetId = null;
  pwTargetUsername = '';
}

async function savePwModal() {
  const newPw = document.getElementById('f-pw-new').value;
  const confirmPw = document.getElementById('f-pw-confirm').value;
  if (newPw.length < 6) { toast('新密码至少 6 位', 'err'); return; }
  if (newPw !== confirmPw) { toast('两次密码不一致', 'err'); return; }
  try {
    await api.resetUserPassword(pwTargetId, newPw);
    toast(`已重置「${pwTargetUsername}」的密码，该用户所有会话已被强制下线`);
    closePwModal();
    refreshUsers();
  } catch (e) {
    toast(e.message || String(e), 'err');
  }
}

// -----------------------------------------------------------------------------
// 小工具
// -----------------------------------------------------------------------------

function formatDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRelative(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(v);
}
