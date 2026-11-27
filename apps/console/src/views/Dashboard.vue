<template>
  <div>
    <div class="page-header">
      <h2>仪表盘</h2>
      <el-radio-group v-model="days" size="small">
        <el-radio-button :value="7">近 7 天</el-radio-button>
        <el-radio-button :value="14">近 14 天</el-radio-button>
        <el-radio-button :value="30">近 30 天</el-radio-button>
      </el-radio-group>
    </div>

    <div class="lf-kpi-grid">
      <div class="lf-kpi">
        <div class="lf-kpi-icon" style="background:#eff4ff;color:#2563eb;"><el-icon><DataLine /></el-icon></div>
        <div class="lf-kpi-main">
          <div class="lf-kpi-label">打印任务</div>
          <div class="lf-kpi-value">{{ stats ? (stats.total ?? 0) : '—' }}<small>条</small></div>
          <div class="lf-kpi-foot">近 {{ days }} 天累计</div>
        </div>
      </div>
      <div class="lf-kpi">
        <div class="lf-kpi-icon" style="background:#ecfdf5;color:#16a34a;"><el-icon><CircleCheck /></el-icon></div>
        <div class="lf-kpi-main">
          <div class="lf-kpi-label">打印成功率</div>
          <div class="lf-kpi-value">
            {{ stats ? ((stats.successRate || 0) * 100).toFixed(1) : '—' }}<small>%</small>
          </div>
          <div class="lf-kpi-foot">成功 {{ stats?.counts?.success || 0 }} · 失败 {{ stats?.counts?.failed || 0 }}</div>
        </div>
      </div>
      <div class="lf-kpi">
        <div class="lf-kpi-icon" style="background:#fff7ed;color:#d97706;"><el-icon><Timer /></el-icon></div>
        <div class="lf-kpi-main">
          <div class="lf-kpi-label">平均耗时</div>
          <div class="lf-kpi-value">
            {{ stats ? ((stats.avgDurationMs || 0) / 1000).toFixed(1) : '—' }}<small>秒</small>
          </div>
          <div class="lf-kpi-foot">单个打印任务</div>
        </div>
      </div>
      <div class="lf-kpi">
        <div class="lf-kpi-icon" style="background:#fef2f2;color:#dc2626;"><el-icon><WarningFilled /></el-icon></div>
        <div class="lf-kpi-main">
          <div class="lf-kpi-label">库存预警</div>
          <div class="lf-kpi-value">{{ alertCount === null ? '—' : alertCount }}<small>条</small></div>
          <div class="lf-kpi-foot">呆滞 / 效期 / 安全库存</div>
        </div>
      </div>
      <div class="lf-kpi">
        <div class="lf-kpi-icon" style="background:#f5f3ff;color:#7c3aed;"><el-icon><AlarmClock /></el-icon></div>
        <div class="lf-kpi-main">
          <div class="lf-kpi-label">近效期批次</div>
          <div class="lf-kpi-value">{{ expiringCount === null ? '—' : expiringCount }}<small>个</small></div>
          <div class="lf-kpi-foot">需优先出库</div>
        </div>
      </div>
    </div>

    <div class="lf-section">
      <div class="lf-section-head">
        <h3>每日打印量</h3>
        <span class="lf-hint">数据来源：GET /print/jobs/stats</span>
      </div>
      <div class="card" style="padding: 8px 12px 4px;">
        <div ref="chartRef" style="height: 300px;"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import { DataLine, CircleCheck, Timer, WarningFilled, AlarmClock } from '@element-plus/icons-vue';
import { apiPrintStats, apiAlertSummary, apiExpiringStock } from '@/api';

const days = ref(7);
const stats = ref<any>(null);
const alertCount = ref<number | null>(null);
const expiringCount = ref<number | null>(null);
const chartRef = ref<HTMLDivElement>();
let chart: any = null;
let echartsLib: any = null;

/** 从后端各种形状的响应里取一个「条数」，取不到就返回 null（宁可显示 — 也不编数字） */
function pickCount(res: any): number | null {
  if (res == null) return null;
  if (Array.isArray(res)) return res.length;
  if (typeof res === 'number') return res;
  if (typeof res === 'object') {
    for (const k of ['total', 'count', 'totalCount', 'n', 'totalEvents']) {
      if (typeof res[k] === 'number') return res[k];
    }
    for (const k of ['items', 'list', 'rows', 'data', 'events']) {
      if (Array.isArray(res[k])) return res[k].length;
    }
  }
  return null;
}

async function ensureEcharts() {
  if (echartsLib) return echartsLib;
  const [core, charts, comps, renderers] = await Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers'),
  ]);
  core.use([charts.BarChart, comps.GridComponent, comps.TooltipComponent, renderers.CanvasRenderer]);
  echartsLib = core;
  return echartsLib;
}

function onResize() { chart?.resize(); }

async function load() {
  const [s, a, e] = await Promise.allSettled([
    apiPrintStats(days.value),
    apiAlertSummary(),
    apiExpiringStock(),
  ]);
  stats.value = s.status === 'fulfilled' ? (s.value as any) : null;
  alertCount.value = a.status === 'fulfilled' ? pickCount(a.value) : null;
  expiringCount.value = e.status === 'fulfilled' ? pickCount(e.value) : null;
  await nextTick();
  renderChart();
}

async function renderChart() {
  if (!chartRef.value) return;
  const echarts = await ensureEcharts();
  chart?.dispose();
  chart = echarts.init(chartRef.value);
  const byDay: Record<string, number> = stats.value?.byDay || {};
  const dates = Object.keys(byDay).sort();
  chart.setOption({
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#0f172a',
      borderWidth: 0,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(37,99,235,.06)' } },
    },
    grid: { left: 48, right: 24, top: 24, bottom: 36 },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisTick: { show: false },
      axisLabel: { color: '#94a3b8', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: '任务数',
      nameTextStyle: { color: '#94a3b8', fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#f1f5f9' } },
      axisLabel: { color: '#94a3b8', fontSize: 11 },
    },
    series: [{
      type: 'bar',
      data: dates.map((d) => byDay[d]),
      barMaxWidth: 26,
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
          { offset: 0, color: '#3b82f6' }, { offset: 1, color: '#93b4f5' },
        ] },
      },
      emphasis: { itemStyle: { color: '#2563eb' } },
    }],
  });
}

onMounted(() => {
  load();
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});

watch(days, load);
</script>
