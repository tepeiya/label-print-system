<template>
  <div>
    <div class="page-header">
      <h2>💰 账单与用量</h2>
      <el-tag type="info" size="small">只读页 · 配额调整与收款登记由平台运营操作</el-tag>
      <el-button style="margin-left: 8px;" @click="loadAll" :loading="loading">刷新</el-button>
    </div>

    <!-- ============================ 本月用量 ============================ -->
    <el-card shadow="hover" style="margin-bottom: 16px;">
      <template #header>
        <div class="card-head">
          <span>本月用量</span>
          <span class="hint">达到软上限只告警，超过硬上限接口按 4033 拦截</span>
        </div>
      </template>

      <el-empty v-if="!loading && !usageCards.length" description="本月暂无用量" />
      <el-row v-else :gutter="16" v-loading="loading">
        <el-col v-for="u in usageCards" :key="u.meter" :xs="24" :sm="12">
          <div class="usage-card">
            <div class="usage-title">
              <span class="usage-name">{{ u.label }}</span>
              <el-tag :type="u.toneTag" size="small" effect="light">{{ u.toneLabel }}</el-tag>
            </div>
            <div class="usage-value" :class="u.tone">
              {{ u.usedText }}
              <span class="usage-limit">{{ u.limitText }}</span>
            </div>
            <el-progress
              v-if="u.percent !== null"
              :percentage="u.percent"
              :stroke-width="8"
              :show-text="false"
              :color="u.color"
            />
            <div v-else class="usage-nolimit">未设置用量上限</div>
            <div class="usage-meta">
              <span>计量项：<code>{{ u.meter }}</code></span>
              <span>统计窗口：{{ u.periodText }}</span>
            </div>

            <div class="spark-wrap">
              <div class="spark">
                <span
                  v-for="b in u.bars"
                  :key="b.day"
                  class="spark-bar"
                  :class="{ 'is-empty': !b.qty }"
                  :style="{ height: b.height }"
                  :title="`${b.day}：${b.qtyText}`"
                />
              </div>
              <div class="spark-foot">
                近 30 天合计 {{ u.seriesTotalText }}
                <span v-if="u.peakDay">，峰值 {{ u.peakDay }} {{ u.peakText }}</span>
                <span v-else class="hint">，近 30 天无记录</span>
              </div>
            </div>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <!-- ============================ 配额（只读） ============================ -->
    <el-card v-if="quotas.length" shadow="hover" style="margin-bottom: 16px;">
      <template #header>
        <div class="card-head">
          <span>配额配置</span>
          <span class="hint">空 = 该侧不限制；调整请联系平台运营</span>
        </div>
      </template>
      <el-table :data="quotas" size="small" stripe>
        <el-table-column label="计量项" min-width="160">
          <template #default="{ row }">{{ meterLabel(row.meter) }}</template>
        </el-table-column>
        <el-table-column label="代码" width="160">
          <template #default="{ row }"><code>{{ row.meter }}</code></template>
        </el-table-column>
        <el-table-column label="软上限" width="140" align="right">
          <template #default="{ row }">{{ row.softLimit === null ? '不限制' : fmtNum(row.softLimit) }}</template>
        </el-table-column>
        <el-table-column label="硬上限" width="140" align="right">
          <template #default="{ row }">{{ row.hardLimit === null ? '不限制' : fmtNum(row.hardLimit) }}</template>
        </el-table-column>
        <el-table-column label="周期" width="100">
          <template #default="{ row }">{{ periodLabel(row.period) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- ============================ 账单 ============================ -->
    <el-card shadow="hover">
      <template #header>
        <div class="card-head">
          <span>账单（{{ invoices.length }}）</span>
          <span class="hint">点击任意行查看账单明细与收款记录</span>
        </div>
      </template>
      <el-table
        :data="invoices"
        v-loading="invoiceLoading"
        size="small"
        stripe
        @row-click="openInvoice"
      >
        <el-table-column prop="number" label="单号" min-width="190" />
        <el-table-column label="账期" width="200">
          <template #default="{ row }">{{ periodText(row.periodStart, row.periodEnd) }}</template>
        </el-table-column>
        <el-table-column label="应付" width="120" align="right">
          <template #default="{ row }">{{ money(row.amountCents) }}</template>
        </el-table-column>
        <el-table-column label="已收" width="120" align="right">
          <template #default="{ row }">{{ money(row.paidCents) }}</template>
        </el-table-column>
        <el-table-column label="余额" width="120" align="right">
          <template #default="{ row }">
            <span :class="{ danger: row.balanceCents > 0 }">{{ money(row.balanceCents) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusMeta(row.status).type" size="small">
              {{ statusMeta(row.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="到期时间" width="180">
          <template #default="{ row }">{{ formatTime(row.dueAt) }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!invoiceLoading && !invoices.length" description="暂无账单" />
    </el-card>

    <!-- ============================ 账单详情抽屉 ============================ -->
    <el-drawer v-model="drawer" size="48%" :title="current ? `账单 ${current.number}` : '账单详情'">
      <div v-loading="detailLoading">
        <template v-if="current">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="状态">
              <el-tag :type="statusMeta(current.status).type" size="small">
                {{ statusMeta(current.status).label }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="币种">{{ current.currency || 'CNY' }}</el-descriptions-item>
            <el-descriptions-item label="账期">
              {{ periodText(current.periodStart, current.periodEnd) }}
            </el-descriptions-item>
            <el-descriptions-item label="到期时间">{{ formatTime(current.dueAt) }}</el-descriptions-item>
            <el-descriptions-item label="应付">{{ money(current.amountCents) }}</el-descriptions-item>
            <el-descriptions-item label="已收">{{ money(current.paidCents) }}</el-descriptions-item>
            <el-descriptions-item label="余额">{{ money(current.balanceCents) }}</el-descriptions-item>
            <el-descriptions-item label="结清时间">{{ formatTime(current.paidAt) }}</el-descriptions-item>
          </el-descriptions>

          <h4 class="drawer-h">套餐快照</h4>
          <div v-if="current.detail && current.detail.source === 'plan' && current.detail.plan" class="plan-snapshot">
            <el-tag size="small" effect="plain">{{ current.detail.plan.code || '—' }}</el-tag>
            <span class="plan-name">{{ current.detail.plan.name || '（无套餐名）' }}</span>
            <span class="plan-price">月费 {{ money(current.detail.plan.priceCents) }}</span>
          </div>
          <div v-else class="plan-snapshot">
            <el-tag size="small" type="info" effect="plain">
              {{ current.detail && current.detail.source === 'manual' ? '手工出账' : '无套餐快照' }}
            </el-tag>
          </div>

          <h4 class="drawer-h">账单行（{{ lines.length }}）</h4>
          <el-table :data="lines" size="small" stripe>
            <el-table-column prop="title" label="项目" min-width="200" />
            <el-table-column label="编码" width="140">
              <template #default="{ row }">
                <code v-if="row.code">{{ row.code }}</code>
                <span v-else class="hint">—</span>
              </template>
            </el-table-column>
            <el-table-column label="数量" width="80" align="right">
              <template #default="{ row }">{{ row.qty === undefined || row.qty === null ? '—' : row.qty }}</template>
            </el-table-column>
            <el-table-column label="单价" width="110" align="right">
              <template #default="{ row }">
                {{ row.unitPriceCents === undefined || row.unitPriceCents === null ? '—' : money(row.unitPriceCents) }}
              </template>
            </el-table-column>
            <el-table-column label="金额" width="120" align="right">
              <template #default="{ row }">{{ money(lineAmount(row)) }}</template>
            </el-table-column>
          </el-table>
          <div v-if="current.detail && current.detail.note" class="invoice-note">
            备注：{{ current.detail.note }}
          </div>

          <h4 class="drawer-h">收款记录（{{ payments.length }}）</h4>
          <el-table v-if="payments.length" :data="payments" size="small" stripe>
            <el-table-column label="通道" width="100">
              <template #default="{ row }">{{ providerLabel(row.provider) }}</template>
            </el-table-column>
            <el-table-column label="流水号" min-width="140">
              <template #default="{ row }">
                <code v-if="row.providerRef">{{ row.providerRef }}</code>
                <span v-else class="hint">—</span>
              </template>
            </el-table-column>
            <el-table-column label="金额" width="110" align="right">
              <template #default="{ row }">{{ money(row.amountCents) }}</template>
            </el-table-column>
            <el-table-column label="收款时间" width="170">
              <template #default="{ row }">{{ formatTime(row.paidAt) }}</template>
            </el-table-column>
            <el-table-column label="备注" min-width="120">
              <template #default="{ row }">{{ row.note || '—' }}</template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="暂无收款记录" :image-size="60" />

          <el-alert
            v-if="reconcile"
            :type="reconcile.ok ? 'success' : 'error'"
            :closable="false"
            class="reconcile"
          >
            <template #title>
              对账自检：应付 {{ money(reconcile.amount) }} = 已收 {{ money(reconcile.paid) }} + 余额
              {{ money(reconcile.balance) }}
              <el-tag :type="reconcile.ok ? 'success' : 'danger'" size="small" effect="dark">
                {{ reconcile.ok ? '平' : `差 ${fmtNum(reconcile.diff)} 分` }}
              </el-tag>
            </template>
            <div class="reconcile-sub">
              收款流水合计 {{ money(reconcile.paymentsTotal) }}（与已收{{ reconcile.paymentsMatched ? '一致' : '不一致' }}）；
              账单行合计 {{ money(reconcile.linesTotal) }}（与应付{{ reconcile.linesMatched ? '一致' : '不一致' }}）
            </div>
          </el-alert>
        </template>
        <el-empty v-else-if="!detailLoading" description="账单详情加载失败" />
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  apiBillingUsage,
  apiBillingSeries,
  apiBillingQuotas,
  apiBillingInvoices,
  apiBillingInvoice,
  type BillingUsageItem,
  type BillingSeriesPoint,
  type BillingQuota,
  type Invoice,
  type InvoiceFull,
  type InvoiceLineItem,
  type InvoicePayment,
  type InvoiceStatus,
} from '@/api';

type TagType = 'success' | 'warning' | 'danger' | 'info' | 'primary';
type Tone = 'normal' | 'warning' | 'danger';

/** 已知计量项的中文名；未登记的 meter 原样显示，后端加计量项不会让页面出错 */
const METER_LABELS: Record<string, string> = {
  print_labels: '打印张数',
  ai_generate: 'AI 生成次数',
};
const SERIES_DAYS = 30;

const loading = ref(false);
const invoiceLoading = ref(false);
const detailLoading = ref(false);

const usageItems = ref<BillingUsageItem[]>([]);
const quotas = ref<BillingQuota[]>([]);
/** meter → 日序列（后端稀疏返回，缺记录的日子不出现） */
const seriesMap = ref<Record<string, BillingSeriesPoint[]>>({});
const invoices = ref<Invoice[]>([]);
const drawer = ref(false);
const current = ref<InvoiceFull | null>(null);

const meterLabel = (m: string) => METER_LABELS[m] || m;
const periodLabel = (p?: string) => (p === 'day' ? '按日' : p === 'month' ? '按月' : p || '—');

/** 金额：后端给的是「分」，展示统一 /100 保留两位加 ¥ */
function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return '—';
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

/** 用量数值：NUMERIC(14,2) 可能是小数，整数就不带小数位 */
function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function pad(n: number) { return String(n).padStart(2, '0'); }
function dayKey(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function recentDayKeys(n: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  return out;
}

function formatDate(v?: string | null): string {
  if (!v) return '—';
  // period_start / period_end 后端是 date 列，直接就是 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(v?: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN');
}

function periodText(start?: string | null, end?: string | null): string {
  if (!start && !end) return '—';
  return `${formatDate(start)} ~ ${formatDate(end)}`;
}

function statusMeta(s: InvoiceStatus | string): { label: string; type: TagType } {
  if (s === 'paid') return { label: '已结清', type: 'success' };
  if (s === 'overdue') return { label: '已逾期', type: 'danger' };
  if (s === 'issued') return { label: '待付款', type: 'warning' };
  return { label: s || '未知', type: 'info' };
}

function providerLabel(p?: string | null): string {
  if (!p) return '—';
  if (p === 'manual') return '线下登记';
  return p;
}

function lineAmount(l: InvoiceLineItem): number {
  if (l.amountCents !== undefined && l.amountCents !== null) return Number(l.amountCents);
  if (l.unitPriceCents !== undefined && l.unitPriceCents !== null) {
    return Number(l.unitPriceCents) * Number(l.qty ?? 1);
  }
  return 0;
}

interface UsageCard {
  meter: string;
  label: string;
  usedText: string;
  limitText: string;
  percent: number | null;
  color: string;
  tone: Tone;
  toneLabel: string;
  toneTag: TagType;
  periodText: string;
  bars: { day: string; qty: number; qtyText: string; height: string }[];
  seriesTotalText: string;
  peakDay: string;
  peakText: string;
}

const usageCards = computed<UsageCard[]>(() => {
  const axis = recentDayKeys(SERIES_DAYS);
  return usageItems.value.map((u) => {
    const hard = u.hardLimit ?? null;
    const soft = u.softLimit ?? null;
    const used = Number(u.used ?? 0);
    const overHard = hard !== null && used >= hard;
    const overSoft = soft !== null && used >= soft;

    const tone: Tone = overHard ? 'danger' : overSoft ? 'warning' : 'normal';
    const toneLabel = overHard ? '已达硬上限' : overSoft ? '已达软上限' : '正常';
    const toneTag: TagType = overHard ? 'danger' : overSoft ? 'warning' : 'success';
    const color = overHard ? '#f56c6c' : overSoft ? '#e6a23c' : '#409eff';

    const limit = hard ?? soft;
    const percent = limit !== null && limit > 0
      ? Math.min(100, Math.max(0, Math.round((used / Number(limit)) * 100)))
      : null;
    const limitText = hard !== null
      ? `/ 硬上限 ${fmtNum(hard)}${soft !== null && soft < hard ? ` · 软上限 ${fmtNum(soft)}` : ''}`
      : soft !== null
        ? `/ 软上限 ${fmtNum(soft)}`
        : '无上限';

    const points = seriesMap.value[u.meter] || [];
    const byDay = new Map(points.map((p) => [p.day, Number(p.quantity)]));
    const cells = axis.map((day) => ({ day, qty: byDay.get(day) ?? 0 }));
    const peak = cells.reduce((a, b) => (b.qty > a.qty ? b : a), { day: '', qty: 0 });
    const maxQty = cells.reduce((m, c) => (c.qty > m ? c.qty : m), 0);
    const seriesTotal = cells.reduce((s, c) => s + c.qty, 0);

    return {
      meter: u.meter,
      label: meterLabel(u.meter),
      usedText: fmtNum(used),
      limitText,
      percent,
      color,
      tone,
      toneLabel,
      toneTag,
      periodText: periodLabel(u.period),
      bars: cells.map((c) => ({
        day: c.day,
        qty: c.qty,
        qtyText: fmtNum(c.qty),
        // 无记录的日子留一条极短基线，悬停 title 仍能看到当天日期与量
        height: maxQty > 0 && c.qty > 0 ? `${Math.max(10, Math.round((c.qty / maxQty) * 100))}%` : '3%',
      })),
      seriesTotalText: fmtNum(seriesTotal),
      peakDay: peak.qty > 0 ? peak.day : '',
      peakText: fmtNum(peak.qty),
    };
  });
});

const lines = computed<InvoiceLineItem[]>(() => current.value?.detail?.items ?? []);
const payments = computed<InvoicePayment[]>(() => current.value?.payments ?? []);

/** 应付 = 已收 + 余额；顺带核对收款流水合计与账单行合计 */
const reconcile = computed(() => {
  const inv = current.value;
  if (!inv) return null;
  const amount = Number(inv.amountCents ?? 0);
  const paid = Number(inv.paidCents ?? 0);
  const balance = Number(inv.balanceCents ?? 0);
  const diff = amount - paid - balance;
  const paymentsTotal = payments.value.reduce((s, p) => s + Number(p.amountCents ?? 0), 0);
  const linesTotal = lines.value.reduce((s, l) => s + lineAmount(l), 0);
  return {
    ok: diff === 0,
    diff,
    amount,
    paid,
    balance,
    paymentsTotal,
    paymentsMatched: paymentsTotal === paid,
    linesTotal,
    linesMatched: linesTotal === amount,
  };
});

async function openInvoice(row: Invoice) {
  drawer.value = true;
  detailLoading.value = true;
  current.value = null;
  try {
    current.value = await apiBillingInvoice(row.id);
  } catch {
    /* 拆信封失败时拦截器已弹提示，抽屉里显示空态 */
  } finally {
    detailLoading.value = false;
  }
}

async function loadUsage() {
  const res: any = await apiBillingUsage();
  usageItems.value = Array.isArray(res?.items) ? res.items : [];
  // 序列只为已有用量的 meter 拉，接口失败不影响用量卡片
  const pairs = await Promise.all(
    usageItems.value.map(async (u) => {
      try {
        const s: any = await apiBillingSeries(u.meter, SERIES_DAYS);
        return [u.meter, Array.isArray(s) ? s : []] as const;
      } catch {
        return [u.meter, []] as const;
      }
    }),
  );
  seriesMap.value = Object.fromEntries(pairs);
}

async function loadAll() {
  loading.value = true;
  try {
    await loadUsage();
  } catch { /* 拦截器已弹 */ }

  try {
    const q: any = await apiBillingQuotas();
    quotas.value = Array.isArray(q) ? q : [];
  } catch { /* 拦截器已弹 */ }

  invoiceLoading.value = true;
  try {
    const list: any = await apiBillingInvoices();
    invoices.value = Array.isArray(list) ? list : (list?.items ?? []);
  } catch { /* 拦截器已弹 */ } finally {
    invoiceLoading.value = false;
  }
  loading.value = false;
}

onMounted(loadAll);
</script>

<style scoped>
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.card-head .hint { color: #909399; font-size: 12px; font-weight: 400; }
.hint { color: #909399; font-size: 12px; }
.danger { color: #f56c6c; }

.usage-card {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: #fff;
}
.usage-title { display: flex; align-items: center; justify-content: space-between; }
.usage-name { font-size: 14px; color: #303133; font-weight: 600; }
.usage-value { font-size: 24px; font-weight: 600; color: #303133; margin: 6px 0 8px; }
.usage-value.warning { color: #e6a23c; }
.usage-value.danger { color: #f56c6c; }
.usage-limit { font-size: 13px; font-weight: 400; color: #909399; margin-left: 6px; }
.usage-nolimit { font-size: 12px; color: #909399; margin-bottom: 6px; }
.usage-meta {
  display: flex; justify-content: space-between; gap: 8px;
  font-size: 12px; color: #909399; margin-top: 8px;
}
.usage-meta code { font-size: 12px; color: #606266; }

.spark-wrap { margin-top: 10px; border-top: 1px dashed #ebeef5; padding-top: 8px; }
.spark { display: flex; align-items: flex-end; gap: 2px; height: 36px; }
.spark-bar {
  flex: 1;
  min-width: 2px;
  background: #409eff;
  border-radius: 1px 1px 0 0;
  opacity: 0.85;
}
.spark-bar.is-empty { background: #e4e7ed; opacity: 1; }
.spark-foot { font-size: 12px; color: #909399; margin-top: 4px; }

.drawer-h { margin: 18px 0 8px; font-size: 14px; color: #303133; }
.plan-snapshot { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #606266; }
.plan-price { color: #909399; }
.invoice-note { margin-top: 6px; font-size: 12px; color: #909399; }
.reconcile { margin-top: 16px; }
.reconcile-sub { font-size: 12px; margin-top: 2px; }
</style>
