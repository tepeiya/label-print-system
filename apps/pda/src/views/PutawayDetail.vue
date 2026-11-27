<template>
  <div>
    <div class="pda-header">
      <button class="back" @click="router.push('/putaway')">‹</button>
      <div class="title">上架确认</div>
      <button class="btn" style="min-height:36px;padding:0 12px;font-size:13px" @click="loadRecommend">重新推荐</button>
    </div>
    <div class="pda-body">
      <div v-if="err" class="notice err">{{ err }}</div>

      <div class="card" style="background:linear-gradient(135deg,#14532d,#0f172a)">
        <div class="card-t">上架任务</div>
        <div class="card-v">#{{ taskId }}</div>
      </div>

      <div v-if="recommend">
        <div class="card">
          <div class="card-t">推荐库位</div>
          <div class="card-v mono" style="color:var(--ok)">{{ recommend.locationCode || ('库位 #' + recommend.locationId) }}</div>
          <div class="muted" style="margin-top:8px;white-space:pre-wrap">{{ recommend.reason || '系统按库位规则推荐' }}</div>
          <div v-if="recommend.ruleId" class="muted" style="margin-top:4px">命中规则 #{{ recommend.ruleId }}</div>
        </div>

        <div class="field">
          <label>实际库位 ID（可覆盖推荐值，仅记录差异）</label>
          <input v-model.number="form.actualLocationId" type="number" :placeholder="String(recommend.locationId ?? '')" />
          <div class="muted" style="margin-top:4px">阶段一：过账已入推荐位，改库位仅记录差异</div>
        </div>
        <div class="field">
          <label>备注</label>
          <input v-model.trim="form.remark" placeholder="可选" />
        </div>

        <div v-if="message" class="notice" :class="ok ? 'ok' : 'err'">{{ message }}</div>

        <button class="btn success wide big" :disabled="confirming" @click="confirm">
          {{ confirming ? '确认中…' : '确认上架' }}
        </button>
      </div>
      <div v-else class="empty">
        <div class="icon"></div>
        <div>正在计算推荐库位…</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiTaskRecommend, apiTaskConfirm, errorMessage, type RecommendResult } from '@/api';
import { beep, vibrate } from '@/composables/beep';

const route = useRoute();
const router = useRouter();
const taskId = Number(route.params.id);

const recommend = ref<RecommendResult | null>(null);
const err = ref('');
const message = ref('');
const ok = ref(true);
const confirming = ref(false);
const form = reactive({ actualLocationId: undefined as number | undefined, remark: '' });

async function loadRecommend() {
  err.value = '';
  try {
    recommend.value = await apiTaskRecommend(taskId);
    form.actualLocationId = recommend.value.locationId ?? undefined;
  } catch (e) {
    err.value = errorMessage(e);
  }
}

async function confirm() {
  confirming.value = true;
  message.value = '';
  try {
    const body: any = { remark: form.remark || undefined };
    if (form.actualLocationId) body.actualLocationId = form.actualLocationId;
    await apiTaskConfirm(taskId, body);
    ok.value = true;
    message.value = '上架确认成功';
    beep('ok');
    vibrate(40);
  } catch (e) {
    ok.value = false;
    message.value = errorMessage(e);
    beep('fail');
  } finally {
    confirming.value = false;
  }
}

onMounted(loadRecommend);
</script>
