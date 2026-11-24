<template>
  <div>
    <div class="pda-header">
      <button class="back" @click="router.push('/')">‹</button>
      <div class="title">成品发运</div>
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
        <input v-model.trim="keyword" placeholder="发货单号 / 客户 / 运单号" @keyup.enter="load" />
      </div>

      <div v-if="loading" class="muted" style="padding:20px 0;text-align:center">加载中…</div>
      <div v-else-if="!items.length" class="card">
        <div class="muted">没有发货单。发货前需先在 console 建单（选客户 + 明细）。</div>
      </div>

      <div v-for="s in items" :key="s.id" class="card ship-card" @click="router.push(`/shipments/${s.id}`)">
        <div class="row">
          <span class="mono" style="font-size:17px;font-weight:700">{{ s.shipmentNo }}</span>
          <span class="tag" :class="s.status">{{ shipStatusLabel(s.status) }}</span>
        </div>
        <div class="muted" style="margin-top:6px">
          {{ s.customerName || '内部' }} · {{ s.shipTypeText }} · {{ s.warehouse }}
        </div>
        <div class="muted" style="margin-top:4px">
          行 拣{{ s.pickedLines }}/发{{ s.shippedLines }}/共{{ s.lineCount }} · 计划 {{ s.qtyPlan }}
          <span v-if="s.trackingNo"> · {{ s.trackingNo }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { apiShipmentList, errorMessage, shipStatusLabel, type ShipmentListItem } from '@/api';

const router = useRouter();
const items = ref<ShipmentListItem[]>([]);
const loading = ref(false);
const err = ref('');
const status = ref('CREATED');
const keyword = ref('');

const tabs = [
  { label: '待拣货', value: 'CREATED' },
  { label: '拣货中', value: 'PICKING' },
  { label: '已拣完', value: 'PICKED' },
  { label: '已出库', value: 'SHIPPED' },
  { label: '全部', value: '' },
];

async function load() {
  loading.value = true;
  err.value = '';
  try {
    const res = await apiShipmentList({ status: status.value || undefined, keyword: keyword.value || undefined, pageSize: 50 });
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
.ship-card { cursor: pointer; }
</style>
