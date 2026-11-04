<template>
  <div>
    <div class="page-header">
      <h2>💾 备份中心</h2>
      <div style="display: flex; gap: 8px;">
        <el-button type="primary" :disabled="!auth.isAdmin" @click="doCreate" :loading="creating">
          <el-icon><Plus /></el-icon> 创建备份
        </el-button>
      </div>
    </div>
    <div class="card">
      <el-table :data="backups" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="名称" min-width="200">
          <template #default="{ row }">{{ row.name || `backup-${row.id}` }}</template>
        </el-table-column>
        <el-table-column prop="tableCount" label="表数" width="100" />
        <el-table-column label="大小" width="120">
          <template #default="{ row }">{{ formatSize(row.dataLength) }}</template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" :disabled="!auth.isAdmin" @click="doRestore(row)">恢复</el-button>
            <el-popconfirm title="恢复会覆盖当前数据，确认？" @confirm="doRestore(row)" v-if="auth.isAdmin">
              <template #reference>
                <el-button link size="small" type="primary">恢复（带确认）</el-button>
              </template>
            </el-popconfirm>
            <el-button link size="small" type="danger" :disabled="!auth.isAdmin" @click="doDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/store/auth';
import { apiListBackups, apiCreateBackup, apiDeleteBackup, apiRestoreBackup } from '@/api';

const auth = useAuthStore();
const loading = ref(false);
const creating = ref(false);
const backups = ref<any[]>([]);

function formatSize(bytes: number) {
  if (!bytes) return '-';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
function formatTime(t: string) { return t ? new Date(t).toLocaleString() : '-'; }

async function load() {
  loading.value = true;
  try { backups.value = await apiListBackups(); }
  finally { loading.value = false; }
}
async function doCreate() {
  creating.value = true;
  try {
    await apiCreateBackup(`backup-${new Date().toISOString().slice(0, 10)}`);
    ElMessage.success('备份创建成功');
    await load();
  } catch {}
  finally { creating.value = false; }
}
async function doRestore(row: any) {
  await apiRestoreBackup(row.id);
  ElMessage.success('已触发恢复（异步）');
  await load();
}
async function doDelete(row: any) {
  await apiDeleteBackup(row.id);
  ElMessage.success('已删除');
  await load();
}
onMounted(load);
</script>
