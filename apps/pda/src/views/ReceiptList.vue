<template>
  <div>
    <div class="pda-header">
      <button class="back" @click="router.push('/')">‹</button>
      <div class="title">收货单</div>
      <button class="btn" style="min-height:36px;padding:0 12px;font-size:13px" @click="showCreate = true">+ 建单</button>
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
        <div class="icon">📭</div>
        <div>暂无收货单</div>
        <button class="btn primary" style="margin-top:16px" @click="showCreate = true">新建收货单</button>
      </div>
      <button v-for="r in items" :key="r.id" class="list-item" @click="router.push(`/receipts/${r.id}/scan`)">
        <div class="row">
          <span class="no mono">{{ r.receiptNo }}</span>
          <span class="tag" :class="r.status">{{ statusLabel(r.status) }}</span>
        </div>
        <div class="meta">仓库 #{{ r.warehouseId }} · 来源 {{ r.sourceType === 'MANUAL' ? '手工' : '导入' }}</div>
        <div class="meta">{{ r.createdAt?.slice(0, 16)?.replace('T', ' ') || '' }}</div>
      </button>
    </div>

    <!-- 建单弹层 -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-h">
          <span>新建收货单</span>
          <button style="font-size:24px;line-height:1" @click="showCreate = false">×</button>
        </div>
        <div class="modal-b">
          <div class="field">
            <label>收货单号 *</label>
            <input v-model.trim="form.receiptNo" placeholder="如 GRN-2026-001" />
          </div>
          <div class="field">
            <label>仓库 ID *</label>
            <input v-model.number="form.warehouseId" type="number" min="1" placeholder="仓库 ID" />
          </div>
          <div class="field">
            <label>备注</label>
            <input v-model.trim="form.remark" placeholder="可选" />
          </div>
          <div class="line-h">
            <span>明细行</span>
            <button class="btn" style="min-height:34px;padding:0 10px;font-size:13px" @click="addLine">+ 加行</button>
          </div>
          <div v-for="(line, i) in form.lines" :key="i" class="line-edit">
            <div class="field" style="flex:2;margin-bottom:8px">
              <input v-model.trim="line.sku" placeholder="SKU" />
            </div>
            <div class="field" style="flex:1;margin-bottom:8px">
              <input v-model.trim="line.batchNo" placeholder="批次" />
            </div>
            <div class="field" style="flex:1;margin-bottom:8px">
              <input v-model.number="line.qtyExpected" type="number" min="0" placeholder="数量" />
            </div>
            <button class="btn danger" style="min-height:48px;padding:0 10px" @click="form.lines.splice(i, 1)">×</button>
          </div>
          <div v-if="createErr" class="notice err">{{ createErr }}</div>
        </div>
        <div class="modal-f">
          <button class="btn" @click="showCreate = false">取消</button>
          <button class="btn primary" :disabled="creating" @click="submitCreate">{{ creating ? '创建中…' : '创建' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { apiReceiptList, apiCreateReceipt, errorMessage, type Receipt, type ReceiptStatus } from '@/api';

const router = useRouter();
const items = ref<Receipt[]>([]);
const loading = ref(false);
const err = ref('');
const status = ref('');

const filters = [
  { label: '全部', value: '' },
  { label: '待收', value: 'CREATED' },
  { label: '收货中', value: 'RECEIVING' },
  { label: '已收', value: 'RECEIVED' },
  { label: '已上架', value: 'PUTAWAY_DONE' },
];

function statusLabel(s: ReceiptStatus): string {
  return { CREATED: '待收', RECEIVING: '收货中', RECEIVED: '已收', PUTAWAY_DONE: '已上架', CANCELLED: '已取消' }[s] || s;
}

async function load() {
  loading.value = true;
  err.value = '';
  try {
    const res = await apiReceiptList({ status: status.value || undefined, page: 1, pageSize: 100 });
    items.value = res.items || [];
  } catch (e) {
    err.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

const showCreate = ref(false);
const creating = ref(false);
const createErr = ref('');
const form = reactive({
  receiptNo: '',
  warehouseId: 1 as number,
  remark: '',
  lines: [{ sku: '', batchNo: '', qtyExpected: 0 as number }],
});

function addLine() {
  form.lines.push({ sku: '', batchNo: '', qtyExpected: 0 });
}

async function submitCreate() {
  createErr.value = '';
  const cleanLines = form.lines.filter((l) => l.sku && l.qtyExpected > 0);
  if (!form.receiptNo) { createErr.value = '请填写收货单号'; return; }
  if (!form.warehouseId || form.warehouseId < 1) { createErr.value = '请填写有效仓库 ID'; return; }
  if (!cleanLines.length) { createErr.value = '请至少填写一条有效明细（SKU + 数量 > 0）'; return; }
  creating.value = true;
  try {
    const r = await apiCreateReceipt({
      receiptNo: form.receiptNo,
      sourceType: 'MANUAL',
      warehouseId: form.warehouseId,
      remark: form.remark || undefined,
      lines: cleanLines.map((l) => ({ sku: l.sku, batchNo: l.batchNo || undefined, qtyExpected: l.qtyExpected })),
    });
    showCreate.value = false;
    await load();
    router.push(`/receipts/${r.id}/scan`);
  } catch (e) {
    createErr.value = errorMessage(e);
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.modal-mask { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.6); display: flex; align-items: flex-end; }
.modal { width: 100%; max-width: 640px; margin: 0 auto; background: var(--bg-card); border-radius: 18px 18px 0 0; border: 1px solid var(--line); max-height: 88vh; display: flex; flex-direction: column; }
.modal-h { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid var(--line); font-size: 17px; font-weight: 700; }
.modal-b { padding: 16px; overflow-y: auto; }
.modal-f { display: flex; gap: 10px; padding: 12px 16px calc(12px + var(--safe-bottom)); border-top: 1px solid var(--line); }
.modal-f .btn { flex: 1; }
.line-h { display: flex; align-items: center; justify-content: space-between; font-size: 14px; color: var(--text-dim); margin: 8px 0; }
.line-edit { display: flex; align-items: flex-start; gap: 6px; }
</style>
