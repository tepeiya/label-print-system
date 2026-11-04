<template>
  <div>
    <div class="page-header">
      <h2>🖨️ 打印任务</h2>
      <el-tag type="info">最近 {{ days }} 天</el-tag>
    </div>
    <div class="card">
      <el-table :data="jobs" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="templateName" label="模板" min-width="180">
          <template #default="{ row }">{{ row.templateName || '-' }}</template>
        </el-table-column>
        <el-table-column prop="copies" label="份数" width="80" />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="printerName" label="打印机" width="160">
          <template #default="{ row }">{{ row.printerName || '-' }}</template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { apiListPrintJobs } from '@/api';

const days = ref(7);
const loading = ref(false);
const jobs = ref<any[]>([]);

function statusType(s: string) {
  if (s === 'success') return 'success';
  if (s === 'failed') return 'danger';
  if (s === 'pending' || s === 'processing') return 'warning';
  return 'info';
}
function formatTime(t: string) { return t ? new Date(t).toLocaleString() : '-'; }

async function load() {
  loading.value = true;
  try { jobs.value = await apiListPrintJobs({ days: days.value }); }
  finally { loading.value = false; }
}
onMounted(load);
</script>
