<template>
  <div>
    <div class="pda-header">
      <button class="back" @click="router.push('/')">‹</button>
      <div class="title">发料工单</div>
      <button class="btn" style="min-height:36px;padding:0 12px;font-size:13px" @click="load">刷新</button>
    </div>

    <div class="pda-body">
      <div v-if="err" class="notice err">{{ err }}</div>

      <div style="display:flex;gap:8px;margin-bottom:12px;overflow-x:auto">
        <button
          v-for="t in tabs" :key="t.value"
          class="btn" :class="{ primary: status === t.value }"
          style="min-height:36px;padding:0 12px;font-size:13px;white-space:nowrap"
          @click="status = t.value; load()"
        >{{ t.label }}</button>
      </div>

      <div class="field">
        <input v-model.trim="keyword" placeholder="工单号 / 来源单号搜索" @keyup.enter="load" />
      </div>

      <div v-if="loading" class="muted" style="padding:20px 0;text-align:center">加载中…</div>
      <div v-else-if="!items.length" class="card">
        <div class="muted">没有工单。发料前需先在 console 建工单并齐套放行。</div>
      </div>

      <div v-for="w in items" :key="w.id" class="card wo-card" @click="router.push(`/issuing/${w.id}`)">
        <div class="row">
          <span class="mono" style="font-size:17px;font-weight:700">{{ w.woNo }}</span>
          <span class="tag" :class="w.status">{{ woStatusLabel(w.status) }}</span>
        </div>
        <div class="muted" style="margin-top:6px">
          需求 {{ w.demandQty }} · 仓库 #{{ w.warehouseId }}
          <span v-if="w.sourceNo"> · 来源 {{ w.sourceNo }}</span>
        </div>
        <div v-if="w.shortageFlag" class="tag SHORT" style="margin-top:8px;display:inline-block">缺料</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { apiWoList, errorMessage, woStatusLabel, type WorkOrderItem } from '@/api';

const router = useRouter();
const items = ref<WorkOrderItem[]>([]);
const loading = ref(false);
const err = ref('');
const status = ref('');
const keyword = ref('');

const tabs = [
  { label: '待处理', value: 'RELEASED' },
  { label: '发料中', value: 'ISSUING' },
  { label: '已发完', value: 'ISSUED' },
  { label: '全部', value: '' },
];

async function load() {
  loading.value = true;
  err.value = '';
  try {
    const res = await apiWoList({ status: status.value || undefined, keyword: keyword.value || undefined, pageSize: 50 });
    items.value = res.items ?? [];
  } catch (e) {
    err.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.wo-card { cursor: pointer; }
</style>
