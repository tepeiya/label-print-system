 <template>
  <div>
    <div class="pda-header">
      <button class="back" @click="back">‹</button>
      <div class="title">装箱出码</div>
      <button class="btn" style="min-height:36px;padding:0 12px;font-size:13px" @click="reset">重来</button>
    </div>

    <div class="pda-body">
      <!-- 步骤条：生成结果后不再显示 -->
      <div v-if="!result" class="steps">
        <div class="st" :class="{ on: step >= 1, cur: step === 1 }" @click="step > 1 && (step = 1)">1 找物料</div>
        <div class="st" :class="{ on: step >= 2, cur: step === 2 }">2 点数</div>
        <div class="st" :class="{ on: step >= 3, cur: step === 3 }">3 确认</div>
      </div>

      <!-- ============ 第一步：找物料 ============ -->
      <div v-if="!result && step === 1">
        <div class="field">
          <label>扫物料码，或手输 SKU 回车</label>
          <div style="display:flex;gap:8px">
            <input v-model="skuCode" placeholder="如 MD-VAC-5" autocomplete="off" @keyup.enter="loadSpec" />
            <button class="btn" :disabled="!skuCode || loadingSpec" style="min-width:76px" @click="loadSpec">
              {{ loadingSpec ? '…' : '查询' }}
            </button>
          </div>
        </div>
        <div v-if="err" class="notice err">{{ err }}</div>

        <div v-if="spec" class="card">
          <div class="card-t">{{ spec.skuCode }}</div>
          <div class="card-v">{{ spec.productName }}</div>
          <div class="muted" style="margin-top:6px">
            规格 {{ spec.spec || '—' }} · 单位 {{ spec.unit }}
            <template v-if="spec.unitGtin"> · 单元码 {{ spec.unitGtin }}</template>
          </div>
          <div class="muted" style="margin-top:6px">
            箱规：
            <template v-if="spec.cartons.length">
              {{ spec.cartons.map((c) => c.label).join(' / ') }}
            </template>
            <template v-else>未登记（下一步可手填每箱件数）</template>
          </div>
        </div>

        <button v-if="spec" class="btn primary wide big" style="margin-top:8px" @click="goStep2">下一步：点数</button>
      </div>

      <!-- ============ 第二步：点数 ============ -->
      <div v-if="!result && step === 2">
        <div class="muted" style="margin-bottom:10px">{{ spec?.skuCode }} · {{ spec?.productName }}</div>

        <div class="seg">
          <button :class="{ on: pointMode === 'SCAN' }" @click="pointMode = 'SCAN'">扫码点数</button>
          <button :class="{ on: pointMode === 'SOURCE' }" @click="pointMode = 'SOURCE'">选单据</button>
          <button :class="{ on: pointMode === 'MANUAL' }" @click="pointMode = 'MANUAL'">手填数量</button>
        </div>

        <!-- 扫码点数 -->
        <div v-if="pointMode === 'SCAN'">
          <div style="display:flex;gap:8px">
            <input v-model="scanCode" placeholder="扫单元码 / 箱码 GTIN" autocomplete="off"
              @keyup.enter="doScan" />
            <button class="btn" style="min-width:72px" :disabled="scanning" @click="doScan">
              {{ scanning ? '…' : '扫' }}
            </button>
          </div>
          <div v-if="scanErr" class="notice err" style="margin-top:10px">{{ scanErr }}</div>
          <div v-if="scanLog.length" class="notice ok" style="margin-top:10px">
            <div>已扫 {{ scanLog.length }} 次 · 共 <b>{{ scannedQty }}{{ spec?.unit }}</b></div>
            <div class="muted" style="margin-top:4px">最近：{{ scanLog[0]?.label }}</div>
            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn" style="min-height:40px;padding:0 14px" @click="clearScans">清空</button>
            </div>
          </div>
        </div>

        <!-- 选单据 -->
        <div v-else-if="pointMode === 'SOURCE'">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" :class="sourceMode === 'RECEIPT' ? 'primary' : ''"
              style="min-height:44px;padding:0 14px" @click="setSourceMode('RECEIPT')">收货单</button>
            <button class="btn" :class="sourceMode === 'WORK_ORDER' ? 'primary' : ''"
              style="min-height:44px;padding:0 14px" @click="setSourceMode('WORK_ORDER')">工单</button>
          </div>
          <div v-if="sourceMode !== 'FREE'" style="display:flex;gap:8px;margin-top:10px">
            <input v-model="sourceNo" autocomplete="off"
              :placeholder="sourceMode === 'RECEIPT' ? '收货单号，如 GRN-…' : '工单号，如 WO-…'"
              @keyup.enter="loadSource" />
            <button class="btn" style="min-width:72px" :disabled="loadingSource" @click="loadSource">
              {{ loadingSource ? '…' : '查' }}
            </button>
          </div>
          <div v-if="sourceErr" class="notice err" style="margin-top:10px">{{ sourceErr }}</div>
          <div v-if="sourceInfo" class="notice ok" style="margin-top:10px">
            <div>{{ sourceInfo.sourceNo }} · 应装 <b>{{ sourceInfo.sourceQty }}{{ sourceInfo.unit }}</b>
              （{{ sourceInfo.basis === 'RECEIVED' ? '按实收' : sourceInfo.basis === 'EXPECTED' ? '按应收' : '按工单需求' }}）</div>
            <div style="margin-top:4px">已装 {{ sourceInfo.packedQty }} · <b>还剩 {{ sourceInfo.remainingQty }}{{ sourceInfo.unit }}</b></div>
          </div>
          <div v-if="!sourceMode || sourceMode === 'FREE'" class="muted" style="margin-top:10px">
            选一种单据再输单号；不想挂单就切「手填数量」
          </div>
        </div>

        <!-- 手填 -->
        <div v-else>
          <input v-model.number="totalQty" type="number" min="1" step="1" placeholder="要装箱的总件数，如 27" />
        </div>

        <div class="total-bar">
          <span class="muted">本次总量</span>
          <span class="sum">{{ totalQty || 0 }}<span class="unit">{{ spec?.unit }}</span></span>
        </div>

        <div style="display:flex;gap:10px">
          <button class="btn" style="flex:0 0 96px" @click="step = 1">上一步</button>
          <button class="btn primary" style="flex:1" :disabled="!(Number(totalQty) > 0)" @click="goStep3">
            下一步：确认
          </button>
        </div>
      </div>

      <!-- ============ 第三步：确认 ============ -->
      <div v-if="!result && step === 3">
        <div class="field">
          <label>每箱件数（箱规）</label>
          <div v-if="spec?.cartons.length" style="display:flex;gap:8px;flex-wrap:wrap">
            <button v-for="c in spec.cartons" :key="c.gtin" class="btn"
              :class="packQty === c.packQty ? 'primary' : ''"
              style="min-height:44px;padding:0 14px;font-size:15px"
              @click="pickCarton(c)">{{ c.label }}</button>
          </div>
          <div v-else class="notice warn" style="margin-bottom:10px">
            该物料没有登记箱规，直接填每箱件数
          </div>
          <input v-model.number="packQty" type="number" min="1" step="1"
            placeholder="每箱件数，如 10 / 20 / 100 / 1000" style="margin-top:10px" />
        </div>

        <div class="field">
          <label>批号（可空）</label>
          <input v-model="batchNo" placeholder="如 LOT2611" autocomplete="off" />
        </div>

        <div class="field">
          <label>装完就打箱标</label>
          <button class="btn" :class="printOn ? 'success' : ''" style="min-height:44px;padding:0 18px"
            @click="printOn = !printOn">{{ printOn ? '已开启' : '已关闭' }}</button>
        </div>

        <div class="muted" style="margin-bottom:10px">
          {{ spec?.skuCode }} · 总量 {{ totalQty }}{{ spec?.unit }}
          <template v-if="sourceInfo"> · 来源 {{ sourceInfo.sourceNo }}</template>
        </div>

        <div v-if="missing" class="notice warn">{{ missing }}</div>
        <div v-if="preview" class="notice ok">{{ preview }}</div>

        <div style="display:flex;gap:10px;margin-top:10px">
          <button class="btn" style="flex:0 0 96px" @click="step = 2">上一步</button>
          <button class="btn primary" style="flex:1" :disabled="submitting" @click="submit">
            {{ submitting ? '装箱中…' : '生成箱码' }}
          </button>
        </div>
      </div>

      <!-- ============ 结果（整页替换表单） ============ -->
      <template v-if="result">
        <div class="card">
          <div class="card-t">装箱结果</div>
          <div class="card-v">{{ result.fullBoxes }} 满箱<template v-if="result.tailQty > 0"> + 1 尾箱（{{ result.tailQty }}{{ result.unit }}）</template></div>
          <div class="muted" style="margin-top:6px">
            共 {{ result.boxCount }} 箱 · 总量 {{ result.totalQty }}{{ result.unit }} · 每箱 {{ result.packQty }}{{ result.unit }}
          </div>
        </div>

        <div v-if="result.print?.warnings?.length" class="notice warn" style="margin-bottom:12px">
          <div v-for="(w, i) in result.print.warnings" :key="i">{{ w }}</div>
        </div>
        <div v-if="result.print?.errors?.length" class="notice err" style="margin-bottom:12px">
          <div v-for="(e, i) in result.print.errors" :key="i">SSCC {{ e.sscc }}：{{ e.error }}</div>
        </div>

        <button v-for="b in result.boxes" :key="b.sscc" class="list-item" @click="copySscc(b.sscc)">
          <div class="row">
            <span class="no mono">第 {{ b.boxNo }} 箱 · {{ b.qty }}{{ result.unit }}</span>
            <span v-if="b.tail" class="tag amber">尾箱</span>
            <span v-else class="tag green">满箱</span>
          </div>
          <div class="meta mono">{{ b.sscc }}</div>
          <div class="meta" v-if="b.printed">打印：{{ printLabel(b.printed.status) }}<template v-if="b.printed.message"> · {{ b.printed.message }}</template></div>
          <div class="meta" v-else>未请求打印</div>
        </button>

        <div class="muted" style="margin-top:14px;text-align:center">点箱子可复制 SSCC</div>

        <div style="display:flex;gap:10px;margin-top:16px">
          <button class="btn" style="flex:0 0 120px" @click="router.push('/')">返回首页</button>
          <button class="btn primary" style="flex:1" @click="again">再装一单</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.steps { display: flex; gap: 6px; margin-bottom: 16px; }
.steps .st {
  flex: 1; text-align: center; padding: 8px 0; border-radius: 10px;
  background: var(--bg-card); border: 1px solid var(--line);
  color: var(--text-dim); font-size: 13px;
}
.steps .st.on { color: var(--text); border-color: var(--brand); }
.steps .st.cur { background: var(--brand-strong); border-color: var(--brand); color: #fff; font-weight: 700; }
.seg { display: flex; gap: 6px; margin-bottom: 14px; }
.seg button {
  flex: 1; min-height: 44px; border-radius: 10px; background: var(--bg-card);
  border: 1px solid var(--line); color: var(--text-dim); font-size: 14px;
}
.seg button.on { background: var(--bg-elev); border-color: var(--brand); color: var(--text); font-weight: 700; }
.total-bar {
  display: flex; align-items: baseline; justify-content: space-between;
  margin: 16px 0; padding: 14px 16px; border-radius: 12px;
  background: var(--bg-card); border: 1px solid var(--line);
}
.total-bar .sum { font-size: 30px; font-weight: 800; }
.total-bar .unit { font-size: 14px; color: var(--text-dim); margin-left: 4px; font-weight: 500; }
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  apiCartonPack, apiCartonScan, apiCartonSource, apiCartonSpec, errorMessage,
  type CartonPackOption, type CartonPackResult, type CartonSourceInfo, type CartonSpec,
} from '@/api';

const router = useRouter();

const step = ref<1 | 2 | 3>(1);
const pointMode = ref<'SCAN' | 'SOURCE' | 'MANUAL'>('SCAN');
const skuCode = ref('');
const spec = ref<CartonSpec | null>(null);
const packQty = ref<number | null>(null);
const totalQty = ref<number | null>(null);
const batchNo = ref('');
const printOn = ref(true);

const loadingSpec = ref(false);
const submitting = ref(false);
const err = ref('');
const result = ref<CartonPackResult | null>(null);

function back() {
  if (result.value) { reset(); return; }
  if (step.value > 1) { step.value = (step.value - 1) as 1 | 2 | 3; return; }
  router.push('/');
}
function goStep2() {
  step.value = 2;
  if (pointMode.value === 'SOURCE' && sourceInfo.value) sourceInfo.value = null;
}
function goStep3() {
  // 只有一档箱规时自动选中，省一步
  if (!(Number(packQty.value) > 0) && spec.value?.cartons.length === 1) pickCarton(spec.value.cartons[0]);
  step.value = 3;
}
function again() {
  result.value = null;
  totalQty.value = null;
  scannedQty.value = 0;
  scanLog.value = [];
  scanErr.value = '';
  sourceInfo.value = null;
  sourceErr.value = '';
  step.value = 2;
}

const missing = computed(() => {
  if (!spec.value) return '';
  const lacks: string[] = [];
  if (!(Number(packQty.value) > 0)) lacks.push('每箱件数（箱规）');
  if (!(Number(totalQty.value) > 0)) lacks.push('总件数');
  return lacks.length ? `还差：${lacks.join('、')}` : '';
});

// 装箱来源（B 阶段：收货单 / 工单 / 自由装箱）
const sourceMode = ref<'FREE' | 'RECEIPT' | 'WORK_ORDER'>('FREE');
const sourceNo = ref('');
const sourceInfo = ref<CartonSourceInfo | null>(null);
const sourceErr = ref('');
const loadingSource = ref(false);

function setSourceMode(m: 'FREE' | 'RECEIPT' | 'WORK_ORDER') {
  sourceMode.value = m;
  sourceInfo.value = null;
  sourceErr.value = '';
  if (m === 'FREE') sourceNo.value = '';
}

async function loadSource() {
  const no = sourceNo.value.trim();
  if (sourceMode.value === 'FREE') return;
  if (!no) { sourceErr.value = '先填单号'; return; }
  if (!spec.value) { sourceErr.value = '先查物料再查单据'; return; }
  sourceErr.value = '';
  loadingSource.value = true;
  try {
    const info = await apiCartonSource(sourceMode.value, no, spec.value.skuCode);
    sourceInfo.value = info;
    // 单一批号时顺手带出批号，省一次手填
    if (!batchNo.value.trim() && info.batchNo) batchNo.value = info.batchNo;
    if (info.remainingQty <= 0) sourceErr.value = `这张单已经装完了（应装 ${info.sourceQty}，已装 ${info.packedQty}）`;
  } catch (e) {
    sourceInfo.value = null;
    sourceErr.value = errorMessage(e);
  } finally {
    loadingSource.value = false;
  }
}

function useRemaining() {
  if (sourceInfo.value && sourceInfo.value.remainingQty > 0) {
    totalQty.value = sourceInfo.value.remainingQty;
  }
}

// 扫码点数（A 阶段：只在本机累加，不涉及单据）
const scanCode = ref('');
const scanning = ref(false);
const scanErr = ref('');
const scannedQty = ref(0);
const scanLog = ref<Array<{ label: string; units: number }>>([]);
const lastScanLabel = computed(() => scanLog.value[0]?.label ?? '');

async function doScan() {
  const code = scanCode.value.trim();
  if (!code) return;
  if (!spec.value) { scanErr.value = '先扫/查物料，再扫码点数'; return; }
  scanErr.value = '';
  scanning.value = true;
  try {
    const r = await apiCartonScan(code, spec.value.skuCode);
    if (r.alreadyPacked) {
      scanErr.value = r.message || `这箱已经装过了（${r.sscc}）`;
    } else {
      scannedQty.value += Number(r.units) || 0;
      scanLog.value.unshift({ label: `${r.packLevel} ${r.units}${r.unit ?? ''}`, units: Number(r.units) || 0 });
      if (navigator.vibrate) navigator.vibrate(30);
    }
  } catch (e) {
    scanErr.value = errorMessage(e);
  } finally {
    scanning.value = false;
    scanCode.value = '';
  }
}

function useScanned() { if (scannedQty.value > 0) totalQty.value = scannedQty.value; }
function clearScans() { scannedQty.value = 0; scanLog.value = []; scanErr.value = ''; }

const preview = computed(() => {
  const t = Number(totalQty.value);
  const p = Number(packQty.value);
  if (!(t > 0) || !(p > 0)) return '';
  const full = Math.floor(t / p);
  const tail = Number((t - full * p).toFixed(3));
  if (tail > 0) return `将生成 ${full} 个满箱 + 1 个尾箱（${tail}${spec.value?.unit ?? ''}），共 ${full + 1} 箱`;
  return `将生成 ${full} 个满箱，无尾箱`;
});

async function loadSpec() {
  const code = skuCode.value.trim();
  if (!code) return;
  err.value = '';
  result.value = null;
  spec.value = null;
  loadingSpec.value = true;
  try {
    const s = await apiCartonSpec(code);
    spec.value = s;
    sourceInfo.value = null;
    sourceErr.value = '';
    // 只有一档箱规时自动选中，减少一步
    if (s.cartons.length === 1) pickCarton(s.cartons[0]);
  } catch (e) {
    err.value = errorMessage(e);
  } finally {
    loadingSpec.value = false;
  }
}

function pickCarton(c: CartonPackOption) {
  packQty.value = c.packQty;
}

async function submit() {
  if (!(Number(packQty.value) > 0)) { err.value = '请先选一个箱规，或直接在「每箱件数」里填数字'; return; }
  if (!(Number(totalQty.value) > 0)) { err.value = '请填要装箱的总件数'; return; }
  err.value = '';
  submitting.value = true;
  try {
    result.value = await apiCartonPack({
      skuCode: spec.value?.skuCode ?? skuCode.value.trim(),
      totalQty: Number(totalQty.value),
      packQty: Number(packQty.value),
      batchNo: batchNo.value.trim() || undefined,
      sourceType: sourceMode.value === 'FREE' ? undefined : sourceMode.value,
      sourceNo: sourceMode.value === 'FREE' ? undefined : sourceNo.value.trim() || undefined,
      print: printOn.value,
    });
    if (navigator.vibrate) navigator.vibrate(60);
  } catch (e) {
    err.value = errorMessage(e);
  } finally {
    submitting.value = false;
  }
}

function reset() {
  step.value = 1;
  pointMode.value = 'SCAN';
  skuCode.value = '';
  spec.value = null;
  packQty.value = null;
  totalQty.value = null;
  batchNo.value = '';
  sourceMode.value = 'FREE';
  sourceNo.value = '';
  sourceInfo.value = null;
  sourceErr.value = '';
  scanCode.value = '';
  scannedQty.value = 0;
  scanLog.value = [];
  scanErr.value = '';
  printOn.value = true;
  result.value = null;
  err.value = '';
}

function printLabel(s?: string) {
  return ({
    queued: '已入队', printing: '打印中', success: '已打印', failed: '打印失败',
    skipped_no_printer: '未配打印机', canceled: '已取消', partial: '部分成功',
  } as Record<string, string>)[String(s)] || String(s ?? '—');
}

async function copySscc(sscc: string) {
  try {
    await navigator.clipboard.writeText(sscc);
    if (navigator.vibrate) navigator.vibrate(30);
  } catch {
    /* 忽略：部分 WebView 无剪贴板权限 */
  }
}
</script>
