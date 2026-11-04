<template>
  <div>
    <div class="page-header">
      <h2>📊 仪表盘</h2>
      <el-tag type="info">最近 {{ days }} 天</el-tag>
    </div>
    <div class="stat-grid" v-if="stats">
      <div class="stat-card">
        <div class="label">打印任务总数</div>
        <div class="value">{{ stats.total }}</div>
      </div>
      <div class="stat-card">
        <div class="label">成功率</div>
        <div class="value">{{ (stats.successRate * 100).toFixed(1) }}%</div>
      </div>
      <div class="stat-card">
        <div class="label">成功 / 失败</div>
        <div class="value">{{ stats.byStatus?.success || 0 }} / {{ stats.byStatus?.failed || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="label">平均耗时</div>
        <div class="value">{{ (stats.avgDurationMs / 1000).toFixed(1) }}s</div>
      </div>
    </div>
    <div class="card" style="margin-top: 20px;" v-if="stats?.byDay">
      <h3 style="margin-top: 0;">每日任务量</h3>
      <div ref="chartRef" style="height: 280px;"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch, nextTick } from 'vue';
import * as echarts from 'echarts';
import { apiPrintStats } from '@/api';

const days = ref(7);
const stats = ref<any>(null);
const chartRef = ref<HTMLDivElement>();
let chart: echarts.ECharts | null = null;

async function load() {
  stats.value = await apiPrintStats(days.value);
  await nextTick();
  renderChart();
}

function renderChart() {
  if (!chartRef.value) return;
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

onMounted(load);
watch(days, load);
</script>
