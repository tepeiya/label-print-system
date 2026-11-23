<template>
  <div>
    <div class="pda-header">
      <button class="back" @click="router.push('/issuing')">‹</button>
      <div class="title">发料作业</div>
      <button class="btn" style="min-height:36px;padding:0 12px;font-size:13px" @click="load">刷新</button>
    </div>

    <div class="pda-body">
      <div v-if="err" class="notice err">{{ err }}</div>
      <div v-if="msg" class="notice" :class="msgClass">{{ msg }}</div>

      <!-- 工单头 -->
      <div class="card" v-if="wo">
        <div class="row">
          <span class="mono" style="font-size:18px;font-weight:700">{{ wo.woNo }}</span>
          <span class="tag">{{ woStatusLabel(wo.status) }}</span>
        </div>
        <div class="muted" style="margin-top:6px">
          需求 {{ wo.demandQty }} · 仓库 #{{ wo.warehouseId }}
          <span v-if="wo.shortageFlag"> · <b style="color:#b91c1c">有缺料</b></span>
        </div>
        <div class="muted" v-if="wo.kitSummary">
          齐套率 {{ wo.kitSummary.overallKitRate ?? '—' }}% · 可配套 {{ wo.kitSummary.overallMaxSets ?? '—' }}
          · 缺料行 {{ wo.kitSummary.shortageLines?.length ?? 0 }}
        </div>
      </div>

      <!-- 流程按钮 -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0" v-if="wo">
        <button v-if="wo.status === 'CREATED'" class="btn primary" @click="kitCheck">① 齐套检查</button>
        <button v-if="wo.status === 'CREATED'" class="btn primary" @click="release">② 放行发料</button>
        <button v-if="wo.status === 'RELEASED'" class="btn primary" @click="issueStart">③ 开始发料</button>
        <button v-if="wo.status === 'ISSUING'" class="btn primary" @click="issuePost">
          ④ 发料过账{{ packs.length ? `（${packs.length} 个包码）` : '' }}
        </button>
        <button v-if="wo.status === 'ISSUING'" class="btn" @click="issueDone">⑤ 发料完成</button>
        <button v-if="wo.status === 'ISSUED'" class="btn" @click="toggleReturn">退料</button>
      </div>
      <div class="muted" v-if="wo && wo.status === 'CLOSED'" style="margin:12px 0">工单已关单，不能再发料或退料。</div>

      <!-- 行明细 -->
      <div class="card" v-if="wo?.lines?.length">
        <div class="card-t">发料明细（{{ wo.lines.length }} 行）</div>
        <div
          v-for="l in wo.lines" :key="l.id"
          class="detail-line" :style="selLine === l.id ? 'outline:2px solid #2563eb;border-radius:8px' : ''"
          @click="selLine = l.id"
        >
          <div class="row">
            <span class="mono" style="font-weight:600">行{{ l.lineNo }} · {{ l.materialCode || l.materialId }}</span>
            <span class="tag" :style="statusStyle(l.status)">{{ lineStatusLabel(l.status) }}</span>
          </div>
          <div class="muted">
            {{ l.materialName }} · 批次 {{ l.batchNo || '自动' }}
          </div>
          <div class="muted">
            需求 {{ l.qtyRequired }} / 已发 {{ l.qtyIssued }} / 缺 {{ l.qtyShortage }} {{ l.unit || '' }}
          </div>
          <div class="muted" v-if="l.shortageReason" style="color:#b91c1c">{{ l.shortageReason }}</div>
        </div>
      </div>

      <!-- 扫码区（发料中才有意义） -->
      <div class="card" v-if="wo && wo.status === 'ISSUING'">
        <div class="card-t">扫码发料</div>
        <div class="muted" style="margin-bottom:8px">
          选一行 → 扫箱码/单品码 → 比对 → 加入待过账；过账时按 pack_qty 折算成件数扣库存。
        </div>
        <div class="field">
          <label>目标行</label>
          <select v-model.number="selLine">
            <option :value="undefined">请选择行</option>
            <option v-for="l in wo.lines" :key="l.id" :value="l.id">
              行{{ l.lineNo }} · {{ l.materialName }} · 待发 {{ Math.max(0, l.qtyRequired - l.qtyIssued) }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>扫码（GS1 或纯 GTIN）</label>
          <input v-model.trim="scanCode" placeholder="扫码枪回车即可" @keyup.enter="scan" />
        </div>
        <div class="field">
          <label>包数（扫箱码时填，单品填 1）</label>
          <input v-model.number="packCount" type="number" min="1" step="1" />
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" style="flex:1" :disabled="!scanCode || busy" @click="scan">扫码比对</button>
          <button class="btn primary" style="flex:1" :disabled="!scanCode || !selLine || busy" @click="addPack">加入待过账</button>
        </div>
        <div v-if="verdict" class="notice" :class="verdict.ok ? '' : 'err'" style="margin-top:10px">
          {{ verdict.ok ? '物料/批次比对通过' : `比对不通过：${(verdict.mismatches || []).map((m: any) => m.field).join('、') || verdict.message || ''}` }}
        </div>
        <div v-if="packs.length" style="margin-top:10px">
          <div class="muted">待过账包码（{{ packs.length }}）：</div>
          <div v-for="(p, i) in packs" :key="i" class="row" style="margin-top:4px">
            <span class="mono" style="font-size:12px">{{ p.udiCode }}</span>
            <button class="btn" style="min-height:30px;padding:0 8px;font-size:12px" @click="packs.splice(i, 1)">移除</button>
          </div>
        </div>
      </div>

      <!-- 退料 -->
      <div class="card" v-if="showReturn && wo">
        <div class="card-t">退料冲销（需在「已发完」状态）</div>
        <div class="field">
          <label>行</label>
          <select v-model.number="ret.lineId">
            <option :value="undefined">请选择行</option>
            <option v-for="l in wo.lines.filter((x) => x.qtyIssued > 0)" :key="l.id" :value="l.id">
              行{{ l.lineNo }} · {{ l.materialName }} · 已发 {{ l.qtyIssued }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>退料数量</label>
          <input v-model.number="ret.qty" type="number" min="0.001" step="0.001" />
        </div>
        <div class="field">
          <label>原因 *</label>
          <input v-model.trim="ret.reason" placeholder="如：产线退回、发错料" />
        </div>
        <button class="btn primary wide big" :disabled="busy || !ret.lineId || !ret.qty || !ret.reason" @click="submitReturn">
          {{ busy ? '提交中…' : '提交退料' }}
        </button>
        <div class="muted" style="margin-top:6px">重复提交同一退料会被服务端识别为幂等回放，不会二次回补库存。</div>
      </div>

      <div class="card" v-if="wo?.issueRecords?.length">
        <div class="card-t">发料记录（{{ wo.issueRecords.length }}）</div>
        <div v-for="r in wo.issueRecords.slice(0, 20)" :key="r.id" class="muted">
          {{ r.materialCode || r.materialId }} · 批 {{ r.batchNo }} · {{ r.qty }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  apiWoDetail, apiWoKitCheck, apiWoRelease, apiWoIssueStart, apiWoIssueScan,
  apiWoIssuePost, apiWoIssueDone, apiWoReturn, errorMessage, woStatusLabel,
  type WorkOrderDetail,
} from '@/api';

const route = useRoute();
const router = useRouter();
const id = Number(route.params.id);

const wo = ref<WorkOrderDetail | null>(null);
const err = ref('');
const msg = ref('');
const msgClass = ref('');
const busy = ref(false);
const verdict = ref<any>(null);
const selLine = ref<number | undefined>(undefined);
const scanCode = ref('');
const packCount = ref(1);
const packs = ref<Array<{ lineId: number; udiCode: string; packCount: number }>>([]);
const showReturn = ref(false);
const ret = ref<{ lineId?: number; qty?: number; reason: string }>({ reason: '' });
const returnKey = ref(`pda-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

const lineStatusLabel = (s: string) => ({
  PENDING: '未发', PARTIAL: '部分', DONE: '已发满', SHORT: '缺料',
} as Record<string, string>)[s] || s;

function statusStyle(s: string) {
  const map: Record<string, string> = {
    DONE: 'background:#dcfce7;color:#166534',
    PARTIAL: 'background:#fef3c7;color:#92400e',
    SHORT: 'background:#fee2e2;color:#991b1b',
    PENDING: 'background:#e5e7eb;color:#374151',
  };
  return map[s] || '';
}

function say(text: string, kind: '' | 'err' = '') {
  msg.value = text;
  msgClass.value = kind;
  err.value = kind === 'err' ? text : '';
  if ('vibrate' in navigator) navigator.vibrate?.(kind === 'err' ? [80, 40, 80] : 40);
}

async function load() {
  err.value = '';
  try {
    wo.value = await apiWoDetail(id);
  } catch (e) {
    err.value = errorMessage(e);
  }
}

async function run(fn: () => Promise<any>, okText: string) {
  busy.value = true;
  try {
    await fn();
    say(okText);
    verdict.value = null;
    packs.value = [];
    await load();
  } catch (e) {
    say(errorMessage(e), 'err');
  } finally {
    busy.value = false;
  }
}

const kitCheck = () => run(() => apiWoKitCheck(id), '齐套检查完成');
const release = () => run(() => apiWoRelease(id), '已放行');
const issueStart = () => run(() => apiWoIssueStart(id), '开始发料');
const issueDone = () => run(() => apiWoIssueDone(id), '发料完成');

async function issuePost() {
  busy.value = true;
  try {
    const res = await apiWoIssuePost(id, {
      packs: packs.value.map((p) => ({ lineId: p.lineId, udiCode: p.udiCode, packCount: p.packCount })),
    });
    const posted = res?.posted ?? [];
    const total = posted.reduce((s: number, p: any) => s + Number(p.qty || 0), 0);
    const warn = posted.find((p: any) => p.packWarning)?.packWarning;
    say(`过账完成：扣减 ${total} 件${warn ? `；${warn}` : ''}`);
    verdict.value = null;
    packs.value = [];
    await load();
  } catch (e) {
    say(errorMessage(e), 'err');
  } finally {
    busy.value = false;
  }
}

async function scan() {
  if (!scanCode.value) return;
  busy.value = true;
  try {
    verdict.value = await apiWoIssueScan(id, {
      lineId: selLine.value,
      udiCode: scanCode.value,
      materialCode: scanCode.value,
    });
    if (verdict.value?.ok) say('比对通过');
    else say('比对不通过', 'err');
  } catch (e) {
    say(errorMessage(e), 'err');
  } finally {
    busy.value = false;
  }
}

function addPack() {
  if (!selLine.value || !scanCode.value) return;
  packs.value.push({ lineId: selLine.value, udiCode: scanCode.value, packCount: Math.max(1, Number(packCount.value) || 1) });
  say('已加入待过账');
  scanCode.value = '';
  packCount.value = 1;
}

function toggleReturn() {
  showReturn.value = !showReturn.value;
  if (showReturn.value) returnKey.value = `pda-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function submitReturn() {
  busy.value = true;
  try {
    const res = await apiWoReturn(id, {
      lineId: Number(ret.value.lineId), qty: Number(ret.value.qty), reason: String(ret.value.reason),
      idemKey: returnKey.value,
    });
    say(res?.idempotent ? '该退料已提交过（幂等回放，库存未二次回补）' : '退料完成，库存已回补');
    showReturn.value = false;
    ret.value = { reason: '' };
    await load();
  } catch (e) {
    say(errorMessage(e), 'err');
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>
