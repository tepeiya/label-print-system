<template>
  <div>
    <div class="page-header">
      <h2>📊 用量看板</h2>
      <el-button @click="load" :loading="loading">刷新</el-button>
    </div>

    <div class="stat-grid" v-loading="loading">
      <div v-for="c in cards" :key="c.key" class="stat-card">
        <div class="label">{{ c.label }}</div>
        <div class="value">{{ c.value }}</div>
        <div v-if="c.hint" class="muted sub">{{ c.hint }}</div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <h3 class="block-title">套餐分布</h3>
        <table class="plain-table">
          <tbody>
            <tr v-for="row in planRows" :key="row.code">
              <td class="plan-name">
                {{ row.name }}
                <span class="muted sub">{{ row.code }}</span>
              </td>
              <td class="bar">
                <el-progress :percentage="row.percent" :stroke-width="12" :show-text="false" />
              </td>
              <td class="num">{{ row.count }} 个（{{ row.percent }}%）</td>
            </tr>
            <tr v-if="!planRows.length">
              <td class="muted">暂无数据</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3 class="block-title">
          即将到期
          <span class="muted sub">试用 3 天内到期的租户（后端 EXPIRE_WARN_DAYS=3）</span>
        </h3>
        <el-table
          :data="usage?.expiringSoon ?? []"
          size="small"
          stripe
          empty-text="近期没有到期的试用租户"
        >
          <el-table-column label="租户" min-width="160">
            <template #default="{ row }">
              {{ row.name }}
              <span class="muted sub">{{ row.code }}</span>
            </template>
          </el-table-column>
          <el-table-column label="试用到期" width="120">
            <template #default="{ row }">{{ fmtDate(row.trialEndsAt) }}</template>
          </el-table-column>
          <el-table-column label="剩余" width="100">
            <template #default="{ row }">
              <span :class="leftDays(row.trialEndsAt) <= 1 ? 'danger' : 'warn'">
                {{ leftDays(row.trialEndsAt) }} 天
              </span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiListPlans, apiUsage } from '@/api';
import type { PlanInfo, UsageOverview, UsageTotals } from '@/api/types';

const loading = ref(false);
const usage = ref<UsageOverview | null>(null);
const plans = ref<PlanInfo[]>([]);

/** totals 的 key → 卡片文案（顺序即展示顺序） */
const CARD_DEFS: { key: keyof UsageTotals; label: string; hint?: string }[] = [
  { key: 'tenants_total', label: '租户总数' },
  { key: 'tenants_enabled', label: '启用中' },
  { key: 'tenants_canceled', label: '已退订', hint: '进入 90 天保留期' },
  { key: 'users_active', label: '活跃用户', hint: 'status=1 的用户数' },
  { key: 'templates_total', label: '模板总数' },
  { key: 'jobs_7d', label: '近 7 天打印任务' },
];

const cards = computed(() =>
  CARD_DEFS.map((c) => ({
    key: c.key,
    label: c.label,
    hint: c.hint,
    value: usage.value ? usage.value.totals[c.key] ?? 0 : '—',
  })),
);

/** byPlan：后端给的是 {套餐code: 租户数}，没有的套餐补 0，none 归「无生效订阅」 */
const planRows = computed(() => {
  const byPlan = usage.value?.byPlan ?? {};
  const total = Object.values(byPlan).reduce((a, b) => a + b, 0);
  const codes = [...plans.value.map((p) => p.code), ...Object.keys(byPlan)];
  const uniq = Array.from(new Set(codes));
  return uniq
    .map((code) => ({
      code,
      name: plans.value.find((p) => p.code === code)?.name ?? (code === 'none' ? '无生效订阅' : code),
      count: byPlan[code] ?? 0,
      percent: total ? Math.round(((byPlan[code] ?? 0) / total) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);
});

const fmtDate = (t: string) => new Date(t).toLocaleDateString('zh-CN');
const leftDays = (t: string) => Math.max(0, Math.ceil((new Date(t).getTime() - Date.now()) / 86_400_000));

async function load() {
  loading.value = true;
  try {
    usage.value = await apiUsage();
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  load();
  try {
    plans.value = await apiListPlans();
  } catch {
    /* 套餐名拿不到就退化成显示 code，不影响看板 */
  }
});
</script>

<style scoped>
.two-col {
  display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px;
}
@media (max-width: 1100px) {
  .two-col { grid-template-columns: 1fr; }
}
.block-title { margin: 0 0 12px; font-size: 15px; display: flex; align-items: baseline; gap: 8px; }
.plain-table { width: 100%; border-collapse: collapse; }
.plain-table td { padding: 6px 4px; vertical-align: middle; }
.plan-name { width: 170px; font-weight: 600; white-space: nowrap; }
.bar { width: 100%; }
.num { width: 130px; text-align: right; font-size: 13px; }
.sub { font-size: 12px; }
.danger { color: #f56c6c; font-weight: 600; }
.warn { color: #e6a23c; font-weight: 600; }
</style>
