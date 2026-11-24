<template>
  <div>
    <div class="page-header">
      <h2>📊 仪表盘</h2>
      <el-tag type="info">最近 {{ days }} 天</el-tag>
    </div>
    <div class="stat-grid" v-if="stats">
      <div class="stat-card">
        <div class="label">打印任务总数</div>
        <div class="value">{{ stats.total || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">成功率</div>
        <div class="value">{{ ((stats.successRate || 0) * 100).toFixed(1) }}%</div>
      </div>
      <div class="stat-card">
        <div class="label">成功 / 失败</div>
        <div class="value">{{ stats.counts?.success || 0 }} / {{ stats.counts?.failed || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">平均耗时</div>
        <div class="value">{{ ((stats.avgDurationMs || 0) / 1000).toFixed(1) }}s</div>
      </div>
    </div>
    <div class="card" style="margin-top: 20px;" v-if="stats?.byDay">
      <h3 style="margin-top: 0;">每日任务量</h3>
      <div ref="chartRef" style="height: 280px;"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
// echarts 走运行时动态加载：仪表盘首屏先出统计卡，图表稍后到，不阻塞首屏。
// 只用 bar + grid + tooltip + canvas，避免整包（原整包引入让本页 chunk 到 1.1MB）。
import { apiPrintStats } from '@/api';

const days = ref(7);
const stats = ref<any>(null);
const chartRef = ref<HTMLDivElement>();
let chart: any = null;
let echartsLib: any = null;

/** 首次渲染时才拉 echarts（动态 chunk），之后复用 */
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
  stats.value = await apiPrintStats(days.value);
  await nextTick();
  renderChart();
}

async function renderChart() {
  if (!chartRef.value) return;
  const echarts = await ensureEcharts();
  // 切换天数会重复渲染，先回收旧实例，避免同 DOM 上叠加多个 canvas 造成内存泄漏
  chart?.dispose();
  chart = echarts.init(chartRef.value);
  const byDay: Record<string, number> = stats.value?.byDay || {};
  const dates = Object.keys(byDay).sort();
  chart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 20, bottom: 30 },
    xAxis: { type: 'category', data: dates, axisLabel: { rotate: 30 } },
    yAxis: { type: 'value', name: '任务数' },
    series: [{ type: 'bar', data: dates.map((d) => byDay[d]), itemStyle: { color: '#1a73e8' } }],
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
