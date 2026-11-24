<template>
  <div class="page">
    <div class="page-head">
      <h2>UDI 追溯查询</h2>
      <div class="head-actions">
        <el-button :loading="loading" @click="loadUnits">刷新台账</el-button>
        <el-button type="primary" @click="exportUnits">导出台账 CSV</el-button>
      </div>
    </div>

    <!-- 一码追溯 -->
    <el-card shadow="never" class="block">
      <div class="trace-bar">
        <el-input v-model="code" clearable
                  placeholder="扫/粘贴：UDI 码（(01)…(21)…）、SSCC 18 位、或单品键"
                  style="flex:1" @keyup.enter="doTrace" />
        <el-button type="primary" :loading="tracing" @click="doTrace">追溯</el-button>
      </div>
      <div class="hint">
        正向：生产/打印 → 收货；反向：发料/出库/退料。支持托盘 → 中包 → 单品的父子层级。
      </div>

      <div v-if="traceErr" class="err">{{ traceErr }}</div>

      <div v-if="trace" class="trace-result">
        <el-descriptions :column="4" border size="small">
          <el-descriptions-item label="对象">{{ trace.found === 'unit' ? 'UDI 单品' : '包装' }}</el-descriptions-item>
          <el-descriptions-item label="GTIN(DI)">{{ trace.unit?.gtin || trace.package?.gtin || '—' }}</el-descriptions-item>
          <el-descriptions-item label="批号">{{ trace.unit?.lot || '—' }}</el-descriptions-item>
          <el-descriptions-item label="序列号">{{ trace.unit?.serial || '—' }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusType(trace.unit?.status)" size="small">{{ trace.unit?.status || '—' }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="有效期">{{ trace.unit?.expiry || '—' }}</el-descriptions-item>
          <el-descriptions-item label="包装 SSCC">{{ trace.unit?.packageSscc || trace.package?.sscc || '—' }}</el-descriptions-item>
          <el-descriptions-item label="工单">{{ trace.unit?.workOrderNo || '—' }}</el-descriptions-item>
        </el-descriptions>

        <el-row :gutter="12" class="mini-stats" v-if="trace.reverse">
          <el-col :span="8"><el-card shadow="never"><div class="mini"><span>发料次数</span><b>{{ trace.reverse.issuedCount }}</b></div></el-card></el-col>
          <el-col :span="8"><el-card shadow="never"><div class="mini"><span>出库次数</span><b>{{ trace.reverse.shippedCount }}</b></div></el-card></el-col>
          <el-col :span="8"><el-card shadow="never"><div class="mini"><span>事件总数</span><b>{{ trace.timeline.length }}</b></div></el-card></el-col>
        </el-row>

        <div v-if="trace.hierarchy" class="hier">
          <div class="sub-title">包装层级</div>
          <div class="hier-line">
            <span class="chip">路径：</span>
            <el-tag v-for="(s, i) in trace.hierarchy.path" :key="s" size="small" :type="i === trace.hierarchy.path.length - 1 ? 'success' : 'info'" style="margin-right:6px">{{ s }}</el-tag>
          </div>
          <div class="hier-line" v-if="trace.hierarchy.children?.length">
            <span class="chip">子包装：</span>
            <el-tag v-for="c in trace.hierarchy.children" :key="c" size="small" style="margin-right:6px">{{ c }}</el-tag>
          </div>
          <div class="hier-line" v-if="trace.hierarchy.unitsInPackage?.length">
            <span class="chip">包内单元（{{ trace.hierarchy.unitsInPackage.length }}）：</span>
            <el-tag v-for="u in trace.hierarchy.unitsInPackage.slice(0, 20)" :key="u.udiKey" size="small" type="info" style="margin:2px">{{ u.serial || u.lot || u.udiKey }}</el-tag>
            <span v-if="trace.hierarchy.unitsInPackage.length > 20" class="hint">… 另有 {{ trace.hierarchy.unitsInPackage.length - 20 }} 个</span>
          </div>
        </div>

        <div class="sub-title">事件时间线</div>
        <el-table :data="trace.timeline" size="small" max-height="320" border>
          <el-table-column prop="occurredAt" label="时间" width="180">
            <template #default="{ row }">{{ fmt(row.occurredAt) }}</template>
          </el-table-column>
          <el-table-column prop="eventType" label="事件" width="110">
            <template #default="{ row }"><el-tag size="small" :type="eventType(row.eventType)">{{ row.eventType }}</el-tag></template>
          </el-table-column>
          <el-table-column label="状态变化" width="170">
            <template #default="{ row }">{{ row.statusBefore || '—' }} → {{ row.statusAfter || '—' }}</template>
          </el-table-column>
          <el-table-column prop="refType" label="单据类型" width="120" />
          <el-table-column prop="refNo" label="单据号" width="160" />
          <el-table-column label="备注">
            <template #default="{ row }">{{ detailText(row.detail) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

    <!-- 单元台账 -->
    <el-card shadow="never" class="block">
      <div class="filters">
        <el-input v-model="q.gtin" placeholder="GTIN" clearable style="width:170px" @keyup.enter="loadUnits" />
        <el-input v-model="q.lot" placeholder="批号" clearable style="width:150px" @keyup.enter="loadUnits" />
        <el-input v-model="q.workOrderNo" placeholder="工单号" clearable style="width:150px" @keyup.enter="loadUnits" />
        <el-select v-model="q.status" placeholder="全部状态" clearable style="width:140px">
          <el-option v-for="s in STATUSES" :key="s" :label="s" :value="s" />
        </el-select>
        <el-button type="primary" :loading="loading" @click="loadUnits">查询</el-button>
      </div>

      <el-table :data="units" size="small" border v-loading="loading" max-height="520">
        <el-table-column prop="gtin" label="GTIN(DI)" width="150" />
        <el-table-column prop="lot" label="批号" width="130" />
        <el-table-column prop="serial" label="序列号" width="130" />
        <el-table-column prop="expiry" label="有效期" width="110" />
        <el-table-column prop="status" label="状态" width="110">
          <template #default="{ row }"><el-tag size="small" :type="statusType(row.status)">{{ row.status }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="packageSscc" label="包装 SSCC" width="170" />
        <el-table-column prop="workOrderNo" label="工单" width="130" />
        <el-table-column prop="templateCode" label="模板" width="140" />
        <el-table-column label="打印时间" width="170">
          <template #default="{ row }">{{ row.printedAt ? fmt(row.printedAt) : '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="traceUnit(row)">追溯</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination background layout="total, prev, pager, next" :total="total"
                       :page-size="q.pageSize" :current-page="q.page" @current-change="onPage" />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { apiUdiTrace, apiUdiUnits, downloadCsvUrl, udiExportUrl, type UdiTraceResult, type UdiUnitRow } from '@/api';

const STATUSES = ['REGISTERED', 'PRINTED', 'RECEIVED', 'ISSUED', 'SHIPPED', 'VOID'];

const code = ref('');
const trace = ref<UdiTraceResult | null>(null);
const tracing = ref(false);
const traceErr = ref('');

const units = ref<UdiUnitRow[]>([]);
const total = ref(0);
const loading = ref(false);
const q = reactive<any>({ gtin: '', lot: '', workOrderNo: '', status: '', page: 1, pageSize: 50 });

async function doTrace() {
  const c = code.value.trim();
  if (!c) return;
  tracing.value = true;
  traceErr.value = '';
  try {
    trace.value = await apiUdiTrace(c);
  } catch (e: any) {
    trace.value = null;
    traceErr.value = e?.message || '追溯失败';
  } finally {
    tracing.value = false;
  }
}

function traceUnit(row: UdiUnitRow) {
  code.value = row.udiKey;
  void doTrace();
}

async function loadUnits() {
  loading.value = true;
  try {
    const r = await apiUdiUnits({ ...q, page: q.page, pageSize: q.pageSize });
    units.value = r.items;
    total.value = r.total;
  } catch (e: any) {
    ElMessage.error(e?.message || '加载台账失败');
  } finally {
    loading.value = false;
  }
}

function onPage(p: number) {
  q.page = p;
  void loadUnits();
}

function exportUnits() {
  const params: any = {};
  for (const k of ['gtin', 'lot', 'workOrderNo', 'status']) if (q[k]) params[k] = q[k];
  downloadCsvUrl(udiExportUrl('/udi/export/units.csv', params), 'udi-units.csv')
    .catch((e) => ElMessage.error(e?.message || '导出失败'));
}

function fmt(v?: string | null) {
  return v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—';
}
function statusType(s?: string | null) {
  return ({ REGISTERED: 'info', PRINTED: 'warning', RECEIVED: 'success', ISSUED: 'primary', SHIPPED: 'success', VOID: 'danger' } as any)[s || ''] || 'info';
}
function eventType(t: string) {
  return ({ PRINT: 'warning', PRINT_FAIL: 'danger', RECEIVE: 'success', ISSUE: 'primary', SHIP: 'success', RETURN: 'warning', VOID: 'danger', BUILD: 'info', REPACK: 'info' } as any)[t] || 'info';
}
function detailText(d: any) {
  if (!d) return '';
  return Object.entries(d).filter(([k]) => k !== 'templateCode').map(([k, v]) => `${k}=${v}`).join('，');
}

onMounted(loadUnits);
</script>

<style scoped>
.block { margin-bottom: 14px; }
.trace-bar { display: flex; gap: 10px; }
.hint { color: #909399; font-size: 12px; margin-top: 8px; }
.err { color: #f56c6c; font-size: 13px; margin-top: 8px; }
.trace-result { margin-top: 14px; }
.mini-stats { margin: 12px 0; }
.mini { display: flex; justify-content: space-between; font-size: 13px; }
.mini b { font-size: 18px; }
.hier { margin: 12px 0; }
.hier-line { margin: 6px 0; font-size: 13px; }
.chip { color: #606266; }
.sub-title { font-size: 13px; font-weight: 600; margin: 12px 0 8px; }
.filters { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.pager { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
