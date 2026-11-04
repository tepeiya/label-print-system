<template>
  <div>
    <div class="page-header">
      <h2>👥 用户管理</h2>
      <el-button type="primary" v-permission="'sys:user:manage'" @click="openCreate">
        <el-icon><UserFilled /></el-icon> 新增用户
      </el-button>
    </div>

    <div class="card">
      <el-table :data="users" v-loading="loading" stripe style="width: 100%">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="username" label="用户名" width="150" />
        <el-table-column prop="displayName" label="显示名" width="140">
          <template #default="{ row }">{{ row.displayName || '-' }}</template>
        </el-table-column>
        <el-table-column prop="email" label="邮箱" min-width="180">
          <template #default="{ row }">{{ row.email || '-' }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
              {{ row.status || 'active' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="角色" min-width="220">
          <template #default="{ row }">
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              <el-tag
                v-for="role in allRoles"
                :key="role"
                :type="row.roles?.includes(role) ? 'primary' : 'info'"
                :effect="row.roles?.includes(role) ? 'dark' : 'plain'"
                size="small"
                :style="{ cursor: auth.hasPermission('sys:user:manage') ? 'pointer' : 'default' }"
                :title="auth.hasPermission('sys:user:manage') ? '点击切换' : ''"
                @click="toggleRole(row, role)"
              >{{ role }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <!-- P1：用户管理的写操作在后端是 sys:user:manage（角色 tag 点击同理），
                 这里统一用权限点判定，不再判 isAdmin —— 租户管理员没有 isAdmin
                 也能管自己租户的用户。 -->
            <el-button link size="small" v-permission="'sys:user:manage'" @click="openEdit(row)">编辑</el-button>
            <el-button link size="small" v-permission="'sys:user:manage'" @click="openResetPw(row)">重置密码</el-button>
            <el-popconfirm v-if="row.id !== auth.user?.id && auth.hasPermission('sys:user:manage')"
                           title="确认删除？该用户所有数据一并删除" @confirm="doDelete(row)">
              <template #reference>
                <el-button link size="small" type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 创建/编辑模态框 -->
    <el-dialog v-model="dialog.show" :title="dialog.mode === 'create' ? '新增用户' : '编辑用户'" width="440px">
      <el-form :model="dialog.form" label-width="80px">
        <el-form-item label="用户名">
          <el-input v-model="dialog.form.username" :disabled="dialog.mode === 'edit'" />
        </el-form-item>
        <el-form-item label="密码" v-if="dialog.mode === 'create'">
          <el-input v-model="dialog.form.password" type="password" show-password />
        </el-form-item>
        <el-form-item label="显示名">
          <el-input v-model="dialog.form.displayName" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="dialog.form.email" />
        </el-form-item>
        <el-form-item label="角色">
          <el-checkbox-group v-model="dialog.form.roles">
            <el-checkbox v-for="r in allRoles" :key="r" :value="r">{{ r }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.show = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doSave">确定</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码模态框 -->
    <el-dialog v-model="pwDialog.show" title="重置密码" width="380px">
      <el-form :model="pwDialog" label-width="80px">
        <el-form-item label="新密码">
          <el-input v-model="pwDialog.password" type="password" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwDialog.show = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doResetPw">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/store/auth';
import {
  apiListUsers, apiCreateUser, apiUpdateUser, apiDeleteUser,
  apiResetUserPassword, apiGrantRole, apiRevokeRole,
} from '@/api';

const auth = useAuthStore();
const allRoles = ['admin', 'operator', 'sql', 'viewer'];
const loading = ref(false);
const saving = ref(false);
const users = ref<any[]>([]);

const dialog = reactive<any>({ show: false, mode: 'create', form: { username: '', password: '', displayName: '', email: '', roles: [] } });
const pwDialog = reactive({ show: false, password: '', userId: 0, username: '' });

async function load() {
  loading.value = true;
  try {
    users.value = await apiListUsers();
  } catch { /* 拦截器已弹 */ }
  finally { loading.value = false; }
}

function openCreate() {
  dialog.mode = 'create';
  dialog.form = { username: '', password: '', displayName: '', email: '', roles: ['viewer'] };
  dialog.show = true;
}
function openEdit(row: any) {
  dialog.mode = 'edit';
  dialog.form = { ...row, roles: row.roles || [] };
  dialog.show = true;
}

async function doSave() {
  if (!dialog.form.username) return ElMessage.warning('用户名不能为空');
  saving.value = true;
  try {
    if (dialog.mode === 'create') {
      if (!dialog.form.password || dialog.form.password.length < 6) {
        saving.value = false;
        return ElMessage.warning('密码至少 6 位');
      }
      const u: any = await apiCreateUser({
        username: dialog.form.username,
        password: dialog.form.password,
        displayName: dialog.form.displayName,
        email: dialog.form.email,
      });
      // 批量授予角色
      for (const r of (dialog.form.roles || [])) {
        await apiGrantRole(u.id, r);
      }
      ElMessage.success('创建成功');
    } else {
      const upd: any = await apiUpdateUser(dialog.form.id, {
        displayName: dialog.form.displayName,
        email: dialog.form.email,
      });
      // 角色差异同步
      const oldRoles: string[] = upd.roles || [];
      const newRoles: string[] = dialog.form.roles || [];
      for (const r of newRoles) {
        if (!oldRoles.includes(r)) await apiGrantRole(dialog.form.id, r);
      }
      for (const r of oldRoles) {
        if (!newRoles.includes(r)) await apiRevokeRole(dialog.form.id, r);
      }
      ElMessage.success('更新成功');
    }
    dialog.show = false;
    await load();
  } catch { /* 拦截器已弹 */ }
  finally { saving.value = false; }
}

async function toggleRole(row: any, role: string) {
  if (!auth.hasPermission('sys:user:manage')) return;
  const has = row.roles?.includes(role);
  if (has) {
    await apiRevokeRole(row.id, role);
    row.roles = row.roles.filter((r: string) => r !== role);
    ElMessage.success(`已撤销 ${role}`);
  } else {
    await apiGrantRole(row.id, role);
    row.roles = [...(row.roles || []), role];
    ElMessage.success(`已授予 ${role}`);
  }
}

function openResetPw(row: any) {
  pwDialog.show = true;
  pwDialog.userId = row.id;
  pwDialog.username = row.username;
  pwDialog.password = '';
}
async function doResetPw() {
  if (!pwDialog.password || pwDialog.password.length < 6) return ElMessage.warning('密码至少 6 位');
  saving.value = true;
  try {
    await apiResetUserPassword(pwDialog.userId, pwDialog.password);
    ElMessage.success('密码已重置，所有设备需重新登录');
    pwDialog.show = false;
  } catch { /* 拦截器已弹 */ }
  finally { saving.value = false; }
}

async function doDelete(row: any) {
  saving.value = true;
  try {
    await apiDeleteUser(row.id);
    ElMessage.success('已删除');
    await load();
  } catch { /* 拦截器已弹 */ }
  finally { saving.value = false; }
}

onMounted(load);
</script>
