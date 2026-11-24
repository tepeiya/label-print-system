<template>
  <div class="page">
    <div class="page-head">
      <h2>UDI 合规留痕</h2>
      <div class="head-actions">
        <el-button :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" @click="exportAudit">导出留痕报表 CSV</el-button>
      </div>
    </div>

    <div class="filters">
      <el-date-picker v-model="range" type="daterange" start-placeholder="开始日期" end-placeholder="结束日期"
                      value-format="YYYY-MM-DD" style="width: 260px" />
      <el-input v-model="templateCode" placeholder="模板 code（可空）" clearable style="width: 190px" />
      <el-button type="primary" :loading="loading" @click="load">统计</el-button>
      <span class="hint">留痕数据源：udi_events 的 PRINT / PRINT_FAIL（每次打印与每次失败都留痕）</span>
    </div>

    <el-row :gutter="12" class="stat-row">
      <el-col :span="6"><el-card shadow="never"><div class="stat"><div class="stat-label">打印成功</div><div class="stat-value">{{ data?.totals.printed ?? 0 }}</div></div></el-card></el-col>
      <el-col :span="6"><el-card shadow="never" :class="{ bad: (data?.totals.failed ?? 0) > 0 }"><div class="stat"><div class="stat-label">打印失败</div><div class="stat-value">{{ data?.totals.failed ?? 0 }}</div></div></el-card></el-col>
      <el-col :span="6"><el-card shadow="never"><div class="stat"><div class="stat-label">涉及单元</div><div class="stat-value">{{ data?.totals.units ?? 0 }}</div></div></el-card></el-col>
      <el-col :span="6"><el-card shadow="never"><div class="stat"><div class="stat-label">事件总数</div><div class="stat-value">{{ data?.totalEvents ?? 0 }}</div></div></el-card></el-col>
    </el-row>

    <el-tabs v-model="tab">
      <el-tab-pane label="按天" name="day">
        <el-table :data="data?.byDay ?? []" size="small" border v-loading="loading">
          <el-table-column prop="day" label="日期" width="140" />
          <el-table-column prop="printed" label="打印成功" width="120" />
          <el-table-column prop="failed" label="打印失败" width="120" />
          <el-table-column prop="units" label="涉及单元数" width="120" />
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="按模板" name="tpl">
        <el-table :data="data?.byTemplate ?? []" size="small" border v-loading="loading">
          <el-table-column prop="templateCode" label="模板" width="220" />
          <el-table-column prop="printed" label="打印成功" width="120" />
          <el-table-column prop="failed" label="打印失败" width="120" />
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="真机适配" name="printer">
        <el-table :data="profiles?.profiles ?? []" size="small" border>
          <el-table-column prop="vendor" label="厂商" width="120" />
          <el-table-column prop="model" label="机型" width="200" />
          <el-table-column label="分辨率" width="120">
            <template #default="{ row }">{{ (row.dpi || []).join(' / ') }} dpi</template>
          </el-table-column>
          <el-table-column prop="minModuleMm" label="最小模块 mm" width="120" />
          <el-table-column label="适配状态" width="120">
            <template #default="{ row }"><el-tag size="small" :type="row.status === 'SITE_VERIFIED' ? 'success' : 'warning'">{{ row.status }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="notes" label="现场注意事项" />
        </el-table>
        <div class="hint" style="margin-top:10px">
          校准清单见 <code>GET /api/v1/udi/printer-profiles</code> 的 calibration 段；POC 机型必须现场出样张并签字后才可交付。
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { apiUdiPrintAudit, apiUdiPrinterProfiles, downloadCsvUrl, udiExportUrl, type UdiPrintAudit } from '@/api';

const range = ref<[string, string] | null>(null);
const templateCode = ref('');
const tab = ref('day');
const loading = ref(false);
const data = ref<UdiPrintAudit | null>(null);
const profiles = ref<any>(null);

async function load() {
  loading.value = true;
  try {
    const params: any = {};
    if (range.value?.[0]) params.since = range.value[0];
    if (range.value?.[1]) params.until = `${range.value[1]}T23:59:59`;
    if (templateCode.value) params.templateCode = templateCode.value;
    data.value = await apiUdiPrintAudit(params);
  } catch (e: any) {
    ElMessage.error(e?.message || '加载留痕报表失败');
  } finally {
    loading.value = false;
  }
}

function exportAudit() {
  const params: any = {};
  if (range.value?.[0]) params.since = range.value[0];
  if (range.value?.[1]) params.until = `${range.value[1]}T23:59:59`;
  if (templateCode.value) params.templateCode = templateCode.value;
  downloadCsvUrl(udiExportUrl('/udi/export/print-audit.csv', params), 'udi-print-audit.csv')
    .catch((e) => ElMessage.error(e?.message || '导出失败'));
}

onMounted(async () => {
  await load();
  try {
    profiles.value = await apiUdiPrinterProfiles();
  } catch { /* 适配矩阵取不到不影响报表 */ }
});
</script>

<style scoped>
.filters { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.hint { color: #909399; font-size: 12px; }
.stat-row { margin-bottom: 12px; }
.stat { display: flex; flex-direction: column; gap: 4px; }
.stat-label { color: #909399; font-size: 12px; }
.stat-value { font-size: 26px; font-weight: 600; }
.bad .stat-value { color: #f56c6c; }
</style>
