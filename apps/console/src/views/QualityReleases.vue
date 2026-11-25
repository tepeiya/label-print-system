<template>
  <div class="page">
    <div class="page-head">
      <h2>成品放行</h2>
      <div class="head-actions">
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" @click="openCreate">提交放行申请</el-button>
      </div>
    </div>

    <div class="hint" style="margin-bottom: 12px">
      GMP 口径：<b>未经放行不得上市销售</b>。成品入库批次先进「待放行」，QA 审完批记录与检验报告后在这里签批才能发货。
      签批必须再输一次<b>当前账号密码</b>——电子签要证明是本人意愿，不能被代签。
    </div>

    <el-row :gutter="10" class="cards">
      <el-col :span="8">
        <div class="card warn"><div class="n">{{ summary.releases.pending }}</div><div class="l">待签批（压库不能发）</div></div>
      </el-col>
      <el-col :span="8">
        <div class="card"><div class="n">{{ summary.releases.released }}</div><div class="l">已放行</div></div>
      </el-col>
      <el-col :span="8">
        <div class="card danger"><div class="n">{{ summary.releases.rejected }}</div><div class="l">已驳回</div></div>
      </el-col>
    </el-row>
    <div v-if="summary.releases.stalePending" class="stale">
      有 {{ summary.releases.stalePending }} 张放行单提交超过 3 天仍未签批，成品一直压在库里发不出去。
    </div>

    <div class="filters" style="margin-top: 12px">
      <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 140px" @change="load">
        <el-option label="待签批" value="PENDING" />
        <el-option label="已放行" value="RELEASED" />
        <el-option label="已驳回" value="REJECTED" />
        <el-option label="已作废" value="CANCELLED" />
      </el-select>
      <el-input v-model="query.keyword" placeholder="单号 / 批次 / 物料" clearable style="width: 200px" @keyup.enter="load" />
      <el-button type="primary" @click="load">查询</el-button>
    </div>

    <el-table :data="rows" size="small" border v-loading="loading" empty-text="还没有放行单">
      <el-table-column prop="releaseNo" label="单号" width="160" />
      <el-table-column label="物料" min-width="170" show-overflow-tooltip>
        <template #default="{ row }">{{ row.skuCode }} · {{ row.materialName }}</template>
      </el-table-column>
      <el-table-column prop="batchNo" label="批次" width="130" />
      <el-table-column prop="warehouse" label="仓库" width="130" show-overflow-tooltip />
      <el-table-column prop="qty" label="数量" width="90" />
      <el-table-column label="状态" width="96">
        <template #default="{ row }">
          <el-tag size="small" :type="relTag(row.status)">{{ row.statusText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="提交 / 签批" width="150">
        <template #default="{ row }">
          {{ row.submitter || '-' }}<br />
          <span class="muted">{{ row.reviewer ? `签：${row.reviewer}` : '未签' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="86">
        <template #default="{ row }">
          <el-button link size="small" type="primary" @click="openDoc(row.id)">{{ row.status === 'PENDING' ? '签批' : '详情' }}</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination v-model:current-page="query.page" :page-size="query.pageSize" :total="total"
                   layout="total, prev, pager, next" style="margin-top: 10px" @current-change="load" />

    <!-- ==================== 详情 / 签批 ==================== -->
    <el-drawer v-model="docDrawer" :title="doc?.releaseNo || '放行单'" size="640px">
      <div v-if="doc">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="relTag(doc.status)">{{ doc.statusText }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="物料要求检验">{{ doc.qcRequired ? '是' : '否' }}</el-descriptions-item>
          <el-descriptions-item label="物料">{{ doc.skuCode }} · {{ doc.materialName }}</el-descriptions-item>
          <el-descriptions-item label="仓库">{{ doc.warehouse }}</el-descriptions-item>
          <el-descriptions-item label="批次">{{ doc.batchNo }}</el-descriptions-item>
          <el-descriptions-item label="批次库存">{{ doc.batchQty }} {{ doc.unit }}</el-descriptions-item>
          <el-descriptions-item label="批次质量状态">{{ qcText(doc.batchQualityStatus) }}</el-descriptions-item>
          <el-descriptions-item label="检验单">
            {{ doc.inspectionNo || '未关联' }} {{ doc.inspectionStatus ? `（${doc.inspectionStatus}）` : '' }}
          </el-descriptions-item>
          <el-descriptions-item label="申请人">{{ doc.submitter || '-' }}</el-descriptions-item>
          <el-descriptions-item label="申请时间">{{ doc.submittedAt ? fmtTime(doc.submittedAt) : '-' }}</el-descriptions-item>
          <el-descriptions-item label="签批人">{{ doc.reviewer || '-' }}</el-descriptions-item>
          <el-descriptions-item label="签批时间">{{ doc.reviewedAt ? fmtTime(doc.reviewedAt) : '-' }}</el-descriptions-item>
          <el-descriptions-item label="签批意见" :span="2">{{ doc.opinion || '-' }}</el-descriptions-item>
        </el-descriptions>

        <div v-if="doc.status === 'PENDING'" style="margin-top: 16px">
          <div class="sec-title">QA 签批</div>
          <div v-if="!doc.canSign" class="block">
            当前不能签批：{{ doc.signBlockReason }}
          </div>
          <el-form label-width="80px" size="small">
            <el-form-item label="签批意见">
              <el-input v-model="signForm.opinion" type="textarea" :rows="2" placeholder="同意放行 / 驳回原因" />
            </el-form-item>
            <el-form-item label="登录密码">
              <el-input v-model="signForm.password" type="password" show-password autocomplete="off"
                        placeholder="再输一次当前账号密码（电子签验证本人）" style="width: 280px" />
            </el-form-item>
          </el-form>
          <div>
            <el-button type="success" :loading="signLoading" :disabled="!doc.canSign"
                       @click="doSign('APPROVE')">签批放行</el-button>
            <el-button type="danger" :loading="signLoading" :disabled="!doc.canSign"
                       @click="doSign('REJECT')">驳回（批次隔离）</el-button>
            <el-button plain @click="doCancel">作废申请</el-button>
          </div>
        </div>
      </div>
    </el-drawer>

    <!-- ==================== 提交申请 ==================== -->
    <el-dialog v-model="createDialog" title="提交成品放行申请" width="560px" append-to-body>
      <el-form :model="form" label-width="96px" size="small">
        <el-form-item label="物料">
          <el-select v-model="form.skuCode" filterable style="width: 100%" placeholder="选择成品物料">
            <el-option v-for="m in materials" :key="m.code" :label="`${m.code} · ${m.name}`" :value="m.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="仓库">
          <el-select v-model="form.warehouseId" style="width: 100%">
            <el-option v-for="w in warehouses" :key="w.id" :label="`${w.code} · ${w.name}`" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="批次号">
          <el-input v-model="form.batchNo" placeholder="待放行的成品批次" />
        </el-form-item>
        <el-form-item label="申请数量">
          <el-input-number v-model="form.qty" :min="0" style="width: 100%" />
        </el-form-item>
        <el-form-item label="申请人">
          <el-input v-model="form.submitter" placeholder="生产/质量提交人" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="如：批记录编号、灭菌批次号" />
        </el-form-item>
      </el-form>
      <div class="hint">系统会自动挂上该批次最近一张结论为 PASS 的检验单；没有 PASS 检验单时，要求检验的物料签批会被拦下。</div>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="doCreate">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiInventoryMaterials, apiInventoryWarehouses } from '@/api';
import {
  apiCancelRelease, apiGetRelease, apiListReleases, apiQualitySummary, apiSignRelease, apiSubmitRelease,
} from '@/api/quality';

const loading = ref(false);
const rows = ref<any[]>([]);
const total = ref(0);
const query = reactive({ status: '', keyword: '', page: 1, pageSize: 20 });
const summary = ref<any>({ releases: { pending: 0, released: 0, rejected: 0, stalePending: 0 } });

const docDrawer = ref(false);
const doc = ref<any>(null);
const signForm = reactive({ opinion: '', password: '' });
const signLoading = ref(false);

const createDialog = ref(false);
const creating = ref(false);
const materials = ref<any[]>([]);
const warehouses = ref<any[]>([]);
const form = reactive<any>({ skuCode: '', warehouseId: null, batchNo: '', qty: 0, submitter: '', remark: '' });

const relTag = (s: string) => (s === 'RELEASED' ? 'success' : s === 'REJECTED' ? 'danger' : s === 'CANCELLED' ? 'info' : 'warning');
const qcText = (s: string | null) =>
  ({ PENDING: '待放行/待检', RELEASED: '合格（已放行）', REJECTED: '不合格', FROZEN: '冻结' } as Record<string, string>)[String(s)] || '-';
const fmtTime = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-');

async function loadSummary() {
  try {
    const s: any = await apiQualitySummary();
    summary.value = { releases: s.releases || summary.value.releases };
  } catch { /* */ }
}

async function load() {
  loading.value = true;
  try {
    const res: any = await apiListReleases({ ...query });
    rows.value = res.items || [];
    total.value = res.total || 0;
  } catch { /* */ } finally { loading.value = false; }
}

async function openDoc(id: number) {
  try {
    doc.value = await apiGetRelease(id);
    signForm.password = '';
    signForm.opinion = '';
    docDrawer.value = true;
  } catch { /* */ }
}

async function doSign(decision: 'APPROVE' | 'REJECT') {
  if (!signForm.password) { ElMessage.warning('签批必须输入当前账号密码'); return; }
  try {
    if (decision === 'REJECT' && !signForm.opinion.trim()) { ElMessage.warning('驳回必须写原因'); return; }
    await ElMessageBox.confirm(
      decision === 'APPROVE' ? '确认签批放行？批次将转为合格，可以发货。' : '确认驳回？批次将被隔离，不能发货。',
      decision === 'APPROVE' ? '签批放行' : '驳回',
      { type: 'warning' },
    );
    signLoading.value = true;
    doc.value = await apiSignRelease(doc.value.id, {
      decision, password: signForm.password, opinion: signForm.opinion,
    });
    ElMessage.success(decision === 'APPROVE' ? '已放行，批次可发货' : '已驳回并隔离');
    await Promise.all([load(), loadSummary()]);
  } catch (e: any) {
    if (e !== 'cancel') { /* 拦截器已提示（密码错会收到 401 文案） */ }
  } finally { signLoading.value = false; }
}

async function doCancel() {
  try {
    const { value } = await ElMessageBox.prompt('作废原因（必填）', '作废放行申请', { inputPlaceholder: '如：批次已退货' });
    doc.value = await apiCancelRelease(doc.value.id, value || '');
    ElMessage.success('已作废');
    await Promise.all([load(), loadSummary()]);
  } catch { /* */ }
}

function openCreate() {
  Object.assign(form, { skuCode: '', warehouseId: warehouses.value[0]?.id ?? null, batchNo: '', qty: 0, submitter: '', remark: '' });
  createDialog.value = true;
}

async function doCreate() {
  creating.value = true;
  try {
    const d: any = await apiSubmitRelease({ ...form });
    createDialog.value = false;
    ElMessage.success(`已提交 ${d.releaseNo}，等待 QA 签批`);
    await Promise.all([load(), loadSummary()]);
    openDoc(d.id);
  } catch { /* */ } finally { creating.value = false; }
}

onMounted(async () => {
  await Promise.all([load(), loadSummary()]);
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
.stale { margin-top: 10px; background: #fffbeb; border: 1px solid #fde68a; color: #92400e; border-radius: 6px; padding: 8px 12px; font-size: 12.5px; }
.sec-title { font-size: 13px; font-weight: 700; margin: 16px 0 8px; }
.block { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 6px; padding: 8px 12px; font-size: 12.5px; margin-bottom: 10px; }
.muted { color: #94a3b8; }
</style>
