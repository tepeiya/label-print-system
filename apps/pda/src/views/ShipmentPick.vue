<template>
  <div>
    <div class="pda-header">
      <button class="back" @click="router.push('/shipments')">‹</button>
      <div class="title">{{ doc?.shipmentNo || '发货单' }}</div>
      <button class="btn" style="min-height:36px;padding:0 12px;font-size:13px" @click="load">刷新</button>
    </div>

    <div class="pda-body">
      <div v-if="err" class="notice err">{{ err }}</div>
      <div v-if="msg" class="notice">{{ msg }}</div>

      <div v-if="loading" class="muted" style="padding:20px 0;text-align:center">加载中…</div>

      <template v-else-if="doc">
        <div class="card">
          <div class="row">
            <span class="mono" style="font-size:17px;font-weight:700">{{ doc.shipmentNo }}</span>
            <span class="tag" :class="tagCls(doc.status)">{{ doc.statusText }}</span>
          </div>
          <div class="muted" style="margin-top:6px">
            {{ doc.customerName || '内部调拨' }} · {{ doc.shipTypeText }}
            <span v-if="doc.warehouse"> · {{ doc.warehouse.code }} {{ doc.warehouse.name }}</span>
          </div>
          <div class="muted" style="margin-top:4px">
            计划 {{ totalPlan }} · 已拣 {{ totalPicked }} · 已发 {{ totalShipped }}
            <span v-if="doc.trackingNo"> · 运单 {{ doc.trackingNo }}</span>
          </div>
        </div>

        <div v-if="canWork" class="field" style="margin-top:12px">
          <input v-model.trim="scan" placeholder="扫物料码 / 批次码定位行" @keyup.enter="onScan" />
        </div>

        <div v-for="l in doc.lines" :key="l.id" class="card line-card"
             :class="{ hl: matchedLineId === l.id }">
          <div class="row">
            <span class="mono" style="font-weight:700">{{ l.lineNo }}. {{ l.skuCode }}</span>
            <span class="tag" :class="lineTagCls(l.status)">{{ l.statusText }}</span>
          </div>
          <div class="muted" style="margin-top:4px">{{ l.materialName }}</div>
          <div class="muted" style="margin-top:4px">
            计划 {{ l.qtyPlan }} {{ l.unit }} · 已拣 {{ l.qtyPicked }} · 已发 {{ l.qtyShipped }}
          </div>
          <div class="muted" style="margin-top:4px">
            批次 {{ l.batchNo || 'FIFO' }} · 库位 {{ l.locationText || '不限' }}
            <span v-if="l.packSscc"> · SSCC {{ l.packSscc }}</span>
            <span v-if="l.udiCodes?.length"> · {{ l.udiCodes.length }} 个 UDI 码</span>
          </div>
          <div v-if="l.error" class="notice err" style="margin-top:8px">{{ l.error }}</div>

          <div v-if="canPick(l)" class="pick-row">
            <input v-model.number="pickQty[l.id]" type="number" inputmode="decimal" min="0.001" step="0.001"
                   placeholder="数量" />
            <button class="btn primary" style="min-height:40px;padding:0 16px" :disabled="busy"
                    @click="doPick(l)">拣货</button>
          </div>
        </div>

        <div v-if="canWork" style="display:flex;gap:10px;margin-top:16px">
          <button class="btn" style="flex:1;min-height:48px" :disabled="busy" @click="pickAll">按计划全拣</button>
          <button class="btn primary" style="flex:1.2;min-height:48px" :disabled="busy" @click="doPost">出库过账</button>
        </div>
        <div v-if="doc.status === 'SHIPPED'" style="margin-top:16px">
          <button class="btn primary" style="width:100%;min-height:48px" :disabled="busy" @click="doSign">客户签收</button>
        </div>
        <div v-if="doc.status === 'SIGNED'" class="notice" style="margin-top:16px">
          已签收：{{ doc.signedReceiver || '客户签收' }}
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  apiShipmentDetail, apiShipmentPick, apiShipmentPost, apiShipmentSign, errorMessage,
  type ShipmentDetail, type ShipmentLineItem,
} from '@/api';

const route = useRoute();
const router = useRouter();
const doc = ref<ShipmentDetail | null>(null);
const loading = ref(false);
const busy = ref(false);
const err = ref('');
const msg = ref('');
const scan = ref('');
const matchedLineId = ref<number | null>(null);
const pickQty = reactive<Record<number, number>>({});

const id = computed(() => Number(route.params.id));
const canWork = computed(() => !!doc.value && ['CREATED', 'PICKING', 'PICKED'].includes(doc.value.status));
const totalPlan = computed(() => (doc.value?.lines ?? []).reduce((s, l) => s + l.qtyPlan, 0));
const totalPicked = computed(() => (doc.value?.lines ?? []).reduce((s, l) => s + l.qtyPicked, 0));
const totalShipped = computed(() => (doc.value?.lines ?? []).reduce((s, l) => s + l.qtyShipped, 0));

const tagCls = (s: string) => ({
  CREATED: 'CREATED', PICKING: 'RECEIVING', PICKED: 'SHORT', SHIPPED: 'RECEIVED', SIGNED: 'RECEIVED', CANCELLED: 'CANCELLED',
}[s] ?? 'CREATED');
const lineTagCls = (s: string) => ({
  PENDING: 'CREATED', PICKED: 'RECEIVING', SHIPPED: 'RECEIVED', SHORT: 'SHORT', FAILED: 'OVER',
}[s] ?? 'CREATED');
const canPick = (l: ShipmentLineItem) => canWork.value && !['SHIPPED', 'SHORT'].includes(l.status);

function fillQty() {
  for (const l of doc.value?.lines ?? []) {
    if (pickQty[l.id] === undefined || pickQty[l.id] === 0) pickQty[l.id] = l.qtyPicked || l.qtyPlan;
  }
}

async function load() {
  loading.value = true;
  err.value = '';
  try {
    doc.value = await apiShipmentDetail(id.value);
    fillQty();
  } catch (e) {
    err.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

function onScan() {
  const code = scan.value.trim();
  if (!code) return;
  const hit = (doc.value?.lines ?? []).find(
    (l) => code.includes(l.skuCode) || (l.batchNo && code.includes(l.batchNo)),
  );
  if (hit) {
    matchedLineId.value = hit.id;
    msg.value = `已定位第 ${hit.lineNo} 行 ${hit.skuCode}`;
  } else {
    matchedLineId.value = null;
    err.value = `码 ${code} 未匹配本单任何行（可核对物料/批次，或手工选行）`;
  }
  scan.value = '';
}

async function doPick(l: ShipmentLineItem) {
  const qty = Number(pickQty[l.id]);
  if (!Number.isFinite(qty) || qty <= 0) { err.value = '拣货数量必须为正数'; return; }
  if (qty > l.qtyPlan) { err.value = `拣货数量超过计划量 ${l.qtyPlan}`; return; }
  busy.value = true; err.value = ''; msg.value = '';
  try {
    doc.value = await apiShipmentPick(id.value, l.id, { qty, batchNo: l.batchNo ?? undefined });
    msg.value = `第 ${l.lineNo} 行已拣 ${qty}`;
    fillQty();
  } catch (e) { err.value = errorMessage(e); }
  finally { busy.value = false; }
}

async function pickAll() {
  if (!doc.value) return;
  busy.value = true; err.value = ''; msg.value = '';
  try {
    for (const l of doc.value.lines) {
      if (['SHIPPED', 'SHORT'].includes(l.status)) continue;
      const qty = Number(pickQty[l.id] || l.qtyPlan);
      doc.value = await apiShipmentPick(id.value, l.id, { qty, batchNo: l.batchNo ?? undefined });
    }
    msg.value = '已按计划完成拣货，可以出库过账';
  } catch (e) { err.value = errorMessage(e); }
  finally { busy.value = false; await load(); }
}

async function doPost() {
  const pending = (doc.value?.lines ?? []).filter((l) => !['SHIPPED', 'SHORT'].includes(l.status)).length;
  const tip = pending
    ? `还有 ${pending} 行未拣货，将按计划量直接出库（FIFO 扣减）。确认出库？`
    : '确认出库过账？库存立即扣减，单据不能再作废。';
  if (!window.confirm(tip)) return;
  busy.value = true; err.value = ''; msg.value = '';
  try {
    const res = await apiShipmentPost(id.value);
    const failed = (res?.results ?? []).filter((r: any) => r.status === 'FAILED');
    if (failed.length) err.value = `第 ${failed.map((f: any) => f.lineNo).join('、')} 行失败：${failed[0]?.message || ''}`;
    else msg.value = `出库完成，合计 ${res?.shippedQty ?? 0}`;
    await load();
  } catch (e) { err.value = errorMessage(e); }
  finally { busy.value = false; }
}

async function doSign() {
  const receiver = window.prompt('客户签收人姓名（留空记「客户签收」）', '');
  if (receiver === null) return;
  busy.value = true; err.value = ''; msg.value = '';
  try {
    doc.value = await apiShipmentSign(id.value, receiver || undefined);
    msg.value = '已签收';
  } catch (e) { err.value = errorMessage(e); }
  finally { busy.value = false; }
}

watch(() => route.params.id, () => { if (route.name === 'shipment-pick') load(); });
onMounted(load);
</script>

<style scoped>
.line-card { margin-top: 10px; }
.line-card.hl { border-color: #60a5fa; box-shadow: 0 0 0 1px #60a5fa inset; }
.pick-row { display: flex; gap: 8px; margin-top: 10px; }
.pick-row input { flex: 1; min-height: 40px; }
</style>
