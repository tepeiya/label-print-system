<template>
  <div>
    <div class="pda-header">
      <button class="back" @click="router.push('/')">‹</button>
      <div class="title">UDI 扫码复核</div>
      <button class="btn" style="min-height:36px;padding:0 12px;font-size:13px" @click="clearResult">清空</button>
    </div>

    <div class="pda-body">
      <div v-if="err" class="notice err">{{ err }}</div>

      <!-- 预期信息（可留空：只校验码本身合规） -->
      <div class="card">
        <div class="card-t">作业预期（留空则只校验码合规）</div>
        <div class="field">
          <label>GTIN（DI）</label>
          <input v-model.trim="expect.gtin" placeholder="如 6901234567892" inputmode="numeric" />
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label>批号</label>
            <input v-model.trim="expect.lot" placeholder="如 LOT202611" />
          </div>
          <div class="field" style="flex:1">
            <label>序列号</label>
            <input v-model.trim="expect.serial" placeholder="如 SN0001" />
          </div>
        </div>
        <div class="field">
          <label>有效期</label>
          <input v-model.trim="expect.expiry" placeholder="2027-12-31 或 271231" />
        </div>
        <label class="muted" style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <input type="checkbox" v-model="strict" style="width:auto;min-height:auto" />
          严格模式（预期有值而实际缺失，也判不符）
        </label>
      </div>

      <!-- 扫码区 -->
      <div class="scanner-wrap" v-show="scannerOn">
        <video ref="videoBind" playsinline muted></video>
        <div class="scanner-frame"></div>
        <div class="scanner-tip">{{ scanner.error || '对准数据矩阵码（DataMatrix），自动识别' }}</div>
      </div>
      <div v-if="!scannerOn" class="notice warn" style="margin-top:10px">
        摄像头未开启 · 可手动粘贴扫码内容
      </div>

      <div style="display:flex;gap:10px;margin:14px 0">
        <button class="btn" style="flex:1" @click="toggleScanner">{{ scannerOn ? '关闭摄像头' : '开启摄像头扫码' }}</button>
        <button class="btn" style="flex:1" @click="showManual = !showManual">{{ showManual ? '收起手输' : '手动输入' }}</button>
      </div>

      <div class="card" v-if="showManual">
        <div class="field">
          <label>扫码内容（HRI 或原始元素串均可）</label>
          <textarea v-model.trim="manualCode" rows="3" placeholder="(01)…(17)…(10)…(21)… 或 01069…"></textarea>
        </div>
        <button class="btn primary wide big" :disabled="verifying || !manualCode" @click="verify(manualCode)">
          {{ verifying ? '核验中…' : '核验' }}
        </button>
      </div>

      <!-- 结果 -->
      <div class="card" v-if="verdict" :style="verdict.ok ? 'border-left:4px solid #16a34a' : 'border-left:4px solid #dc2626'">
        <div class="row">
          <span class="card-t" style="margin:0">{{ verdict.ok ? '✅ 复核通过' : '❌ 复核不通过' }}</span>
          <span class="tag" :class="verdict.ok ? 'DONE' : 'CANCELLED'">{{ verdict.ok ? 'PASS' : 'FAIL' }}</span>
        </div>
        <div class="notice" :class="verdict.ok ? 'ok' : 'err'" style="margin-top:8px">{{ verdict.message }}</div>

        <div class="card-t" style="margin-top:12px">解析结果</div>
        <div class="detail-line"><span class="k">DI</span><span class="v mono">{{ verdict.parsed.di || '—' }}</span></div>
        <div class="detail-line"><span class="k">PI</span><span class="v mono">{{ verdict.parsed.pi || '—' }}</span></div>
        <div class="detail-line" v-for="f in verdict.parsed.fields" :key="f.ai + f.value">
          <span class="k">({{ f.ai }}) {{ f.title }}</span>
          <span class="v mono">{{ f.value }}</span>
        </div>
        <div class="muted" style="margin-top:8px;word-break:break-all">原始：{{ verdict.parsed.hri }}</div>

        <div v-if="verdict.mismatches.length" class="card-t" style="margin-top:12px">不符字段</div>
        <div class="detail-line" v-for="m in verdict.mismatches" :key="m.field">
          <span class="k">{{ fieldLabel(m.field) }}</span>
          <span class="v">期望 <b>{{ m.expected }}</b> · 实际 <b style="color:#dc2626">{{ m.actual ?? '空' }}</b></span>
        </div>

        <div v-if="verdict.parsed.warnings.length" class="notice warn" style="margin-top:10px">
          {{ verdict.parsed.warnings.join('；') }}
        </div>
        <div v-if="!verdict.codeOk" class="notice err" style="margin-top:8px">
          {{ verdict.parsed.errors.join('；') }}
        </div>
      </div>

      <!-- 最近记录 -->
      <div class="card" v-if="history.length">
        <div class="card-t">最近复核实录（{{ history.length }}）</div>
        <div v-for="h in history" :key="h.at" class="detail-line">
          <span class="k">{{ h.ok ? '✅' : '❌' }} {{ h.time }}</span>
          <span class="v mono" style="max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ h.hri }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiUdiScanVerify, errorMessage, type UdiScanVerdict } from '@/api';
import { useScanner } from '@/composables/scanner';
import { beep, vibrate } from '@/composables/beep';

const route = useRoute();
const router = useRouter();

// 支持从工单页跳转时带预期： /udi/verify?gtin=...&lot=...&serial=...&expiry=...
const expect = reactive({
  gtin: String(route.query.gtin ?? ''),
  lot: String(route.query.lot ?? ''),
  serial: String(route.query.serial ?? ''),
  expiry: String(route.query.expiry ?? ''),
});
const strict = ref(route.query.strict === '1');
const manualCode = ref('');
const showManual = ref(false);
const verifying = ref(false);
const err = ref('');
const verdict = ref<UdiScanVerdict | null>(null);
const history = ref<Array<{ at: number; time: string; ok: boolean; hri: string }>>([]);

const scanner = useScanner(onDetect);
const videoBind = ref<HTMLVideoElement | null>(null);
const scannerOn = ref(false);

function toggleScanner() {
  if (scannerOn.value) {
    scanner.stop();
    scannerOn.value = false;
  } else {
    scannerOn.value = true;
    requestAnimationFrame(() => {
      scanner.videoEl.value = videoBind.value;
      void scanner.start().then(() => {
        if (scanner.error.value) {
          scannerOn.value = false;
          err.value = scanner.error.value;
        }
      });
    });
  }
}

function onDetect(text: string) {
  if (verifying.value) return;
  void verify(text);
}

async function verify(code: string) {
  const c = String(code ?? '').trim();
  if (!c) return;
  verifying.value = true;
  err.value = '';
  try {
    const r = await apiUdiScanVerify({
      code: c,
      expect: {
        gtin: expect.gtin || undefined,
        lot: expect.lot || undefined,
        serial: expect.serial || undefined,
        expiry: expect.expiry || undefined,
      },
      strict: strict.value,
    });
    verdict.value = r;
    beep(r.ok ? 'ok' : 'fail');
    vibrate(r.ok ? 40 : [60, 40, 60]);
    history.value.unshift({
      at: Date.now(),
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      ok: r.ok,
      hri: r.parsed?.hri || c,
    });
    history.value = history.value.slice(0, 10);
  } catch (e: any) {
    err.value = errorMessage(e);
    beep('fail');
  } finally {
    verifying.value = false;
    // 扫码后收起摄像头，避免连续误触发
    if (scannerOn.value) {
      scanner.stop();
      scannerOn.value = false;
    }
  }
}

function clearResult() {
  verdict.value = null;
  err.value = '';
  manualCode.value = '';
}

function fieldLabel(f: string) {
  return ({ gtin: 'GTIN', expiry: '有效期', lot: '批号', serial: '序列号' } as Record<string, string>)[f] ?? f;
}

// 页面首次进入若 URL 带码，可直接核验（便于工单页一键复核）
if (route.query.code) {
  nextTick(() => { manualCode.value = String(route.query.code); void verify(String(route.query.code)); });
}
</script>
