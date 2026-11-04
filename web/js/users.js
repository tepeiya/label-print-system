// =============================================================================
// users.js —— 用户管理（admin 专属）
//   · 列出当前租户所有用户
//   · 每行角色可勾选授予 / 撤销
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

export function initUsers() {
  document.getElementById('btn-users-refresh')?.addEventListener('click', () => refreshUsers(true));
  document.addEventListener('users-refresh', () => refreshUsers());
}

/** 切到 users tab 时由 switchTab 触发 */
export async function refreshUsers(force = false) {
  const tbody = document.getElementById('users-list-body');
  const stat = document.getElementById('users-stat');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="tpl-empty">加载中…</td></tr>';
  if (stat) stat.textContent = '';
  try {
    const list = await api.listUsers();
    renderUsers(list);
    if (stat) stat.textContent = `共 ${list.length} 位用户`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="tpl-empty" style="color:#ef4444">加载失败：${escapeHtml(e.message || e)}</td></tr>`;
    if (stat) stat.textContent = '';
  }
}

function renderUsers(list) {
  const tbody = document.getElementById('users-list-body');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tpl-empty">暂无用户</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const u of list) {
    tbody.appendChild(buildRow(u));
  }
}

function buildRow(u) {
  const tr = document.createElement('tr');
  tr.dataset.userId = String(u.id);
  tr.innerHTML = `
    <td>${escapeHtml(String(u.id))}</td>
    <td><b>${escapeHtml(u.username)}</b></td>
    <td>${escapeHtml(u.displayName || '—')}</td>
    <td>${escapeHtml(u.email || '—')}</td>
    <td>${u.status === 1 ? '<span style="color:#10b981">● 正常</span>' : '<span style="color:#6b7280">○ 停用</span>'}</td>
    <td class="u-roles" style="white-space:normal">${buildRoles(u)}</td>
    <td style="color:#6b7280;font-size:12px">${escapeHtml(formatDate(u.createdAt))}</td>
  `;
  // 角色切换绑定
  tr.querySelectorAll('input[data-role]').forEach((cb) => {
    cb.addEventListener('change', () => toggleRole(u.id, cb.dataset.role, cb.checked));
  });
  return tr;
}

function buildRoles(u) {
  const current = new Set(u.roles || []);
  return ROLE_ORDER.map((r) => {
    const on = current.has(r) ? 'checked' : '';
    const disabled = (r === 'admin') ? '' : ''; // 都允许切换，后端保护最后一个 admin
    return `<label style="display:inline-flex;align-items:center;gap:2px;margin:1px 4px 1px 0;font-size:12px;">
      <input type="checkbox" data-role="${r}" ${on} ${disabled}> ${ROLE_LABELS[r]}
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
    // 失败回滚 checkbox
    refreshUsers();
  }
}

function formatDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
