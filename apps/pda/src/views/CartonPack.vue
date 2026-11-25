 <template>
  <div>
    <div class="pda-header">
      <button class="back" @click="router.push('/')">‹</button>
      <div class="title">装箱出码</div>
      <button class="btn" style="min-height:36px;padding:0 12px;font-size:13px" @click="reset">重来</button>
    </div>

    <div class="pda-body">
      <!-- 1) 物料 -->
      <div class="field">
        <label>物料编码（扫 SKU 码或手输，回车查询）</label>
        <div style="display:flex;gap:8px">
          <input v-model="skuCode" placeholder="如 M-PEAR-001" autocomplete="off"
            @keyup.enter="loadSpec" />
          <button class="btn" :disabled="!skuCode || loadingSpec" style="min-width:76px" @click="loadSpec">
            {{ loadingSpec ? '…' : '查询' }}
          </button>
        </div>
      </div>

      <div v-if="err" class="notice err">{{ err }}</div>

      <div v-if="spec" class="card" style="margin-bottom:14px">
        <div class="card-t">{{ spec.skuCode }}</div>
        <div class="card-v">{{ spec.productName }}</div>
        <div class="muted" style="margin-top:6px">
          规格 {{ spec.spec || '—' }} · 单位 {{ spec.unit }}
          <template v-if="spec.unitGtin"> · 单元码 {{ spec.unitGtin }}</template>
        </div>
      </div>

      <!-- 2) 箱规 -->
      <div v-if="spec" class="field">
        <label>每箱件数（箱规）</label>
        <div v-if="spec.cartons.length" style="display:flex;gap:8px;flex-wrap:wrap">
          <button v-for="c in spec.cartons" :key="c.gtin" class="btn"
            :class="packQty === c.packQty ? 'primary' : ''"
            style="min-height:44px;padding:0 14px;font-size:15px"
            @click="pickCarton(c)">{{ c.label }}</button>
        </div>
        <div v-else class="notice warn" style="margin-bottom:10px">
          该物料没有登记箱规，请直接填每箱件数（也可去主数据配 GTIN|CARTON|每箱件数）
        </div>
        <input v-model.number="packQty" type="number" min="1" step="1"
          placeholder="每箱件数，如 10 / 20 / 100 / 1000" style="margin-top:10px" />
      </div>

      <!-- 3) 总量与批号 -->
      <div v-if="spec" class="field">
        <label>总件数（要装箱的总量）</label>
        <input v-model.number="totalQty" type="number" min="0" step="1" placeholder="如 27" />
      </div>

      <div v-if="spec" class="field">
        <label>批号（可空）</label>
        <input v-model="batchNo" placeholder="如 LOT2611" autocomplete="off" />
      </div>

      <div v-if="spec" class="field">
        <label>装完就打箱标</label>
        <div style="display:flex;gap:8px">
          <button class="btn" :class="printOn ? 'success' : ''" style="min-height:44px;padding:0 18px"
            @click="printOn = !printOn">{{ printOn ? '已开启' : '已关闭' }}</button>
          <span class="muted" style="align-self:center">路由 carton-station</span>
        </div>
      </div>

      <div v-if="missing" class="notice warn" style="margin-bottom:12px">{{ missing }}</div>
      <div v-if="preview" class="notice ok" style="margin-bottom:12px">{{ preview }}</div>

      <button v-if="spec" class="btn primary wide big" :disabled="submitting"
        @click="submit">{{ submitting ? '装箱中…' : '生成箱码' }}</button>

      <div v-if="submitting" class="muted" style="text-align:center;margin-top:10px">正在生成 SSCC{{ printOn ? ' 并打印箱标' : '' }}…</div>

      <!-- 4) 结果 -->
      <template v-if="result">
        <div class="card" style="margin:16px 0">
          <div class="card-t">装箱结果</div>
          <div class="card-v">{{ result.fullBoxes }} 满箱
            <template v-if="result.tailQty > 0"> + 1 尾箱（{{ result.tailQty }}{{ result.unit }}）</template>
          </div>
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
            <span v-if="b.tail" class="tag SHORT">尾箱</span>
            <span v-else class="tag RECEIVED">满箱</span>
          </div>
          <div class="meta mono">{{ b.sscc }}</div>
          <div class="meta" v-if="b.printed">
            打印：{{ printLabel(b.printed.status) }}<template v-if="b.printed.message"> · {{ b.printed.message }}</template>
          </div>
          <div class="meta" v-else>未请求打印</div>
        </button>

        <div class="muted" style="margin-top:14px;text-align:center">点箱子可复制 SSCC</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  apiCartonPack, apiCartonSpec, errorMessage,
  type CartonPackOption, type CartonPackResult, type CartonSpec,
} from '@/api';

const router = useRouter();

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

const missing = computed(() => {
  if (!spec.value) return '';
  const lacks: string[] = [];
  if (!(Number(packQty.value) > 0)) lacks.push('每箱件数（箱规）');
  if (!(Number(totalQty.value) > 0)) lacks.push('总件数');
  return lacks.length ? `还差：${lacks.join('、')}` : '';
});

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
  skuCode.value = '';
  spec.value = null;
  packQty.value = null;
  totalQty.value = null;
  batchNo.value = '';
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
