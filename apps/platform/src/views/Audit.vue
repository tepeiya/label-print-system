<template>
  <div>
    <div class="page-header">
      <h2>📜 平台审计</h2>
      <span class="muted sub">最近 {{ rows.length }} 条（接口固定返回最新 200 条，无分页）</span>
      <el-button @click="load" :loading="loading">刷新</el-button>
    </div>

    <div class="card">
      <el-table :data="rows" v-loading="loading" stripe size="small" style="width: 100%">
        <el-table-column type="expand">
          <template #default="{ row }">
            <pre class="detail-pre">{{ pretty(row.detail) }}</pre>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作人" width="150">
          <template #default="{ row }">
            {{ row.actorName || '-' }}
            <span class="muted sub">#{{ row.actorId }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="action" label="动作" width="200" />
        <el-table-column label="对象" width="170">
          <template #default="{ row }">
            <span v-if="row.targetType">
              {{ row.targetType }}<span v-if="row.targetId != null"> #{{ row.targetId }}</span>
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="详情" min-width="260">
          <template #default="{ row }">
            <code class="inline-detail">{{ brief(row.detail) }}</code>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !rows.length" description="还没有平台操作记录" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { apiPlatformAudit } from '@/api';
import type { PlatformAuditLog } from '@/api/types';

const loading = ref(false);
const rows = ref<PlatformAuditLog[]>([]);

const fmtTime = (t: string) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-');

/** 展开行：detail 是 jsonb，格式化后给运营看全貌 */
function pretty(detail: Record<string, unknown> | null): string {
  if (detail == null) return '（无）';
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

/** 列表行：压成一行，过长截断，完整内容看展开行 */
function brief(detail: Record<string, unknown> | null): string {
  const one = pretty(detail).replace(/\s+/g, ' ');
  return one.length > 90 ? `${one.slice(0, 90)}…` : one;
}

async function load() {
  loading.value = true;
  try {
    rows.value = await apiPlatformAudit();
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.sub { font-size: 12px; margin-right: 12px; }
.inline-detail { font-size: 12px; word-break: break-all; }
</style>
