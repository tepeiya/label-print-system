<template>
  <div>
    <div class="page-header">
      <h2>🎫 套餐配置</h2>
      <el-button @click="load" :loading="loading">刷新</el-button>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="改动说明"
      description="保存走 PUT /platform/plans/:code，moduleCodes 是全量替换；套餐内容变化后后端会失效所有模块缓存，已订阅租户下次读取即生效（不用等 60s）。核心模块与依赖仍由后端展开补齐。月费（priceCents）是账单中心「按套餐出账」的基准，改价只影响之后新出的账单，已出账单的套餐快照不动。"
      style="margin-bottom: 16px;"
    />

    <div class="plan-grid" v-loading="loading">
      <div v-for="p in plans" :key="p.code" class="card plan-card">
        <div class="plan-head">
          <span class="plan-code">{{ p.code }}</span>
          <el-tag size="small" :type="planTagType(p.code)" effect="plain">{{ p.name }}</el-tag>
          <span class="plan-price">
            <template v-if="hasPrice(p.priceCents)">
              {{ priceText(p.priceCents) }}<span class="muted sub"> / 月</span>
            </template>
            <span v-else class="muted sub">列表未返回月费</span>
          </span>
        </div>

        <el-form label-width="72px" label-position="left" size="small">
          <el-form-item label="名称">
            <el-input v-model="drafts[p.code].name" maxlength="80" />
          </el-form-item>
          <el-form-item label="描述">
            <el-input v-model="drafts[p.code].description" type="textarea" :rows="2" maxlength="500" show-word-limit />
          </el-form-item>
          <el-form-item label="月费（元）">
            <el-input-number
              v-model="drafts[p.code].priceYuan"
              :min="0" :precision="2" :step="10" controls-position="right"
            />
            <span class="muted sub">{{ priceHint(p.code) }}</span>
          </el-form-item>
          <el-form-item label="排序">
            <el-input-number v-model="drafts[p.code].sortOrder" :min="0" :max="999" controls-position="right" />
          </el-form-item>
          <el-form-item label="模块">
            <el-select v-model="drafts[p.code].moduleCodes" multiple filterable style="width: 100%" placeholder="选择套餐包含的模块">
              <el-option v-for="m in modules" :key="m.code" :label="m.code" :value="m.code">
                <div class="opt">
                  <span>{{ m.icon ?? '' }} {{ m.name }}</span>
                  <span class="muted">{{ m.code }}{{ m.dependsOn.length ? ' · 依赖 ' + m.dependsOn.join('、') : '' }}</span>
                </div>
              </el-option>
            </el-select>
          </el-form-item>
        </el-form>

        <div class="mod-codes">
          <el-tag v-for="c in p.effectiveModules" :key="c" size="small" effect="plain" class="mod-tag">{{ c }}</el-tag>
          <span v-if="!p.effectiveModules.length" class="muted">当前套餐未包含模块</span>
        </div>
        <div class="muted sub" style="margin-top: 6px;">
          当前生效模块（服务端已按依赖补齐）：{{ p.effectiveModules.length }} 个
        </div>

        <div class="plan-foot">
          <el-button size="small" :disabled="!dirty(p.code)" @click="reset(p.code)">重置</el-button>
          <el-button size="small" type="primary" :loading="saving === p.code" :disabled="!dirty(p.code)" @click="save(p)">
            保存
          </el-button>
        </div>
      </div>
      <el-empty v-if="!loading && !plans.length" description="没有套餐" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { apiListModules, apiListPlans, apiUpdatePlan } from '@/api';
import type { ModuleCatalogItem, PlanInfo, PlanUpdatePayload } from '@/api/types';

/** 可编辑草稿：后端没有单套餐 GET，改完直接 PUT /platform/plans/:code */
interface Draft {
  name: string;
  description: string;
  sortOrder: number;
  /** 月费（元），提交时转 priceCents（分） */
  priceYuan: number;
  /** 列表是否真回了 priceCents：没回就不擅自提交该字段，免得把线上价格清零 */
  priceKnown: boolean;
  moduleCodes: string[];
}

const loading = ref(false);
const saving = ref('');
const plans = ref<PlanInfo[]>([]);
const modules = ref<ModuleCatalogItem[]>([]);
const drafts = reactive<Record<string, Draft>>({});
/** 载入时的快照，用来判 dirty 与「重置」 */
const origin = reactive<Record<string, Draft>>({});

const planTagType = (code: string) =>
  code === 'ENTERPRISE' ? 'danger' : code === 'PRO' ? 'warning' : 'info';

/** 元 → 分（分是后端唯一口径，plans.price_cents 为 BIGINT，读出可能是字符串） */
const centsOf = (yuan: number | undefined | null) => Math.round(Number(yuan ?? 0) * 100);
const hasPrice = (cents: number | string | undefined | null) => cents !== null && cents !== undefined;
const priceText = (cents: number | string) => `¥ ${(Number(cents) / 100).toFixed(2)}`;

/**
 * 月费输入框旁注。
 * GET /platform/plans（PlatformController 目录版）目前不一定回 priceCents（后端 P3 在补），
 * 所以没回的时候明确告诉运营：保持 0 不会覆盖线上价，改了值才提交该字段。
 */
function priceHint(code: string) {
  const d = drafts[code];
  if (!d) return '';
  const cents = centsOf(d.priceYuan);
  if (!d.priceKnown) {
    return d.priceYuan > 0
      ? `列表未回 priceCents，本次将按 ${cents}（分）写入月费`
      : `列表未回 priceCents：留 0 则不提交该字段（线上月费不变），填值后按 ${cents}（分）写入`;
  }
  return `保存提交 priceCents=${cents}（分），是账单中心「按套餐出账」的基准`;
}

function pickDraft(p: PlanInfo): Draft {
  // GET /platform/plans 走 PlatformController 的目录版，模块字段叫 modules；
  // PUT /platform/plans/:code 的回包才叫 moduleCodes，这里都兼容一次
  return {
    name: p.name ?? '',
    description: p.description ?? '',
    sortOrder: p.sortOrder ?? 0,
    priceYuan: hasPrice(p.priceCents) ? Number(p.priceCents) / 100 : 0,
    priceKnown: hasPrice(p.priceCents),
    moduleCodes: [...(p.modules ?? p.moduleCodes ?? [])],
  };
}

function syncDrafts(list: PlanInfo[]) {
  for (const p of list) {
    const d = pickDraft(p);
    drafts[p.code] = d;
    origin[p.code] = { ...d, moduleCodes: [...d.moduleCodes] };
  }
}

function same(a: Draft, b: Draft) {
  return a.name === b.name
    && a.description === b.description
    && a.sortOrder === b.sortOrder
    && a.priceYuan === b.priceYuan
    && a.moduleCodes.join(',') === b.moduleCodes.join(',');
}

function dirty(code: string) {
  const d = drafts[code];
  const o = origin[code];
  if (!d || !o) return false;
  return !same(d, o);
}

function reset(code: string) {
  const o = origin[code];
  if (o) drafts[code] = { ...o, moduleCodes: [...o.moduleCodes] };
}

async function load() {
  loading.value = true;
  try {
    const list = await apiListPlans();
    // 先建好草稿再挂到 plans 上，否则 v-for 渲染时 drafts[code] 还是 undefined
    syncDrafts(list);
    plans.value = list;
  } finally {
    loading.value = false;
  }
}

async function save(p: PlanInfo) {
  const d = drafts[p.code];
  const o = origin[p.code];
  saving.value = p.code;
  const cents = centsOf(d.priceYuan);
  // 列表没回 priceCents 且运营没动价格输入 → 不提交该字段，避免把线上月费误清零
  const touchPrice = d.priceKnown || cents !== centsOf(o?.priceYuan ?? 0);
  const payload: PlanUpdatePayload = {
    name: d.name,
    description: d.description,
    sortOrder: d.sortOrder,
    moduleCodes: d.moduleCodes,
    ...(touchPrice ? { priceCents: cents } : {}),
  };
  try {
    await apiUpdatePlan(p.code, payload);
    ElMessage.success(
      `套餐 ${p.code} 已保存（${touchPrice ? `月费 ${priceText(cents)}，` : ''}模块 ${d.moduleCodes.length} 个）`,
    );
    await load();
  } catch {
    /* 拦截器已提示 */
  } finally {
    saving.value = '';
  }
}

onMounted(async () => {
  load();
  try {
    modules.value = await apiListModules();
  } catch {
    /* 拦截器已提示 */
  }
});
</script>

<style scoped>
.plan-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px;
}
.plan-card { display: flex; flex-direction: column; }
.plan-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.plan-code { font-size: 16px; font-weight: 600; color: #1a73e8; }
.plan-price { margin-left: auto; font-weight: 600; color: #303133; }
.mod-codes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.mod-tag { font-size: 11px; }
.plan-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.opt { display: flex; justify-content: space-between; gap: 12px; }
.sub { font-size: 12px; }
</style>
