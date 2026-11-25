<template>
  <div class="page">
    <div class="page-head">
      <h2>检验单</h2>
      <div class="head-actions">
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" @click="openCreate">手工开单</el-button>
      </div>
    </div>

    <div class="hint" style="margin-bottom: 12px">
      来料（IQC）检验合格，批次才可领用；成品（FQC）检验合格<b>不等于</b>放行 —— 成品要再到「成品放行」由 QA 签批。
      物料若标了「需要检验」，收货后批次自动进「待检」，领料与发货都会被拦。
    </div>

    <el-row :gutter="10" class="cards">
      <el-col :span="6">
        <div class="card"><div class="n">{{ summary.inspections.waiting }}</div><div class="l">待判定</div></div>
      </el-col>
      <el-col :span="6">
        <div class="card"><div class="n">{{ summary.inspections.decidedToday }}</div><div class="l">今日已判定</div></div>
      </el-col>
      <el-col :span="6">
        <div class="card danger"><div class="n">{{ summary.inspections.failed }}</div><div class="l">累计不合格</div></div>
      </el-col>
      <el-col :span="6">
        <div class="card warn"><div class="n">{{ summary.inspections.pendingBatches }}</div><div class="l">待检批次</div></div>
      </el-col>
    </el-row>

    <el-tabs v-model="tab" style="margin-top: 14px">
      <el-tab-pane label="检验单" name="docs">
        <div class="filters">
          <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 130px" @change="load">
            <el-option label="待判定" value="DRAFT" />
            <el-option label="合格" value="PASS" />
            <el-option label="不合格" value="FAIL" />
            <el-option label="已作废" value="CANCELLED" />
          </el-select>
          <el-select v-model="query.inspType" placeholder="全部类型" clearable style="width: 150px" @change="load">
            <el-option label="来料 IQC" value="IQC" />
            <el-option label="过程 IPQC" value="IPQC" />
            <el-option label="成品 FQC" value="FQC" />
            <el-option label="出货 OQC" value="OQC" />
          </el-select>
          <el-input v-model="query.keyword" placeholder="单号 / 批次 / 物料" clearable style="width: 190px" @keyup.enter="load" />
          <el-button type="primary" @click="load">查询</el-button>
        </div>

        <el-table :data="rows" size="small" border v-loading="loading" empty-text="还没有检验单">
          <el-table-column prop="inspectionNo" label="单号" width="158" />
          <el-table-column label="类型" width="104">
            <template #default="{ row }"><el-tag size="small" type="info">{{ row.inspTypeText }}</el-tag></template>
          </el-table-column>
          <el-table-column label="物料" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">{{ row.skuCode }} · {{ row.materialName }}</template>
          </el-table-column>
          <el-table-column prop="batchNo" label="批次" width="124" />
          <el-table-column prop="warehouse" label="仓库" width="126" show-overflow-tooltip />
          <el-table-column label="受检/抽样" width="100">
            <template #default="{ row }">{{ row.qty }} / {{ row.sampleQty }}</template>
          </el-table-column>
          <el-table-column label="状态" width="92">
            <template #default="{ row }">
              <el-tag size="small" :type="docTag(row.status)">{{ row.statusText }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="76">
            <template #default="{ row }">
              <el-button link size="small" type="primary" @click="openDoc(row.id)">处理</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-pagination v-model:current-page="query.page" :page-size="query.pageSize" :total="total"
                       layout="total, prev, pager, next" style="margin-top: 10px" @current-change="load" />
      </el-tab-pane>

      <el-tab-pane label="待检批次" name="pending">
        <div class="filters">
          <el-button type="primary" :loading="autoLoading" @click="doAutoOpen">一键补开检验单</el-button>
          <el-button size="small" @click="loadPending">刷新</el-button>
          <span class="hint" style="margin: 0">扫描库存里所有「待检」批次，缺单的自动补开（一次最多 50 张）</span>
        </div>
        <el-table :data="pending" size="small" border empty-text="没有待检批次（收货时物料未标「需要检验」就不会进待检）">
          <el-table-column prop="skuCode" label="物料编码" width="130" />
          <el-table-column prop="materialName" label="名称" min-width="170" show-overflow-tooltip />
          <el-table-column prop="batchNo" label="批次" width="130" />
          <el-table-column prop="warehouse" label="仓库" width="140" show-overflow-tooltip />
          <el-table-column prop="qty" label="数量" width="90" />
          <el-table-column label="到期" width="100">
            <template #default="{ row }">{{ row.expiresAt || '-' }}</template>
          </el-table-column>
          <el-table-column label="检验单" width="110">
            <template #default="{ row }">
              <el-tag v-if="row.hasDraft" size="small" type="warning">已有待判定单</el-tag>
              <el-tag v-else size="small" type="danger">未开单</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90">
            <template #default="{ row }">
              <el-button link size="small" type="primary" :disabled="row.hasDraft" @click="openCreateFor(row)">开单</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- ==================== 检验单详情 ==================== -->
    <el-drawer v-model="docDrawer" :title="doc?.inspectionNo || '检验单'" size="760px">
      <div v-if="doc">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="类型">{{ doc.inspTypeText }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="docTag(doc.status)">{{ doc.statusText }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="物料">{{ doc.skuCode }} · {{ doc.materialName }}</el-descriptions-item>
          <el-descriptions-item label="仓库">{{ doc.warehouse }}</el-descriptions-item>
          <el-descriptions-item label="批次">{{ doc.batchNo }}</el-descriptions-item>
          <el-descriptions-item label="批次库存 / 质量状态">
            {{ doc.batchQty }} {{ doc.unit }} · {{ qcText(doc.batchQualityStatus) }}
          </el-descriptions-item>
          <el-descriptions-item label="受检数量">{{ doc.qty }}</el-descriptions-item>
          <el-descriptions-item label="抽样数">{{ doc.sampleQty }}</el-descriptions-item>
          <el-descriptions-item label="复核人">{{ doc.reviewer || '-' }}</el-descriptions-item>
          <el-descriptions-item label="判定时间">{{ doc.reviewedAt ? fmtTime(doc.reviewedAt) : '-' }}</el-descriptions-item>
        </el-descriptions>

        <div class="sec-title">检验项目（全项 PASS 才能判合格；判不合格必须至少记一条 FAIL）</div>
        <el-table :data="doc.items" size="small" border empty-text="还没有检验项，请先录入">
          <el-table-column prop="seq" label="#" width="46" />
          <el-table-column prop="itemName" label="项目" width="120" />
          <el-table-column prop="standard" label="标准/接收准则" width="150" show-overflow-tooltip />
          <el-table-column prop="measured" label="实测" width="130" show-overflow-tooltip />
          <el-table-column label="判定" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.verdict === 'PASS' ? 'success' : row.verdict === 'FAIL' ? 'danger' : 'info'">
                {{ row.verdict }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
        </el-table>

        <div v-if="doc.status === 'DRAFT'" style="margin-top: 14px">
          <div class="sec-title">录入 / 修改检验项</div>
          <el-table :data="editItems" size="small" border>
            <el-table-column label="项目" width="130">
              <template #default="{ row }"><el-input v-model="row.itemName" size="small" placeholder="外观/尺寸" /></template>
            </el-table-column>
            <el-table-column label="标准" width="150">
              <template #default="{ row }"><el-input v-model="row.standard" size="small" /></template>
            </el-table-column>
            <el-table-column label="实测" width="130">
              <template #default="{ row }"><el-input v-model="row.measured" size="small" /></template>
            </el-table-column>
            <el-table-column label="判定" width="100">
              <template #default="{ row }">
                <el-select v-model="row.verdict" size="small" style="width: 100%">
                  <el-option label="PASS" value="PASS" />
                  <el-option label="FAIL" value="FAIL" />
                  <el-option label="NA" value="NA" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="70">
              <template #default="{ $index }">
                <el-button link size="small" type="danger" @click="editItems.splice($index, 1)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div style="margin: 8px 0">
            <el-button size="small" plain @click="addItem">+ 加一项</el-button>
            <el-button size="small" @click="fillTemplate">填常用三项（外观/尺寸/密封性）</el-button>
            <el-button size="small" type="primary" :loading="saving" @click="saveItems">保存检验项</el-button>
          </div>

          <div class="sec-title">判定</div>
          <el-form label-width="76px" size="small">
            <el-form-item label="复核人">
              <el-input v-model="judgeForm.reviewer" placeholder="检验判定人姓名" style="width: 220px" />
            </el-form-item>
            <el-form-item label="结论意见">
              <el-input v-model="judgeForm.opinion" type="textarea" :rows="2" placeholder="合格可写「三项均合格」；不合格必须写不合格事实与处置建议" />
            </el-form-item>
          </el-form>
          <div>
            <el-button type="success" :loading="judging" @click="doJudge('PASS')">判定合格（批次转合格，可出库）</el-button>
            <el-button type="danger" :loading="judging" @click="doJudge('FAIL')">判定不合格（批次隔离）</el-button>
            <el-button plain @click="doCancel">作废本单</el-button>
          </div>
          <div class="hint" style="margin-top: 8px">
            成品检验（FQC）判合格后批次仍是「待检/待放行」，不会直接变成可售 —— 这是 GMP 的「未经放行不得上市销售」。
          </div>
        </div>
      </div>
    </el-drawer>

    <!-- ==================== 手工开单 ==================== -->
    <el-dialog v-model="createDialog" title="手工开检验单" width="560px" append-to-body>
      <el-form :model="form" label-width="90px" size="small">
        <el-form-item label="检验类型">
          <el-select v-model="form.inspType" style="width: 100%">
            <el-option label="来料检验 IQC" value="IQC" />
            <el-option label="过程检验 IPQC" value="IPQC" />
            <el-option label="成品检验 FQC" value="FQC" />
            <el-option label="出货检验 OQC" value="OQC" />
          </el-select>
        </el-form-item>
        <el-form-item label="物料">
          <el-select v-model="form.skuCode" filterable style="width: 100%" placeholder="选择物料">
            <el-option v-for="m in materials" :key="m.code" :label="`${m.code} · ${m.name}`" :value="m.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="仓库">
          <el-select v-model="form.warehouseId" style="width: 100%">
            <el-option v-for="w in warehouses" :key="w.id" :label="`${w.code} · ${w.name}`" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="批次号">
          <el-input v-model="form.batchNo" placeholder="必须是在库批次" />
        </el-form-item>
        <el-form-item label="受检数量">
          <el-input-number v-model="form.qty" :min="0" style="width: 100%" />
        </el-form-item>
        <el-form-item label="抽样数">
          <el-input-number v-model="form.sampleQty" :min="0" style="width: 100%" />
        </el-form-item>
        <el-form-item label="检验员">
          <el-input v-model="form.inspector" placeholder="可留空，判定时再填复核人" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="doCreate">开单</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiInventoryMaterials, apiInventoryWarehouses } from '@/api';
import {
  apiAutoOpen, apiCancelInspection, apiCreateInspection, apiGetInspection, apiJudge,
  apiListInspections, apiPendingBatches, apiQualitySummary, apiSaveItems,
} from '@/api/quality';

const loading = ref(false);
const tab = ref<'docs' | 'pending'>('docs');
const rows = ref<any[]>([]);
const total = ref(0);
const query = reactive({ status: '', inspType: '', keyword: '', page: 1, pageSize: 20 });
const summary = ref<any>({ inspections: { waiting: 0, decidedToday: 0, failed: 0, pendingBatches: 0 }, releases: {}, records: {} });

const pending = ref<any[]>([]);
const autoLoading = ref(false);

const docDrawer = ref(false);
const doc = ref<any>(null);
const editItems = ref<any[]>([]);
const saving = ref(false);
const judging = ref(false);
const judgeForm = reactive({ reviewer: '', opinion: '' });

const createDialog = ref(false);
const creating = ref(false);
const materials = ref<any[]>([]);
const warehouses = ref<any[]>([]);
const form = reactive<any>({ inspType: 'IQC', skuCode: '', warehouseId: null, batchNo: '', qty: 0, sampleQty: 0, inspector: '' });

const docTag = (s: string) => (s === 'PASS' ? 'success' : s === 'FAIL' ? 'danger' : s === 'CANCELLED' ? 'info' : 'warning');
const qcText = (s: string | null) =>
  ({ PENDING: '待检', RELEASED: '合格', REJECTED: '不合格', FROZEN: '冻结' } as Record<string, string>)[String(s)] || '-';
const fmtTime = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-');

async function loadSummary() {
  try { summary.value = await apiQualitySummary(); } catch { /* 拦截器已提示 */ }
}

async function load() {
  loading.value = true;
  try {
    const res: any = await apiListInspections({ ...query });
    rows.value = res.items || [];
    total.value = res.total || 0;
  } catch { /* 拦截器已提示 */ } finally { loading.value = false; }
}

async function loadPending() {
  try { pending.value = (await apiPendingBatches()) || []; } catch { /* */ }
}

async function openDoc(id: number) {
  try {
    doc.value = await apiGetInspection(id);
    editItems.value = (doc.value.items || []).map((i: any) => ({
      itemName: i.itemName, standard: i.standard, measured: i.measured, verdict: i.verdict, remark: i.remark,
    }));
    if (!editItems.value.length) addItem();
    judgeForm.reviewer = doc.value.reviewer || '';
    judgeForm.opinion = doc.value.opinion || '';
    docDrawer.value = true;
  } catch { /* */ }
}

function addItem() {
  editItems.value.push({ itemName: '', standard: '', measured: '', verdict: 'PASS', remark: '' });
}

function fillTemplate() {
  editItems.value = [
    { itemName: '外观', standard: '无破损、无污染', measured: '', verdict: 'PASS', remark: '' },
    { itemName: '尺寸', standard: '符合图纸公差', measured: '', verdict: 'PASS', remark: '' },
    { itemName: '密封性', standard: '无泄漏', measured: '', verdict: 'PASS', remark: '' },
  ];
}

async function saveItems() {
  saving.value = true;
  try {
    const keep = editItems.value.filter((i) => String(i.itemName || '').trim());
    if (!keep.length) { ElMessage.warning('至少填一项检验项目名称'); return; }
    doc.value = await apiSaveItems(doc.value.id, keep);
    ElMessage.success('检验项已保存');
  } catch { /* */ } finally { saving.value = false; }
}

async function doJudge(result: 'PASS' | 'FAIL') {
  try {
    if (result === 'PASS' && editItems.value.some((i) => String(i.itemName || '').trim())) {
      await apiSaveItems(doc.value.id, editItems.value.filter((i) => String(i.itemName || '').trim()));
    }
    await ElMessageBox.confirm(
      result === 'PASS'
        ? '判定为合格？来料/过程检验会把批次转为「合格」可出库；成品检验只到「待放行」，还要 QA 签批。'
        : '判定为不合格？批次将转为「不合格」并隔离，只能走报废处置。',
      result === 'PASS' ? '判定合格' : '判定不合格',
      { type: 'warning' },
    );
    judging.value = true;
    doc.value = await apiJudge(doc.value.id, { result, reviewer: judgeForm.reviewer, opinion: judgeForm.opinion });
    ElMessage.success(result === 'PASS' ? '已判合格' : '已判不合格，批次已隔离');
    await Promise.all([load(), loadPending(), loadSummary()]);
  } catch (e: any) {
    if (e !== 'cancel') { /* 拦截器已提示 */ }
  } finally { judging.value = false; }
}

async function doCancel() {
  try {
    const { value } = await ElMessageBox.prompt('作废原因（必填）', '作废检验单', { inputPlaceholder: '如：重复开单' });
    doc.value = await apiCancelInspection(doc.value.id, value || '');
    ElMessage.success('已作废');
    await Promise.all([load(), loadPending(), loadSummary()]);
  } catch { /* */ }
}

function openCreate() {
  Object.assign(form, { inspType: 'IQC', skuCode: '', warehouseId: warehouses.value[0]?.id ?? null, batchNo: '', qty: 0, sampleQty: 0, inspector: '' });
  createDialog.value = true;
}

function openCreateFor(row: any) {
  Object.assign(form, {
    inspType: 'IQC', skuCode: row.skuCode, warehouseId: row.warehouseId,
    batchNo: row.batchNo, qty: row.qty, sampleQty: 0, inspector: '',
  });
  createDialog.value = true;
}

async function doCreate() {
  creating.value = true;
  try {
    const d: any = await apiCreateInspection({ ...form });
    createDialog.value = false;
    ElMessage.success(`已开单 ${d.inspectionNo}`);
    await Promise.all([load(), loadPending(), loadSummary()]);
    openDoc(d.id);
  } catch { /* */ } finally { creating.value = false; }
}

async function doAutoOpen() {
  autoLoading.value = true;
  try {
    const r: any = await apiAutoOpen();
    ElMessage.success(r.created ? `补开 ${r.created} 张检验单` : `没有需要补开的批次（扫描 ${r.scanned} 个待检批次）`);
    await Promise.all([load(), loadPending(), loadSummary()]);
  } catch { /* */ } finally { autoLoading.value = false; }
}

onMounted(async () => {
  await Promise.all([load(), loadPending(), loadSummary()]);
  try {
    const [ws, ms] = await Promise.all([apiInventoryWarehouses(), apiInventoryMaterials()]);
    warehouses.value = ws || [];
    materials.value = ms || [];
  } catch { /* */ }
});
</script>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.page-head h2 { margin: 0; font-size: 18px; }
.head-actions { display: flex; gap: 8px; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.hint { color: #64748b; font-size: 12.5px; line-height: 1.7; }
.cards { margin-bottom: 6px; }
.card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; background: #f8fafc; }
.card .n { font-size: 22px; font-weight: 700; color: #0f172a; }
.card .l { font-size: 12px; color: #64748b; margin-top: 2px; }
.card.danger .n { color: #b91c1c; }
.card.warn .n { color: #b45309; }
.sec-title { font-size: 13px; font-weight: 700; margin: 16px 0 8px; color: #0f172a; }
</style>
