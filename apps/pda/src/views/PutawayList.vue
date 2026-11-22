<template>
  <div>
    <div class="pda-header">
      <button class="back" @click="router.push('/')">‹</button>
      <div class="title">上架任务</div>
      <button class="btn" style="min-height:36px;padding:0 12px;font-size:13px" @click="load">刷新</button>
    </div>
    <div class="pda-body">
      <div class="row" style="margin-bottom:14px">
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button v-for="f in filters" :key="f.value" class="btn"
            :class="status === f.value ? 'primary' : ''"
            style="min-height:38px;padding:0 12px;font-size:13px"
            @click="status = f.value; load()">{{ f.label }}</button>
        </div>
      </div>
      <div v-if="err" class="notice err">{{ err }}</div>
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!items.length" class="empty">
        <div class="icon">🏬</div>
        <div>暂无上架任务</div>
        <div class="muted" style="margin-top:8px">收货过账后自动生成上架任务</div>
      </div>
      <button v-for="t in items" :key="t.id" class="list-item" @click="router.push(`/putaway/${t.id}`)">
        <div class="row">
          <span class="no">任务 #{{ t.id }}</span>
          <span class="tag" :class="t.status">{{ statusLabel(t.status) }}</span>
        </div>
        <div class="meta">明细行 #{{ t.receiptLineId }} · 数量 {{ t.qty }}</div>
        <div class="meta">推荐库位 #{{ t.suggestedLocationId ?? '待计算' }} · {{ t.recommendReason || '暂无推荐理由' }}</div>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { apiTaskList, errorMessage, type PutawayTask, type TaskStatus } from '@/api';

const router = useRouter();
const items = ref<PutawayTask[]>([]);
const loading = ref(false);
const err = ref('');
const status = ref('');

const filters = [
  { label: '全部', value: '' },
  { label: '待上架', value: 'CREATED' },
  { label: '已分配', value: 'ASSIGNED' },
  { label: '已完成', value: 'DONE' },
];

function statusLabel(s: TaskStatus): string {
  return { CREATED: '待上架', ASSIGNED: '已分配', DONE: '已完成', CANCELLED: '已取消' }[s] || s;
}

async function load() {
  loading.value = true;
  err.value = '';
  try {
    const res = await apiTaskList({ status: status.value || undefined, page: 1, pageSize: 100 });
    items.value = res.items || [];
  } catch (e) {
    err.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>
