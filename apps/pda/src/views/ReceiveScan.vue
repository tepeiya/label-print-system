<template>
  <div>
    <div class="pda-header">
      <button class="back" @click="router.push('/receipts')">‹</button>
      <div class="title">扫码收货</div>
      <button class="btn" style="min-height:36px;padding:0 12px;font-size:13px" @click="loadDetail">刷新</button>
    </div>

    <div class="pda-body">
      <div v-if="err" class="notice err">{{ err }}</div>

      <!-- 收货单信息 -->
      <div class="card" v-if="receipt">
        <div class="row">
          <span class="no mono" style="font-size:18px;font-weight:700">{{ receipt.receiptNo }}</span>
          <span class="tag" :class="receipt.status">{{ statusLabel(receipt.status) }}</span>
        </div>
        <div class="muted" style="margin-top:6px">仓库 #{{ receipt.warehouseId }} · {{ receipt.lines?.length || 0 }} 行明细</div>
      </div>

      <!-- 扫码视口 -->
      <div class="scanner-wrap" v-show="scannerOn">
        <video ref="videoBind" playsinline muted></video>
        <div class="scanner-frame"></div>
        <div class="scanner-tip">{{ scanner.error || '将条码对准框内，自动识别' }}</div>
      </div>
      <div v-if="!scannerOn" class="notice warn" style="margin-top:10px">
        摄像头未开启 · 可手动输入 SKU 收货
      </div>

      <div style="display:flex;gap:10px;margin:14px 0">
        <button class="btn" style="flex:1" @click="toggleScanner">{{ scannerOn ? '关闭摄像头' : '开启摄像头扫码' }}</button>
        <button class="btn" style="flex:1" @click="toggleManual">{{ showManual ? '收起手输' : '手动输入' }}</button>
      </div>

      <!-- 收货表单 -->
      <div class="card" v-if="showManual || lastScan">
        <div class="field">
          <label>SKU（盲收可直接扫码填入）</label>
          <input v-model.trim="form.sku" placeholder="扫码或输入 SKU" ref="skuInput" />
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label>数量 *</label>
            <input v-model.number="form.qty" type="number" min="0.001" step="0.001" />
          </div>
          <div class="field" style="flex:1">
            <label>批次</label>
            <input v-model.trim="form.batchNo" placeholder="可选" />
          </div>
        </div>
        <div class="field">
          <label>按单收行（可选，按单收货时指定行号）</label>
          <select v-model.number="form.lineNo">
            <option :value="undefined">不指定（盲收）</option>
            <option v-for="l in receipt?.lines || []" :key="l.id" :value="l.lineNo">
              行{{ l.lineNo }} · {{ l.skuId }} · 应收{{ l.qtyExpected }}
            </option>
          </select>
        </div>
        <div class="notice" :class="lastResultClass" v-if="lastMessage">{{ lastMessage }}</div>
        <button class="btn primary wide big" :disabled="submitting || !form.qty || form.qty <= 0" @click="submitScan">
          {{ submitting ? '提交中…' : '确认收货' }}
        </button>
      </div>

      <!-- 明细行 -->
      <div class="card" v-if="receipt?.lines?.length">
        <div class="card-t">收货明细（{{ receipt.lines.length }} 行）</div>
        <div v-for="l in receipt.lines" :key="l.id" class="detail-line">
          <div class="row">
            <span class="mono" style="font-weight:600">{{ l.skuId }}</span>
            <span class="tag" :class="l.status">{{ l.status }}</span>
          </div>
          <div class="muted">
            批次 {{ l.batchNo || '—' }} · 应收 {{ l.qtyExpected }} / 已收 {{ l.qtyReceived }}
            <span v-if="l.diffType"> · <span class="tag" :class="l.diffType">{{ l.diffType }}</span> {{ l.diffQty }}</span>
          </div>
          <button class="btn" style="min-height:34px;padding:0 10px;font-size:12px;margin-top:6px" @click="reprint(l.id)">补打标签</button>
        </div>
      </div>
    </div>

    <div class="bottom-bar" v-if="receipt">
      <button class="btn" @click="router.push('/putaway')">上架任务</button>
      <button class="btn success" :disabled="posting || !canPost" @click="postReceipt">
        {{ posting ? '过账中…' : '收货过账' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  apiReceiptDetail, apiReceiveScan, apiPostReceipt, apiReprintLabel,
  errorMessage, type Receipt,
} from '@/api';
import { useScanner } from '@/composables/scanner';
import { beep, vibrate } from '@/composables/beep';

const route = useRoute();
const router = useRouter();
const receiptId = Number(route.params.id);

const receipt = ref<Receipt | null>(null);
const err = ref('');
const submitting = ref(false);
const posting = ref(false);
const showManual = ref(true);

const form = reactive({ sku: '', qty: 1 as number, batchNo: '', lineNo: undefined as number | undefined });

const lastMessage = ref('');
const lastOk = ref(true);
const lastScan = ref(false);
const lastResultClass = computed(() => lastOk.value ? 'ok' : 'warn');

const canPost = computed(() => {
  const lines = receipt.value?.lines || [];
  return lines.length > 0 && lines.every((l) => l.qtyReceived > 0);
});

function statusLabel(s: string): string {
  return { CREATED: '待收', RECEIVING: '收货中', RECEIVED: '已收', PUTAWAY_DONE: '已上架', CANCELLED: '已取消' }[s] || s;
}

async function loadDetail() {
  err.value = '';
  try {
    receipt.value = await apiReceiptDetail(receiptId);
  } catch (e) {
    err.value = errorMessage(e);
  }
}

// --- 扫码：识别到条码时填入 SKU，若格式像「SKU|数量|批次」则一并解析 ---
function onDetect(text: string) {
  lastScan.value = true;
  showManual.value = true;
  const parts = text.split('|').map((s) => s.trim()).filter(Boolean);
  form.sku = parts[0] || text;
  if (parts[1] && !isNaN(Number(parts[1]))) form.qty = Number(parts[1]);
  if (parts[2]) form.batchNo = parts[2];
  beep('ok');
  vibrate(30);
  lastOk.value = true;
  lastMessage.value = `已识别：${form.sku}${parts[1] ? ` × ${form.qty}` : ''}，请核对后确认`;
  scanner.pause();
}

const scanner = useScanner(onDetect);
const videoBind = ref<HTMLVideoElement | null>(null);
const scannerOn = ref(false);

function toggleScanner() {
  if (scannerOn.value) {
    scanner.stop();
    scannerOn.value = false;
  } else {
    scannerOn.value = true;
    // nextTick 后 video 元素才挂载（v-show 已挂载，直接 nextTick 绑定）
    requestAnimationFrame(() => {
      scanner.videoEl.value = videoBind.value;
      void scanner.start().then(() => {
        if (scanner.error.value) {
          lastOk.value = false;
          lastMessage.value = scanner.error.value;
        }
      });
    });
  }
}

function toggleManual() {
  showManual.value = !showManual.value;
}

async function submitScan() {
  if (!form.sku && form.lineNo === undefined) {
    lastOk.value = false;
    lastMessage.value = '请扫码或输入 SKU（或指定行号）';
    return;
  }
  submitting.value = true;
  lastMessage.value = '';
  try {
    const body: any = { qty: Number(form.qty) };
    if (form.sku) body.sku = form.sku;
    if (form.batchNo) body.batchNo = form.batchNo;
    if (form.lineNo !== undefined) body.lineNo = form.lineNo;
    const res = await apiReceiveScan(receiptId, body);
    beep(res.warning ? 'fail' : 'ok');
    vibrate(res.warning ? [60, 40, 60] : 40);
    lastOk.value = !res.warning;
    lastMessage.value = res.warning
      ? `${res.warning}（已记录，请核对明细）`
      : `收货成功：${res.line?.skuId || form.sku} 累计 ${res.line?.qtyReceived ?? ''}`;
    await loadDetail();
    form.qty = 1;
    scanner.resume();
  } catch (e) {
    beep('fail');
    vibrate([80, 50, 80]);
    lastOk.value = false;
    lastMessage.value = errorMessage(e);
  } finally {
    submitting.value = false;
  }
}

async function postReceipt() {
  posting.value = true;
  try {
    await apiPostReceipt(receiptId);
    await loadDetail();
    lastOk.value = true;
    lastMessage.value = '过账成功，已生成上架任务';
    beep('ok');
  } catch (e) {
    lastOk.value = false;
    lastMessage.value = errorMessage(e);
    beep('fail');
  } finally {
    posting.value = false;
  }
}

async function reprint(lineId: number) {
  try {
    await apiReprintLabel(lineId);
    lastOk.value = true;
    lastMessage.value = '已提交补打标签任务';
    beep('ok');
  } catch (e) {
    lastOk.value = false;
    lastMessage.value = errorMessage(e);
    beep('fail');
  }
}

onMounted(loadDetail);
</script>

<style scoped>
.detail-line { padding: 10px 0; border-bottom: 1px solid var(--line); }
.detail-line:last-child { border-bottom: none; }
</style>
