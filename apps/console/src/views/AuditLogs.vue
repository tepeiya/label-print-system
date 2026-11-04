<template>
  <div>
    <div class="page-header">
      <h2>📜 审计日志</h2>
      <div style="display: flex; gap: 8px;">
        <el-button v-permission.hide="'audit:export'" @click="doExport('csv')">导出 CSV</el-button>
        <el-button v-permission.hide="'audit:export'" @click="doExport('json')">导出 JSON</el-button>
        <el-button @click="load" :loading="loading">刷新</el-button>
      </div>
    </div>

    <div class="card" style="margin-bottom: 16px;">
      <el-form inline>
        <el-form-item label="动作">
          <el-select v-model="query.action" clearable filterable placeholder="全部" style="width: 240px;">
            <el-option v-for="a in actions" :key="a" :label="a" :value="a" />
          </el-select>
        </el-form-item>
        <el-form-item label="每页">
          <el-select v-model="query.pageSize" style="width: 110px;">
            <el-option v-for="n in [50, 100, 200, 500]" :key="n" :label="n" :value="n" />
          </el-select>
        </el-form-item>
        <el-form-item label="页码">
          <el-input-number v-model="query.page" :min="1" controls-position="right" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="load">查询</el-button>
        </el-form-item>
      </el-form>
    </div>

    <div class="card">
      <el-table :data="rows" v-loading="loading" stripe size="small">
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="action" label="动作" width="220" />
        <el-table-column label="对象" width="180">
          <template #default="{ row }">
            <span v-if="row.targetType">{{ row.targetType }}<span v-if="row.targetId"> #{{ row.targetId }}</span></span>
            <span v-else style="color: #999;">—</span>
          </template>
        </el-table-column>
        <el-table-column label="执行人" width="100">
          <template #default="{ row }">{{ row.actorId ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="详情" min-width="280">
          <template #default="{ row }">
            <code style="font-size: 12px; word-break: break-all;">{{ pretty(row.detail) }}</code>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !rows.length" description="没有符合条件的日志" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { apiListAuditLogs, auditExportUrl } from '@/api';

const loading = ref(false);
const rows = ref<any[]>([]);
const query = reactive<{ action?: string; page: number; pageSize: number }>({ action: '', page: 1, pageSize: 100 });

/** 动作下拉：取当前页里出现过的 action，够用来做快速过滤（权威清单在后端 audit action 常量里） */
const actions = ref<string[]>([]);

const formatTime = (t: string) => (t ? new Date(t).toLocaleString() : '-');
const pretty = (d: any) => {
  if (d == null) return '—';
  if (typeof d === 'string') return d;
  try { return JSON.stringify(d); } catch { return String(d); }
};

async function load() {
  loading.value = true;
  try {
    const res: any = await apiListAuditLogs({
      page: query.page, pageSize: query.pageSize,
      ...(query.action ? { action: query.action } : {}),
    });
    rows.value = Array.isArray(res) ? res : (res?.items ?? []);
    const set = new Set(actions.value);
    for (const r of rows.value) if (r?.action) set.add(r.action);
    actions.value = Array.from(set).sort();
  } finally {
    loading.value = false;
  }
}

function doExport(format: 'csv' | 'json') {
  // 导出是文件流，走浏览器下载（token 由 JwtAuthGuard 的 query.token 支路接受）
  const params: Record<string, string> = { format, limit: '5000' };
  if (query.action) params.action = query.action;
  window.open(auditExportUrl(params), '_blank');
}

onMounted(load);
</script>
