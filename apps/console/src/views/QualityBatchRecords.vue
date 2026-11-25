<template>
  <div class="page">
    <div class="page-head">
      <h2>批记录</h2>
      <div class="head-actions">
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" @click="openCreate">开批记录</el-button>
      </div>
    </div>

    <div class="hint" style="margin-bottom: 12px">
      飞检第一份材料。一批一条记录：工序顺序、设备、操作人、时间、工艺参数、结果，外加这批货打了多少码、有几张检验单。
      工序有 FAIL 必须写备注；批记录提交后由质量批准，批准后才能进放行申请。
    </div>

    <el-row :gutter="10" class="cards">
      <el-col :span="8"><div class="card"><div class="n">{{ summary.records.open }}</div><div class="l">记录中</div></div></el-col>
      <el-col :span="8"><div class="card warn"><div class="n">{{ summary.records.submitted }}</div><div class="l">待批准</div></div></el-col>
      <el-col :span="8"><div class="card"><div class="n">{{ summary.records.approved }}</div><div class="l">已批准</div></div></el-col>
    </el-row>

    <div class="filters" style="margin-top: 12px">
      <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 140px" @change="load">
        <el-option label="记录中" value="OPEN" />
        <el-option label="已提交" value="SUBMITTED" />
        <el-option label="已批准" value="APPROVED" />
        <el-option label="已退回" value="REJECTED" />
      </el-select>
      <el-input v-model="query.keyword" placeholder="记录号 / 批次 / 物料" clearable style="width: 200px" @keyup.enter="load" />
      <el-button type="primary" @click="load">查询</el-button>
    </div>

    <el-table :data="rows" size="small" border v-loading="loading" empty-text="还没有批记录">
      <el-table-column prop="recordNo" label="记录号" width="150" />
      <el-table-column label="产品" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ row.skuCode }} · {{ row.productName || '' }}</template>
      </el-table-column>
      <el-table-column prop="batchNo" label="批次" width="130" />
      <el-table-column prop="woNo" label="工单" width="120">
        <template #default="{ row }">{{ row.woNo || '-' }}</template>
      </el-table-column>
      <el-table-column label="工序" width="90">
        <template #default="{ row }">
          {{ row.stepCount }} 道<span v-if="row.failSteps" class="fail">（{{ row.failSteps }} 失败）</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="96">
        <template #default="{ row }">
          <el-tag size="small" :type="brTag(row.status)">{{ row.statusText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="86">
        <template #default="{ row }">
          <el-button link size="small" type="primary" @click="openDoc(row.id)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination v-model:current-page="query.page" :page-size="query.pageSize" :total="total"
                   layout="total, prev, pager, next" style="margin-top: 10px" @current-change="load" />

    <!-- ==================== 详情 ==================== -->
    <el-drawer v-model="docDrawer" :title="doc?.recordNo || '批记录'" size="860px">
      <div v-if="doc">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="brTag(doc.status)">{{ doc.statusText }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="工单">{{ doc.woNo || '-' }}</el-descriptions-item>
          <el-descriptions-item label="产品">{{ doc.skuCode }} · {{ doc.productName }}</el-descriptions-item>
          <el-descriptions-item label="批次">{{ doc.batchNo }}</el-descriptions-item>
          <el-descriptions-item label="计划数量">{{ doc.qtyPlanned }}</el-descriptions-item>
          <el-descriptions-item label="实际数量">{{ doc.qtyActual ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="开始记录">{{ doc.openedAt ? fmtTime(doc.openedAt) : '-' }}</el-descriptions-item>
          <el-descriptions-item label="提交时间">{{ doc.submittedAt ? fmtTime(doc.submittedAt) : '-' }}</el-descriptions-item>
          <el-descriptions-item label="质量意见" :span="2">{{ doc.approvalOpinion || '-' }}</el-descriptions-item>
        </el-descriptions>

        <div class="evidence">
          <span>关联证据：</span>
          <el-tag size="small" type="info">UDI 码 {{ doc.evidence?.udiUnits ?? 0 }} 个（已打印 {{ doc.evidence?.udiPrinted ?? 0 }}）</el-tag>
          <el-tag size="small" type="info">检验单 {{ doc.evidence?.inspectionCount ?? 0 }} 张</el-tag>
          <span class="muted" v-if="doc.evidence?.inspectionNos?.length">{{ doc.evidence.inspectionNos.join('、') }}</span>
        </div>

        <div class="sec-title">工序记录（{{ doc.steps.length }} 道）</div>
        <el-table :data="doc.steps" size="small" border empty-text="还没有工序，请添加">
          <el-table-column prop="seq" label="#" width="44" />
          <el-table-column prop="stepName" label="工序" width="100" />
          <el-table-column prop="equipment" label="设备" width="110">
            <template #default="{ row }">{{ row.equipment || '-' }}</template>
          </el-table-column>
          <el-table-column prop="operator" label="操作人" width="100" />
          <el-table-column label="时间" width="180">
            <template #default="{ row }">
              <span class="muted">{{ row.startedAt ? shortTime(row.startedAt) : '-' }} → {{ row.endedAt ? shortTime(row.endedAt) : '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="参数" min-width="150">
            <template #default="{ row }">
              <span class="muted">{{ paramsText(row.params) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="结果" width="76">
            <template #default="{ row }">
              <el-tag size="small" :type="row.result === 'PASS' ? 'success' : row.result === 'FAIL' ? 'danger' : 'info'">{{ row.result }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.remark || '-' }}</template>
          </el-table-column>
          <el-table-column v-if="doc.status === 'OPEN' || doc.status === 'REJECTED'" label="操作" width="66">
            <template #default="{ row }">
              <el-button link size="small" type="danger" @click="removeStep(row)">删</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="doc.status === 'OPEN' || doc.status === 'REJECTED'" style="margin-top: 12px">
          <div class="sec-title">添加工序</div>
          <el-form :model="stepForm" label-width="76px" size="small">
            <el-row :gutter="10">
              <el-col :span="8"><el-form-item label="工序"><el-input v-model="stepForm.stepName" placeholder="配料/注塑/灭菌" /></el-form-item></el-col>
              <el-col :span="8"><el-form-item label="设备"><el-input v-model="stepForm.equipment" placeholder="设备编号" /></el-form-item></el-col>
              <el-col :span="8"><el-form-item label="操作人"><el-input v-model="stepForm.operator" placeholder="姓名" /></el-form-item></el-col>
            </el-row>
            <el-row :gutter="10">
              <el-col :span="8">
                <el-form-item label="开始">
                  <el-date-picker v-model="stepForm.startedAt" type="datetime" style="width: 100%" value-format="YYYY-MM-DDTHH:mm:ss+08:00" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="结束">
                  <el-date-picker v-model="stepForm.endedAt" type="datetime" style="width: 100%" value-format="YYYY-MM-DDTHH:mm:ss+08:00" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="结果">
                  <el-select v-model="stepForm.result" style="width: 100%">
                    <el-option label="PASS" value="PASS" />
                    <el-option label="FAIL" value="FAIL" />
                    <el-option label="NA" value="NA" />
                  </el-select>
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="工艺参数">
              <el-input v-model="stepForm.paramsText" placeholder='JSON 或 "温度:85℃, 压力:60bar"' />
            </el-form-item>
            <el-form-item label="备注">
              <el-input v-model="stepForm.remark" placeholder="FAIL 必须写明不合格事实" />
            </el-form-item>
          </el-form>
          <el-button size="small" type="primary" plain :loading="stepLoading" @click="addStep">+ 添加这道工序</el-button>
        </div>

        <div v-if="doc.status === 'OPEN' || doc.status === 'REJECTED'" style="margin-top: 16px">
          <div v-if="!doc.canSubmit && doc.status === 'OPEN'" class="block">还不能提交：{{ doc.submitBlockReason }}</div>
          <el-button type="primary" :loading="submitting" @click="doSubmit">提交批记录</el-button>
        </div>

        <div v-if="doc.status === 'SUBMITTED'" style="margin-top: 16px">
          <div class="sec-title">质量批准</div>
          <el-input v-model="approveOpinion" type="textarea" :rows="2" placeholder="批准意见 / 退回原因（退回必填）" />
          <div style="margin-top: 8px">
            <el-button type="success" :loading="approving" @click="doApprove('APPROVE')">批准</el-button>
            <el-button type="danger" :loading="approving" @click="doApprove('REJECT')">退回修改</el-button>
          </div>
        </div>
      </div>
    </el-drawer>

    <!-- ==================== 开单 ==================== -->
    <el-dialog v-model="createDialog" title="开批记录" width="560px" append-to-body>
      <el-form :model="form" label-width="96px" size="small">
        <el-form-item label="关联工单（可选）">
          <el-select v-model="form.workOrderId" clearable filterable style="width: 100%" placeholder="选工单会自动带出产品与数量">
            <el-option v-for="w in workOrders" :key="w.id" :label="`${w.woNo}（产品 ${w.productMaterialId}，需求 ${w.demandQty}）`" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="产品物料">
          <el-select v-model="form.skuCode" filterable clearable style="width: 100%" placeholder="不选工单时手工选产品">
            <el-option v-for="m in materials" :key="m.code" :label="`${m.code} · ${m.name}`" :value="m.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="批次号">
          <el-input v-model="form.batchNo" placeholder="与赋码、放行保持同一批次" />
        </el-form-item>
        <el-form-item label="计划数量">
          <el-input-number v-model="form.qtyPlanned" :min="0" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" />
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
import { apiInventoryMaterials } from '@/api';
import { apiWmsWorkOrders } from '@/api/wms';
import {
  apiAddStep, apiApproveRecord, apiCreateRecord, apiDeleteStep, apiGetRecord, apiListRecords,
  apiQualitySummary, apiSubmitRecord,
} from '@/api/quality';

const loading = ref(false);
const rows = ref<any[]>([]);
const total = ref(0);
const query = reactive({ status: '', keyword: '', page: 1, pageSize: 20 });
const summary = ref<any>({ records: { open: 0, submitted: 0, approved: 0 } });

const docDrawer = ref(false);
const doc = ref<any>(null);
const stepLoading = ref(false);
const submitting = ref(false);
const approving = ref(false);
const approveOpinion = ref('');

const stepForm = reactive<any>({ stepName: '', equipment: '', operator: '', startedAt: null, endedAt: null, result: 'PASS', paramsText: '', remark: '' });

const createDialog = ref(false);
const creating = ref(false);
const materials = ref<any[]>([]);
const workOrders = ref<any[]>([]);
const form = reactive<any>({ workOrderId: null, skuCode: '', batchNo: '', qtyPlanned: 0, remark: '' });

const brTag = (s: string) => (s === 'APPROVED' ? 'success' : s === 'REJECTED' ? 'danger' : s === 'SUBMITTED' ? 'warning' : 'info');
const fmtTime = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-');
const shortTime = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '-');
const paramsText = (p: Record<string, any>) => (p && Object.keys(p).length ? Object.entries(p).map(([k, v]) => `${k}:${v}`).join('，') : '-');

async function loadSummary() {
  try {
    const s: any = await apiQualitySummary();
    summary.value = { records: s.records || summary.value.records };
  } catch { /* */ }
}

async function load() {
  loading.value = true;
  try {
    const res: any = await apiListRecords({ ...query });
    rows.value = res.items || [];
    total.value = res.total || 0;
  } catch { /* */ } finally { loading.value = false; }
}

async function openDoc(id: number) {
  try {
    doc.value = await apiGetRecord(id);
    approveOpinion.value = '';
    resetStepForm();
    docDrawer.value = true;
  } catch { /* */ }
}

function resetStepForm() {
  Object.assign(stepForm, { stepName: '', equipment: '', operator: '', startedAt: null, endedAt: null, result: 'PASS', paramsText: '', remark: '' });
}

function parseParams(text: string): Record<string, any> {
  const t = String(text || '').trim();
  if (!t) return {};
  try {
    const j = JSON.parse(t);
    return typeof j === 'object' && j ? j : { value: j };
  } catch {
    const out: Record<string, any> = {};
    t.split(/[,，]/).forEach((kv) => {
      const parts = kv.split(/[:：]/);
      if (parts.length >= 2) out[parts[0].trim()] = parts.slice(1).join(':').trim();
    });
    return out;
  }
}

async function addStep() {
  if (!stepForm.stepName.trim()) { ElMessage.warning('工序名称必填'); return; }
  if (!stepForm.operator.trim()) { ElMessage.warning('操作人必填（批记录要能追到人）'); return; }
  stepLoading.value = true;
  try {
    doc.value = await apiAddStep(doc.value.id, {
      stepName: stepForm.stepName, equipment: stepForm.equipment, operator: stepForm.operator,
      startedAt: stepForm.startedAt, endedAt: stepForm.endedAt, result: stepForm.result,
      params: parseParams(stepForm.paramsText), remark: stepForm.remark,
    });
    resetStepForm();
    ElMessage.success('已添加工序');
    await load();
  } catch { /* */ } finally { stepLoading.value = false; }
}

async function removeStep(row: any) {
  try {
    await ElMessageBox.confirm(`删除第 ${row.seq} 道工序「${row.stepName}」？`, '删除工序', { type: 'warning' });
    doc.value = await apiDeleteStep(doc.value.id, row.id);
    await load();
  } catch { /* */ }
}

async function doSubmit() {
  try {
    const r: any = await apiSubmitRecord(doc.value.id);
    doc.value = { ...doc.value, ...r };
    ElMessage.success(r.warnings?.length ? `已提交（提醒：${r.warnings.join('；')}）` : '已提交，等待质量批准');
    await Promise.all([load(), loadSummary()]);
  } catch { /* */ }
}

async function doApprove(decision: 'APPROVE' | 'REJECT') {
  if (decision === 'REJECT' && !approveOpinion.value.trim()) { ElMessage.warning('退回必须写明原因'); return; }
  approving.value = true;
  try {
    doc.value = await apiApproveRecord(doc.value.id, { decision, opinion: approveOpinion.value });
    ElMessage.success(decision === 'APPROVE' ? '已批准' : '已退回');
    await Promise.all([load(), loadSummary()]);
  } catch { /* */ } finally { approving.value = false; }
}

function openCreate() {
  Object.assign(form, { workOrderId: null, skuCode: '', batchNo: '', qtyPlanned: 0, remark: '' });
  createDialog.value = true;
}

async function doCreate() {
  creating.value = true;
  try {
    const d: any = await apiCreateRecord({ ...form });
    createDialog.value = false;
    ElMessage.success(`已开单 ${d.recordNo}`);
    await Promise.all([load(), loadSummary()]);
    openDoc(d.id);
  } catch { /* */ } finally { creating.value = false; }
}

onMounted(async () => {
  await Promise.all([load(), loadSummary()]);
  try {
    materials.value = (await apiInventoryMaterials()) || [];
    const res: any = await apiWmsWorkOrders({ pageSize: 50 });
    workOrders.value = res.items || [];
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
.card.warn .n { color: #b45309; }
.sec-title { font-size: 13px; font-weight: 700; margin: 16px 0 8px; }
.evidence { margin-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; }
.muted { color: #94a3b8; }
.fail { color: #b91c1c; }
.block { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 6px; padding: 8px 12px; font-size: 12.5px; margin-bottom: 10px; }
</style>
